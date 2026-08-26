// The retrieval engine: query features, query-dependent lane weighting,
// the hybrid FTS/vector/trigram SQL, RRF fusion, metadata filters, and the
// rerank hook. DESIGN.md sections 3.6 and 6.
//
// Deviations from DESIGN.md, and why (also in the assignment summary):
//
// 1. Section 6.1's SQL sketch casts pre-built tsquery params directly
//    (`$2::tsquery as andq`). Casting a text parameter straight to
//    ::tsquery uses tsquery's OWN input syntax, which treats each word as
//    an already-normalized lexeme and never runs it through the 'english'
//    dictionary's stemmer. That would silently break matching against the
//    document tsvector's stemmed lexemes unless the caller pre-stemmed
//    every word with Postgres's exact snowball algorithm -- infeasible
//    without a DB round trip inside parseQueryFeatures, which must stay
//    synchronous. Instead, andq/orq are computed with
//    websearch_to_tsquery('english', $1) / to_tsquery('english', $2)
//    INSIDE the `q` CTE, each evaluated once per statement execution. Same
//    one-round-trip shape, correct stemming, no extra dependency.
// 2. The OR lane's "fragment bar" is not a pairwise AND expansion; it
//    mirrors scripts/recall.mjs exactly, per section 6.2's explicit
//    instruction ("gated by the same fragment bar scripts/recall.mjs
//    uses"): a plain disjunction of quoted lexemes for the match, plus a
//    scalar subquery counting how many of the query's own terms the row
//    actually matches, gated at >= min(2, termCount).
// 3. Synthetic-vector tiers (rehearsal1m, full10m) have no `people`,
//    `title`, `dup_group`, or `rare_token` columns (DESIGN.md 3.5). Those
//    rerank-feature columns are selected as null/'{}' literals there, and
//    the people metadata filter is not emitted for that tier at all --
//    Vocab has no documented person_id mapping (lib/lexicon.mjs has not
//    landed), so there is nothing correct to filter on. Date filtering is
//    unaffected: both tier kinds carry occurred_at.
// 4. occurred_at is `timestamptz` on the real-vector tiers and `date` on
//    the synthetic tiers (section 3.5), so the range parameter is bound as
//    tstzrange vs daterange per tier -- the sketch's single `::daterange`
//    does not typecheck against a timestamptz column.
//
// Vocab shape (owned by schemas.mjs once Track 0/2 lands; assumed here
// since neither file exists yet):
//   {
//     totalDocs: number,
//     df: Map<string, number> | Record<string, number>,       // stem -> doc frequency
//     people: Map<string, string[]> | Record<string, string[]>, // slug -> lowercase aliases
//     places: Map<string, string[]> | Record<string, string[]>,
//   }
// Both Map and plain-object forms are accepted for df/people/places since
// a JSON-serialized vocab (the likely form load.mjs writes) cannot carry a
// Map. `stem`/`tokenize` below are exported (additive to section 3.6's
// list) so whatever module builds Vocab.df can key it with the exact same
// function this file uses to look words up -- that consistency matters
// more than matching Postgres's real snowball stemmer, since SQL-side
// matching never depends on this stemmer at all (see deviation 1).

import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { config as defaultConfig } from "./config.mjs";
import { shouldIssueSessionSql } from "./lib/safety.mjs";

// ---------------------------------------------------------------------------
// Tokenizer + approximate stemmer (feature scoring only -- never touches SQL)
// ---------------------------------------------------------------------------

// Postgres's default 'english' stopword list, trimmed to the common core.
// Approximate on purpose: this only gates what counts toward idf/oov
// scoring and the OR-lane fragment terms, not what Postgres itself matches.
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an",
  "and", "any", "are", "aren't", "as", "at", "be", "because", "been",
  "before", "being", "below", "between", "both", "but", "by", "can", "did",
  "do", "does", "doing", "don't", "down", "during", "each", "few", "for",
  "from", "further", "had", "has", "have", "having", "he", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "itself", "just", "me", "more", "most", "my",
  "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "s",
  "same", "she", "should", "so", "some", "such", "t", "than", "that",
  "the", "their", "theirs", "them", "themselves", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "won't", "would", "you", "your",
  "yours", "yourself", "yourselves",
]);

// Words with internal hyphens/apostrophes stay one token (planted rare
// tokens look like "kbz-4417"; splitting on "-" would hide them).
const TOKEN_RE = /[a-z0-9]+(?:[-'][a-z0-9]+)*/g;
const QUOTED_RE = /"([^"]+)"/g;

export function tokenize(text) {
  const quoted = [];
  const withoutQuotes = String(text ?? "").replace(QUOTED_RE, (_, inner) => {
    quoted.push(inner.trim().toLowerCase());
    return ` ${inner} `;
  });
  const terms = withoutQuotes.toLowerCase().match(TOKEN_RE) ?? [];
  return { terms, quoted };
}

// Suffix-stripping approximation of Porter stemming. Not a faithful Porter
// implementation -- deliberately conservative (skips -er/-est comparative
// stripping, which misfires badly on ordinary nouns like "father") since
// this only feeds idf/rareness scoring, never SQL matching (deviation 1).
export function stem(word) {
  let w = String(word ?? "").toLowerCase();
  if (w.length < 4) return w;
  w = w.replace(/'s$/, "");
  if (w.endsWith("ies") && w.length > 5) w = `${w.slice(0, -3)}y`;
  else if (/[^s]s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = collapseDoubled(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed")) w = collapseDoubled(w.slice(0, -2));
  if (w.endsWith("iness") && w.length > 6) w = `${w.slice(0, -5)}y`;
  else if (w.endsWith("ness") && w.length > 5) w = w.slice(0, -4);
  else if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  return w;
}

function collapseDoubled(w) {
  // "stopp" (from "stopped") -> "stop"; leaves legitimate double letters
  // like "ll"/"ss"/"zz" alone since those are rarely stemming artifacts.
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) return w.slice(0, -1);
  return w;
}

function dfLookup(vocab, key) {
  const df = vocab?.df;
  if (!df) return undefined;
  if (df instanceof Map) return df.get(key);
  return Object.prototype.hasOwnProperty.call(df, key) ? df[key] : undefined;
}

function entriesOf(mapOrObj) {
  if (!mapOrObj) return [];
  if (mapOrObj instanceof Map) return [...mapOrObj.entries()];
  return Object.entries(mapOrObj);
}

const EMPTY_VOCAB = { totalDocs: 1, df: new Map(), people: new Map(), places: new Map() };

// ---------------------------------------------------------------------------
// Closed-world date parser (section 3.6: "must stay that way" -- no general
// NL date parsing, only the finite template list below).
// ---------------------------------------------------------------------------

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const SEASON_MONTHS = {
  spring: [3, 4, 5], summer: [6, 7, 8], fall: [9, 10, 11],
  autumn: [9, 10, 11], winter: [12, 1, 2],
};
const MONTH_ALT = MONTHS.join("|");
const SEASON_ALT = Object.keys(SEASON_MONTHS).join("|");

const DATE_PATTERNS = [
  { kind: "in-month-year", re: new RegExp(`\\bin\\s+(${MONTH_ALT})\\s+(\\d{4})\\b`, "i") },
  { kind: "that-season-of-year", re: new RegExp(`\\bthat\\s+(${SEASON_ALT})\\s+of\\s+(\\d{4})\\b`, "i") },
  { kind: "before-year", re: /\bbefore\s+(\d{4})\b/i },
  { kind: "after-year", re: /\bafter\s+(\d{4})\b/i },
  { kind: "in-year", re: /\bin\s+(\d{4})\b/i },
  { kind: "last-month", re: new RegExp(`\\blast\\s+(${MONTH_ALT})\\b`, "i") },
  { kind: "around-month", re: new RegExp(`\\baround\\s+(${MONTH_ALT})\\b`, "i") },
  { kind: "bare-month", re: new RegExp(`\\b(${MONTH_ALT})\\b`, "i") },
];

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthRange(year, month1to12) {
  return { from: isoDate(Date.UTC(year, month1to12 - 1, 1)), to: isoDate(Date.UTC(year, month1to12, 1)) };
}

function yearRange(year) {
  return { from: isoDate(Date.UTC(year, 0, 1)), to: isoDate(Date.UTC(year + 1, 0, 1)) };
}

function seasonRange(season, year) {
  const months = SEASON_MONTHS[season];
  if (season === "winter") {
    return { from: isoDate(Date.UTC(year, 11, 1)), to: isoDate(Date.UTC(year + 1, 2, 1)) };
  }
  const first = months[0];
  const last = months[months.length - 1];
  return { from: isoDate(Date.UTC(year, first - 1, 1)), to: isoDate(Date.UTC(year, last, 1)) };
}

// "last <Month>" / "around <Month>" / bare month names have no year in the
// text at all, so a closed-world parser has to resolve one against some
// reference point. cfg.dates.referenceIso pins it to lib/lexicon.mjs's own
// REFERENCE_NOW (2026-01-01, fixed rather than wall-clock, precisely so
// this resolves the same way regardless of when the bench actually runs).
// Falls back to real wall-clock time only if cfg carries no referenceIso at
// all, which should not happen once config.mjs's own default is in play.
function referenceDate(cfg) {
  const iso = cfg?.dates?.referenceIso;
  return iso ? new Date(iso) : new Date();
}

// Matches lib/lexicon.mjs's buildDateTemplate exactly (that file landed
// mid-implementation and is the actual generator, so its rule beats the
// earlier guess this replaced): a month with no year in the text
// ("last <Month>", bare month names) rolls back a year whenever the target
// month's index is >= the reference month's index -- note >=, not >, so at
// REFERENCE_NOW's own month the year still rolls back. With REFERENCE_NOW
// pinned at 2026-01-01 (January, the smallest possible index), this rolls
// every month back to 2025 -- a real edge case of the boundary rule, not a
// bug in either implementation.
function lastOccurrenceYear(month1to12, reference) {
  const refYear = reference.getUTCFullYear();
  const refMonth = reference.getUTCMonth() + 1;
  return month1to12 >= refMonth ? refYear - 1 : refYear;
}

// Same width lib/lexicon.mjs's aroundMonth uses: the named month plus the
// one immediately before and after -- a fixed 3-calendar-month window, not
// a day-count pad.
function aroundMonthRange(year, month1to12) {
  return { from: isoDate(Date.UTC(year, month1to12 - 2, 1)), to: isoDate(Date.UTC(year, month1to12 + 1, 1)) };
}

function parseDateRange(lowerText, cfg) {
  for (const { kind, re } of DATE_PATTERNS) {
    const m = lowerText.match(re);
    if (!m) continue;
    const reference = referenceDate(cfg);
    switch (kind) {
      case "in-month-year":
        return monthRange(Number(m[2]), MONTHS.indexOf(m[1].toLowerCase()) + 1);
      case "that-season-of-year":
        return seasonRange(m[1].toLowerCase(), Number(m[2]));
      case "before-year":
        return { from: null, to: yearRange(Number(m[1])).from };
      case "after-year":
        return { from: yearRange(Number(m[1]) + 1).from, to: null };
      case "in-year":
        return yearRange(Number(m[1]));
      case "last-month": {
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        return monthRange(lastOccurrenceYear(month, reference), month);
      }
      case "around-month": {
        // The query text carries no year at all ("around march"), and
        // lib/lexicon.mjs's generator picks one per-query when building
        // the fixture (matched against a specific target's occurred_at)
        // that never reaches the text. A closed-world parser reading only
        // the text cannot recover that year; this is the same
        // lastOccurrenceYear best guess as bareMonth/lastMonth, and a wrong
        // guess here is an accepted, already-named cost (DESIGN.md 5.2's
        // filter_excluded bucket), not something this parser can close.
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        return aroundMonthRange(lastOccurrenceYear(month, reference), month);
      }
      case "bare-month": {
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        return monthRange(lastOccurrenceYear(month, reference), month);
      }
      default:
        return { from: null, to: null };
    }
  }
  return { from: null, to: null };
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEntities(lowerText, vocab) {
  const people = extractOneKind(lowerText, vocab?.people, vocab, vocab?.peopleDocs);
  const places = extractOneKind(lowerText, vocab?.places, vocab, null);
  return {
    people: people.map((h) => h.slug),
    places: places.map((h) => h.slug),
    // Mentions confident enough to drive a HARD metadata filter. See
    // extractOneKind for what makes one ambiguous.
    peopleConfident: people.filter((h) => !h.ambiguous).map((h) => h.slug),
  };
}

// An alias that is also ordinary English costs more than it earns. This corpus
// names people with Vietnamese given names, several of which are also common
// words: "an" is the indefinite article, and "van" is a vehicle. Measured on
// the dev split, those two alone produced 37 of the 98 person extractions and
// 33 queries whose inferred people filter excluded their own ground-truth
// target -- DESIGN.md 5.2's "most dangerous bucket".
//
// Two guards, because the two words fail differently:
//   - A stopword alias carries no entity evidence at all, so "an" is dropped
//     outright. No retrieval system should filter on the article "an".
//   - A non-stopword alias is ambiguous when it appears in materially more
//     documents than actually carry the person tag. Measured over this corpus,
//     every genuine name has df exactly equal to its tagged-document count,
//     while "van" sits at 2.3x. Ambiguous mentions still feed the entity
//     rerank feature and the AND-lane boost, which only reorder; they are kept
//     out of the hard filter and out of looksParaphrase, which delete.
const AMBIGUOUS_ALIAS_DF_RATIO = 1.25;

function extractOneKind(lowerText, mapOrObj, vocab, docCounts) {
  const hits = []; // { slug, index, ambiguous }
  for (const [slug, aliasesRaw] of entriesOf(mapOrObj)) {
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [aliasesRaw];
    let earliest = -1;
    let ambiguous = false;
    for (const alias of aliases) {
      const needle = String(alias ?? "").toLowerCase().trim();
      if (!needle || STOPWORDS.has(needle)) continue;
      const re = new RegExp(`\\b${escapeRe(needle)}\\b`);
      const idx = lowerText.search(re);
      if (idx < 0) continue;
      if (earliest === -1 || idx < earliest) earliest = idx;
      const tagged = docCounts instanceof Map ? docCounts.get(slug) : docCounts?.[slug];
      const df = dfLookup(vocab, stem(needle));
      if (tagged > 0 && df !== undefined && df > tagged * AMBIGUOUS_ALIAS_DF_RATIO) ambiguous = true;
    }
    if (earliest >= 0) hits.push({ slug, index: earliest, ambiguous });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

// ---------------------------------------------------------------------------
// parseQueryFeatures
// ---------------------------------------------------------------------------

export function parseQueryFeatures(text, vocab, cfg = defaultConfig) {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();
  const v = vocab ?? EMPTY_VOCAB;
  const w = cfg.weighting;

  const { terms, quoted } = tokenize(raw);
  // Pure-digit tokens (years, mostly) are handled by the dedicated date
  // parser below and excluded here: no word vocabulary tracks bare numbers,
  // so a literal "2024" is always OOV and was silently forcing every
  // date_filter query to look typoSuspect regardless of its actual words.
  const contentTerms = terms.filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
  // Key df lookups with the SAME stemmer that built the index. This file's own
  // stem() is a near-copy, but the two disagree on doubled consonants
  // ("scrubbed" -> scrub here, scrubb there), and every disagreement reads as
  // an out-of-vocabulary term that never happened -- which inflates oovRatio
  // and suppresses maxIdf, the two features every weighting rule keys on.
  const stemFor = typeof v.stem === "function" ? v.stem : stem;
  const stems = contentTerms.map(stemFor);

  let idfSum = 0;
  let idfCount = 0;
  let maxIdf = 0;
  let oovCount = 0;
  const rareSet = new Set();
  const N = Math.max(1, v.totalDocs ?? 1);
  for (const s of stems) {
    const df = dfLookup(v, s);
    if (df === undefined || df <= 0) {
      oovCount += 1;
      continue;
    }
    const idf = Math.log(N / df);
    idfSum += idf;
    idfCount += 1;
    if (idf > maxIdf) maxIdf = idf;
    if (idf >= w.rareIdfFloor) rareSet.add(s);
  }
  const meanIdf = idfCount > 0 ? idfSum / idfCount : 0;
  const oovRatio = stems.length > 0 ? oovCount / stems.length : 0;

  const entities = extractEntities(lower, v);
  const dateRange = parseDateRange(lower, cfg);

  // Confident mentions only: "our hired van showed up late" is a paraphrase
  // query, and letting the vehicle disqualify it costs the whole vector
  // up-weighting this family depends on.
  const looksParaphrase =
    terms.length >= w.paraphrase.minTerms &&
    oovRatio >= w.paraphrase.oovFloor &&
    entities.peopleConfident.length === 0 &&
    entities.places.length === 0;
  // Length is what separates a mistyped query from a reworded one; both are
  // out-of-vocabulary, and only the short one wants the trigram lane.
  const typoSuspect = oovRatio >= w.oovRatioFloor && terms.length <= w.typoMaxTerms;

  return {
    raw,
    terms,
    stems,
    maxIdf,
    meanIdf,
    rareTerms: [...rareSet],
    oovRatio,
    entities,
    dateRange,
    quoted,
    looksParaphrase,
    typoSuspect,
  };
}

// ---------------------------------------------------------------------------
// laneWeights (section 6.3)
// ---------------------------------------------------------------------------

const LANES = ["and", "or", "vector", "trigram"];

export function laneWeights(features, profile, cfg = defaultConfig) {
  if (profile.weighting === "fixed") {
    const weights = profile.weights ?? {};
    const out = {};
    for (const lane of LANES) out[lane] = weights[lane] ?? 0;
    return out;
  }
  if (profile.weighting !== "query-dependent") {
    throw new Error(`laneWeights: unknown weighting mode "${profile.weighting}"`);
  }
  const w = cfg.weighting;
  const out = { ...w.base };
  const addAll = (delta) => {
    for (const [lane, amount] of Object.entries(delta ?? {})) out[lane] = (out[lane] ?? 0) + amount;
  };
  // Section 6.3's rules, applied additively; clamp once at the end so a
  // query matching several rules (rare-term AND paraphrase, say) still
  // lands where the sum of deltas says before any single rule saturates it.
  if (features.maxIdf >= w.rareIdfFloor) addAll(w.rareTermBoost);
  if (features.looksParaphrase) addAll(w.paraphraseBoost);
  if (features.typoSuspect) addAll(w.typoBoost);
  if (features.entities.people.length > 0) addAll(w.entityBoost);
  if (features.dateRange.from || features.dateRange.to) addAll(w.dateBoost);
  for (const lane of LANES) out[lane] = Math.min(3, Math.max(0, out[lane] ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// SQL construction (section 6.1)
// ---------------------------------------------------------------------------

function tierKind(tier) {
  return tier.vector === "synthetic" ? "synthetic" : "real";
}

function profileSignature(profile) {
  const lanes = [...profile.lanes].slice().sort().join("");
  // vectorGate is part of the signature because it changes the SQL text, and
  // two different statements sharing one prepared-statement name is a silent
  // wrong-plan bug rather than a slow one.
  return `${lanes}_w${profile.weighting}_f${profile.filters ? 1 : 0}_r${profile.rerank ? 1 : 0}${profile.vectorGate ? "_vg" : ""}`;
}

// Postgres identifiers truncate at NAMEDATALEN - 1 = 63 bytes, silently, which
// turns a name long enough to be cut into exactly the collision profileSignature
// above exists to prevent. Measured 2026-08-25: a scratch schema named
// bench_bs_bulkspill1m put the gated and ungated variants of one profile on the
// same truncated name and the window produced 2,655 "You supplied ... (67)"
// errors. Past the limit the tail becomes a hash of the whole name, so two
// statements that differ anywhere still differ here; under it the name is
// untouched, so every measurement taken under the existing names still lines up.
const PG_IDENTIFIER_LIMIT = 63;

function statementName(tier, profile) {
  const full = `retrieve_${tier.schema}_${profileSignature(profile)}`;
  if (Buffer.byteLength(full, 'utf8') <= PG_IDENTIFIER_LIMIT) return full;
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 12);
  return `${full.slice(0, PG_IDENTIFIER_LIMIT - digest.length - 1)}_${digest}`;
}

function laneDepthCfg(tier, cfg) {
  return tierKind(tier) === "real" ? cfg.lanes.quality : cfg.lanes.scale;
}

// Builds the SQL text and the ordered list of bind-parameter slots. Shared
// by buildRetrievalSql (public contract) and retrieve (which needs the
// same slot order to bind values) so the two can never drift apart.
// ---------------------------------------------------------------------------
// Scale-path lexical planning (DESIGN.md 6.6)
//
// Everything below applies to the synthetic-vector tiers only. The quality
// tier keeps planStatement's original shape untouched, because rung 2's
// numbers are being calibrated against it and a "neutral" change to its SQL
// would have to be proved, not asserted.
// ---------------------------------------------------------------------------

// A lexeme no 'english' tsvector can hold (the parser never emits a lexeme
// containing '~'), so a lane whose term list came out empty matches nothing
// instead of matching everything. NULL would be worse than useless here: a
// NULL tsquery makes the GIN index unusable and the planner falls back to a
// sequential scan that recomputes to_tsvector for all 1M rows.
const NO_MATCH_FRAG = "'zzz~nomatch~zzz'";

function termLookup(terms, word) {
  if (!terms) return undefined;
  if (terms instanceof Map) return terms.get(word);
  return Object.prototype.hasOwnProperty.call(terms, word) ? terms[word] : undefined;
}

// Turns a parsed query into the bind values the scale statement needs.
//
// The OR lane's term list is the whole point. Ranking every row that shares
// ANY query word is what made the 1M rehearsal unservable: a three-common-term
// disjunction matches 862,972 of 1M rows (measured), and no amount of ranking
// speed rescues that. So the disjunction is rebuilt from the rarest terms
// only, added rarest-first while their cumulative document frequency stays
// inside `orAnchorDfBudget`. That bounds the lane's match count by the
// frequency of the terms in it rather than by truncating a huge result, which
// is the standard WAND-style move: the terms that were dropped are exactly the
// ones that carry no discrimination.
//
// The single rarest term is always kept even when its own df blows the budget,
// so a query made entirely of common words still has an OR lane; the row cap
// in the SQL is what bounds that case, and it is honestly a truncation.
export function scaleQueryParams(qf, vocab, cfg = defaultConfig) {
  const scale = cfg.lanes.scale;
  const terms = vocab?.terms;
  const seen = new Set();
  const inVocab = [];
  const oov = [];

  for (const t of qf.terms) {
    if (STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    const entry = termLookup(terms, t);
    if (entry && entry.frag) inVocab.push({ term: t, ...entry });
    else oov.push(t);
  }

  // Rarest first; ties broken by the term itself so the same query always
  // produces the same statement parameters.
  const byRarity = [...inVocab].sort((a, b) => a.ndoc - b.ndoc || (a.term < b.term ? -1 : 1));
  const anchors = [];
  let anchorDf = 0;
  for (const entry of byRarity) {
    if (anchors.length >= scale.orAnchorMaxTerms) break;
    if (anchors.length > 0 && anchorDf + entry.ndoc > scale.orAnchorDfBudget) break;
    anchors.push(entry);
    anchorDf += entry.ndoc;
  }

  // The lane only runs when its anchor is genuinely selective, and this is the
  // honest half of the design. When even the rarest term in the query appears
  // in more documents than the candidate cap -- measured on this corpus, the
  // cross-topic nouns entity_swap and typo_noisy queries are built from sit at
  // df ~24,000 of 1M -- the lane cannot return a ranked top-30 of the matches.
  // It can only return whichever 400 rows the heap scan reached first, which
  // gives a roughly 1.7% chance of touching the target while costing 4.4 ms of
  // to_tsvector recompute (measured). Running it would be paying real time for
  // noise, so the lane stands down and the AND and vector lanes carry the
  // query. Every dropped lane is visible in the load report's per-lane row
  // counts rather than being silently absorbed.
  const orSelective = anchors.length > 0 && anchorDf <= scale.orCandidateCap;

  // Out-of-vocabulary terms are only worth correcting when enough of the query
  // is unrecognizable to look like a typo rather than a proper noun the corpus
  // simply does not contain. Same threshold parseQueryFeatures uses, but over
  // the exact vocabulary rather than the approximate stemmer's df lookup.
  const total = inVocab.length + oov.length;
  const oovRatio = total > 0 ? oov.length / total : 0;
  const correcting = oovRatio >= cfg.weighting.oovRatioFloor;

  return {
    andFrags: inVocab.map((e) => `(${e.frag})`).join(' & ') || null,
    orFrags: orSelective ? anchors.map((e) => `(${e.frag})`).join(' | ') : null,
    baseLexemes: [...new Set(inVocab.flatMap((e) => e.lexemes ?? []))],
    oovTerms: correcting ? oov.slice(0, scale.spellMaxTerms) : [],
    anchorTerms: orSelective ? anchors.map((e) => e.term) : [],
    anchorDf,
    orSelective,
    oovRatio,
    // The rarest in-vocab term's exact document frequency, which is what the
    // vector-lane gate reads. null when nothing in the query is in vocabulary
    // at all, so the gate cannot fire on a query it knows nothing about.
    minTermDf: byRarity.length > 0 ? byRarity[0].ndoc : null,
  };
}

function planScaleStatement(tier, profile, cfg) {
  const lanes = new Set(profile.lanes);
  if (lanes.has('trigram')) {
    throw new Error('planStatement: trigram lane requested on a synthetic-vector tier, which has no trigram index (DESIGN.md 6.2)');
  }
  const hasAnd = lanes.has('and');
  const hasOr = lanes.has('or');
  const hasFilters = Boolean(profile.filters);
  const schema = tier.schema;
  const scale = cfg.lanes.scale;
  const depth = scale.depth;
  const rrfK = cfg.lanes.rrfK;
  const topK = cfg.rerank.topK;
  // The stored generated column, not to_tsvector('english', m.body). Every
  // candidate row a lexical lane caps at pays this once, and recomputing it is
  // 10.4 us/row against 0.68 us/row for ts_rank_cd over an already-materialized
  // tsvector (measured at 1M over a fixed 400-row set: 4.51 ms to recompute
  // 400, 0.20 ms to read the same 400 bodies). At a 400-row cap that is ~4.3 ms
  // of the AND lane's ~11.8 ms, paid on every query with a lexical lane.
  // DESIGN.md 3.5 skipped the column to save heap at 10M; that traded ~2.1 GB
  // of a 30 GB budget for the dominant per-query cost, and section 6.6's
  // addendum records the reversal with both numbers.
  const doc = 'm.fts';

  const slots = [];
  const addSlot = (key) => {
    slots.push({ key });
    return `$${slots.length}`;
  };

  const andFragsParam = hasAnd || hasOr ? addSlot('andFrags') : null;
  const orFragsParam = hasOr ? addSlot('orFrags') : null;
  const baseLexParam = hasOr ? addSlot('baseLexemes') : null;
  const oovParam = hasAnd || hasOr ? addSlot('oovTerms') : null;
  const vecParam = addSlot('vector');
  const spanParam = hasFilters ? addSlot('span') : null;

  // Every lane reads the vector and the date range straight off the bind
  // parameter instead of through a CTE. That is deliberate: routing the query
  // vector through a CTE is what turned vec_lane into a sequential scan plus an
  // external sort at 1M (the NOT MATERIALIZED note on the quality-tier plan
  // below), and reading the Param directly makes the lane's plan independent of
  // how the tsquery CTEs happen to be materialized.
  const spanClause = spanParam
    ? `\n    and (${spanParam}::daterange is null or m.occurred_at <@ ${spanParam}::daterange)`
    : '';

  const ctes = [];

  if (hasAnd || hasOr) {
    // Spell correction, inside the same round trip. `oovTerms` is empty for the
    // overwhelming majority of queries, and unnest of an empty array produces
    // no rows at all, so the lateral below never executes for them. When it
    // does, it is a handful of trigram-index probes against a table with about
    // 1,700 rows at 1M -- the GIN index lives on this table and nowhere else,
    // which is the whole reason the scale tier can afford typo tolerance
    // without the 5-8 GB document trigram index DESIGN.md 6.2 ruled out.
    ctes.push(`fixed as materialized (
  select f.frag, f.lexemes, f.ndoc
  from unnest(${oovParam}::text[]) as t
  cross join lateral (
    select v.frag, v.lexemes, v.ndoc
    from ${schema}.term_stats v
    where v.term % t and similarity(v.term, t) >= ${scale.spellMinSimilarity}
    order by similarity(v.term, t) desc, v.term
    limit 1
  ) f
)`);

    const andSource = hasAnd
      ? `concat_ws(' & ', nullif(${andFragsParam}::text, ''), (select string_agg(frag, ' & ') from fixed))`
      : null;
    // A correction only joins the OR lane when the word it corrected TO is
    // itself selective enough for the lane to stay exact -- the same rule
    // scaleQueryParams applies to the anchors it can see, applied here to the
    // one term it cannot (the correction is chosen inside this statement).
    const orSource = hasOr
      ? `concat_ws(' | ', nullif(${orFragsParam}::text, ''), (select string_agg('(' || frag || ')', ' | ') from fixed where ndoc <= ${scale.orCandidateCap}))`
      : null;

    const qParts = [];
    if (hasAnd) qParts.push(`to_tsquery('simple', coalesce(nullif(${andSource}, ''), ${quoteSql(NO_MATCH_FRAG)})) as andq`);
    if (hasOr) {
      qParts.push(`to_tsquery('simple', coalesce(nullif(${orSource}, ''), ${quoteSql(NO_MATCH_FRAG)})) as orq`);
      // The fragment bar counts against the corrected term list, not the
      // original: a typo query whose only recognizable word is one term would
      // otherwise face a bar of 2 it can never clear, and the OR lane would
      // return nothing for the entire typo_noisy family.
      qParts.push(`(${baseLexParam}::text[] || coalesce((select array_agg(l) from fixed, unnest(fixed.lexemes) l), '{}'::text[])) as bar_lex`);
    }
    ctes.push(`q as materialized (\n  select ${qParts.join(',\n         ')}\n)`);
  }

  const fusedBranches = [];

  if (hasAnd) {
    const andWeightParam = addSlot('andWeight');
    // The cap is an unordered LIMIT, which is what makes the bitmap heap scan
    // stop early instead of materializing every match before ranking. It only
    // binds for queries whose AND still matches more rows than the cap; for
    // everything else the lane is exact.
    ctes.push(`and_cand as materialized (
  select m.id, ${doc} as doc
  from ${schema}.memories m, q
  where ${doc} @@ q.andq${spanClause}
  limit ${scale.andCandidateCap}
)`);
    // ts_rank_cd is projected once per candidate and ordered by output position,
    // so the rank is not recomputed for the window and again for the sort.
    ctes.push(`and_lane as (
  select id, score, row_number() over (order by score desc, id) as rnk
  from (
    select c.id, ts_rank_cd(c.doc, q.andq) as score
    from and_cand c, q
    order by 2 desc, 1
    limit ${depth}
  ) s
)`);
    fusedBranches.push(`select id, rnk, score, 'and' as lane, ${andWeightParam}::float / (${rrfK.and} + rnk) as w from and_lane`);
  }

  if (hasOr) {
    const orWeightParam = addSlot('orWeight');
    // AND-first (DESIGN.md 6.6): the disjunction only runs when the conjunction
    // came back thin. The subquery is uncorrelated, so Postgres evaluates it
    // once as an InitPlan and hangs a One-Time Filter over the scan -- the scan
    // is skipped outright, not run and discarded.
    const andFirstGate = hasAnd
      ? `\n    and (select count(*) from and_lane) < ${scale.andFirstThreshold}`
      : '';
    // The fragment bar reads tsvector_to_array(doc) instead of parsing a fresh
    // tsquery per query term per row, which is what the bar used to do
    // (measured over a fixed 500-row candidate set: 4.7 ms for the old bar
    // against 1.8 ms for this one). The OFFSET 0 lateral this used to need --
    // to stop to_tsvector running once per reference -- is gone with the
    // stored column: `doc` is now a plain column read.
    ctes.push(`or_cand as materialized (
  select m.id, ${doc} as doc, tsvector_to_array(${doc}) as lex
  from ${schema}.memories m, q
  where ${doc} @@ q.orq${andFirstGate}${spanClause}
  limit ${scale.orCandidateCap}
)`);
    ctes.push(`or_lane as (
  select id, score, row_number() over (order by score desc, id) as rnk
  from (
    select c.id, ts_rank_cd(c.doc, q.orq) as score
    from or_cand c, q
    where (select count(*) from unnest(q.bar_lex) x where x = any(c.lex)) >= least(2, cardinality(q.bar_lex))
    order by 2 desc, 1
    limit ${depth}
  ) s
)`);
    fusedBranches.push(`select id, rnk, score, 'or' as lane, ${orWeightParam}::float / (${rrfK.or} + rnk) as w from or_lane`);
  }

  const vectorWeightParam = addSlot('vectorWeight');
  // AND-first for the vector lane too, on the queries the caller marked as
  // carrying a term rare enough that the conjunction is already exact. Same
  // uncorrelated-subquery shape as the OR lane's gate, so Postgres evaluates it
  // once as an InitPlan and hangs a One-Time Filter over the ANN scan rather
  // than running it and discarding the rows. Only ever set when the AND lane is
  // in the statement to be counted.
  const vectorGate = profile.vectorGate && hasAnd
    ? `\n    and (select count(*) from and_lane) < ${scale.vectorSkipAndFloor}`
    : '';
  ctes.push(`vec_lane as (
  select m.id, row_number() over (order by m.embedding <=> ${vecParam}::halfvec) as rnk, null::real as score
  from ${schema}.memories m
  where m.embedding is not null${spanClause}${vectorGate}
  order by m.embedding <=> ${vecParam}::halfvec
  limit ${depth}
)`);
  fusedBranches.push(`select id, rnk, score, 'vector' as lane, ${vectorWeightParam}::float / (${rrfK.vector} + rnk) as w from vec_lane`);

  // The lexical rerank feature rides out of the lanes instead of being
  // recomputed over the final 50 rows. Recomputing it meant 50 more
  // to_tsvector calls per query (~0.55 ms at 11 us each, measured). The one
  // behavioural difference: a row that reached the top only through the vector
  // lane now scores 0 lexically rather than whatever ts_rank_cd would have
  // said, which is why this is scale-path only.
  const sql = `with ${ctes.join(',\n')},
fused as (
  select id, sum(w) as rrf, jsonb_object_agg(lane, rnk) as lane_ranks, max(score) as lexical
  from (
    ${fusedBranches.join('\n    union all\n    ')}
  ) all_lanes
  group by id
),
top as (
  select id, rrf, lane_ranks, lexical from fused order by rrf desc, id limit ${topK}
)
select t.id, t.rrf, t.lane_ranks,
       1 - (m.embedding <=> ${vecParam}::halfvec) as cosine,
       coalesce(t.lexical, 0)::real as lexical,
       m.occurred_at,
       null::int as dup_group,
       null::text as rare_token,
       false as rare_hit,
       false as title_hit,
       '{}'::text[] as people,
       '{}'::text[] as tags
from top t
join ${schema}.memories m on m.id = t.id
order by t.rrf desc, t.id`;

  return { kind: 'synthetic', hasAnd, hasOr, hasTrigram: false, hasFilters, hasPeopleFilter: false, slots, sql };
}

function quoteSql(literal) {
  // NO_MATCH_FRAG is already a tsquery-quoted lexeme; this wraps it as a SQL
  // string constant, doubling the single quotes it contains.
  return `'${literal.replace(/'/g, "''")}'`;
}

function planStatement(tier, profile, cfg) {
  if (tierKind(tier) === 'synthetic') return planScaleStatement(tier, profile, cfg);
  const kind = tierKind(tier);
  const lanes = new Set(profile.lanes);
  const hasAnd = lanes.has("and");
  const hasOr = lanes.has("or");
  const hasTrigram = lanes.has("trigram");
  if (hasTrigram && kind === "synthetic") {
    throw new Error("planStatement: trigram lane requested on a synthetic-vector tier, which has no trigram index (DESIGN.md 6.2)");
  }
  const hasFilters = Boolean(profile.filters);
  const hasPeopleFilter = hasFilters && kind === "real"; // no people[] column at scale (deviation 3)

  const schema = tier.schema;
  const ftsExpr = kind === "real" ? "m.fts" : "to_tsvector('english', m.body)";
  const vecCast = kind === "real" ? "vector" : "halfvec";
  const rangeCast = kind === "real" ? "tstzrange" : "daterange";
  const depth = laneDepthCfg(tier, cfg).depth;
  const rrfK = cfg.lanes.rrfK;
  const topK = cfg.rerank.topK;

  const slots = [];
  const nextParam = () => `$${slots.length + 1}`;
  const addSlot = (key) => {
    slots.push({ key });
    return `$${slots.length}`;
  };

  const qParts = [];
  let rawParam = null;
  if (hasAnd || hasTrigram) {
    rawParam = addSlot("raw");
    if (hasAnd) qParts.push(`websearch_to_tsquery('english', ${rawParam}) as andq`);
  }
  let orQueryParam = null;
  if (hasOr) {
    orQueryParam = addSlot("orQuery");
    qParts.push(`to_tsquery('english', ${orQueryParam}) as orq`);
  }
  const vecParam = addSlot("vector");
  qParts.push(`${vecParam}::${vecCast} as vec`);
  let spanParam = null;
  if (hasFilters) {
    spanParam = addSlot("span");
    qParts.push(`${spanParam}::${rangeCast} as span`);
  }
  let peopleParam = null;
  if (hasPeopleFilter) {
    peopleParam = addSlot("people");
    qParts.push(`${peopleParam}::text[] as people`);
  }
  if (hasAnd || hasTrigram) qParts.push(`${rawParam}::text as raw_text`);

  const spanClause = spanParam ? `\n    and (q.span is null or m.occurred_at <@ q.span)` : "";
  const peopleClause = peopleParam ? `\n    and (cardinality(q.people) = 0 or m.people && q.people)` : "";

  const laneCtes = [];
  const fusedBranches = [];

  if (hasAnd) {
    const andWeightParam = addSlot("andWeight");
    laneCtes.push(`and_lane as (
  select m.id, row_number() over (order by ts_rank_cd(${ftsExpr}, q.andq) desc, m.id) as rnk
  from ${schema}.memories m, q
  where ${ftsExpr} @@ q.andq${spanClause}${peopleClause}
  order by ts_rank_cd(${ftsExpr}, q.andq) desc, m.id
  limit ${depth}
)`);
    fusedBranches.push(`select id, rnk, 'and' as lane, ${andWeightParam}::float / (${rrfK.and} + rnk) as w from and_lane`);
  }

  if (hasOr) {
    const lexemesParam = addSlot("lexemes");
    const fragmentBarParam = addSlot("fragmentBar");
    const orWeightParam = addSlot("orWeight");
    // Same fragment-bar mechanism as scripts/recall.mjs (deviation 2): a
    // plain disjunction for the match, a count subquery for the bar.
    //
    // The bar stems each query term ONCE per query (bar_terms) and compares
    // lexeme arrays, instead of calling to_tsquery per term per candidate row.
    // Same reason the scale path carries q.bar_lex (DESIGN.md 6.6): a broad OR
    // over common terms matches ~42K of the 50K rows, so a 13-term query ran
    // ~540K to_tsquery parses. Measured on one such query: 451 ms -> 217 ms.
    // Verified result-identical on the dev split (same recall@1/5/10/20, same
    // MRR, and the same 86 failure records row for row), so the published
    // fixedRrf test number is unaffected.
    //
    // A term that stems to no lexeme is dropped rather than counted, which is
    // what `@@ to_tsquery` already did with the empty query it produced for one.
    //
    // The "lateral (select ${ftsExpr} as doc_tsv offset 0)" wrapper is a bug
    // fix, not the original design (found running bench-load.mjs against
    // bench_r1m, 2026-08-23): without it, the fragment-bar subquery below
    // calls ${ftsExpr} once per unnested lexeme, and on a tier with no
    // materialized fts column that means re-parsing the full document body
    // from scratch up to 14 times per candidate row. Measured: a 14-term
    // query against ~570K OR-matching rows took 75s. "OFFSET 0" is the
    // standard Postgres idiom to fence a lateral subquery against subquery
    // pullup, so the planner actually caches doc_tsv per row instead of
    // inlining and re-evaluating ${ftsExpr} at every reference; measured
    // down to ~10s for the same query. ${ftsExpr} is left as-is in the WHERE
    // and ORDER BY clauses below (not routed through doc_tsv) because that
    // is what keeps the primary match on the GIN expression index -- only
    // the fragment-bar subquery, which the index cannot help with, needs
    // the fence. The remaining cost is this lane's inherent shape (a broad
    // OR over common terms with no index support for "at least N of them"),
    // not this bug, and is reported rather than further optimized here.
    laneCtes.push(`bar_terms as materialized (
  select tsvector_to_array(to_tsvector('english', t)) as lexemes
  from unnest(${lexemesParam}::text[]) as t
  where to_tsvector('english', t) != ''::tsvector
)`);
    laneCtes.push(`or_lane as (
  select m.id, row_number() over (order by ts_rank_cd(${ftsExpr}, q.orq) desc, m.id) as rnk
  from ${schema}.memories m, q,
       lateral (select tsvector_to_array(${ftsExpr}) as doc_lex offset 0) fts_doc
  where ${ftsExpr} @@ q.orq
    and (select count(*) from bar_terms bt where bt.lexemes <@ fts_doc.doc_lex) >= ${fragmentBarParam}${spanClause}${peopleClause}
  order by ts_rank_cd(${ftsExpr}, q.orq) desc, m.id
  limit ${depth}
)`);
    fusedBranches.push(`select id, rnk, 'or' as lane, ${orWeightParam}::float / (${rrfK.or} + rnk) as w from or_lane`);
  }

  const vectorWeightParam = addSlot("vectorWeight");
  laneCtes.push(`vec_lane as (
  select m.id, row_number() over (order by m.embedding <=> q.vec) as rnk
  from ${schema}.memories m, q
  where m.embedding is not null${spanClause}
  order by m.embedding <=> q.vec
  limit ${depth}
)`);
  fusedBranches.push(`select id, rnk, 'vector' as lane, ${vectorWeightParam}::float / (${rrfK.vector} + rnk) as w from vec_lane`);

  if (hasTrigram) {
    const trigramWeightParam = addSlot("trigramWeight");
    const simExpr = `word_similarity(q.raw_text, m.title || ' ' || m.body)`;
    laneCtes.push(`trg_lane as (
  select m.id, row_number() over (order by ${simExpr} desc, m.id) as rnk
  from ${schema}.memories m, q
  where ${simExpr} >= ${cfg.lanes.trigramThreshold}${spanClause}
  order by ${simExpr} desc, m.id
  limit ${depth}
)`);
    fusedBranches.push(`select id, rnk, 'trigram' as lane, ${trigramWeightParam}::float / (${rrfK.trigram} + rnk) as w from trg_lane`);
  }

  const rareTokensParam = addSlot("rareTokens");
  const titlePatternsParam = addSlot("titlePatterns");

  const lexicalRef = hasOr ? "q.orq" : hasAnd ? "q.andq" : null;
  const dupGroupExpr = kind === "real" ? "m.dup_group" : "null::int";
  const rareTokenExpr = kind === "real" ? "m.rare_token" : "null::text";
  const titleExpr = kind === "real" ? "m.title" : "null::text";
  const peopleSelectExpr = kind === "real" ? "m.people" : "'{}'::text[]";
  const tagsSelectExpr = kind === "real" ? "m.tags" : "'{}'::text[]";

  // NOT MATERIALIZED (bug found running bench-load.mjs against bench_r1m,
  // 2026-08-23): q is referenced by every lane CTE, so a plain "with q as
  // (...)" gets materialized once Postgres 12+ sees more than one
  // reference. Once q.vec comes from a materialized CTE Scan rather than
  // an inlined subquery, the planner can no longer treat "embedding <=>
  // q.vec" as index-orderable, so vec_lane falls back to a full Seq Scan
  // plus an external disk sort instead of the HNSW index -- confirmed by
  // EXPLAIN (measured: 560ms/query instead of the sub-10ms an inlined q
  // gives). NOT MATERIALIZED forces per-reference inlining, so each lane
  // (including vec_lane's ORDER BY) gets its own eligible plan again.
  const sql = `with q as not materialized (
  select ${qParts.join(",\n         ")}
),
${laneCtes.join(",\n")},
fused as (
  select id, sum(w) as rrf, jsonb_object_agg(lane, rnk) as lane_ranks
  from (
    ${fusedBranches.join("\n    union all\n    ")}
  ) all_lanes
  group by id
),
top as (
  select id, rrf, lane_ranks from fused order by rrf desc, id limit ${topK}
)
select t.id, t.rrf, t.lane_ranks,
       1 - (m.embedding <=> q.vec) as cosine,
       ${lexicalRef ? `ts_rank_cd(${ftsExpr}, ${lexicalRef})` : "null::real"} as lexical,
       m.occurred_at,
       ${dupGroupExpr} as dup_group,
       ${rareTokenExpr} as rare_token,
       (${rareTokenExpr} is not null and ${rareTokenExpr} = any(${rareTokensParam}::text[])) as rare_hit,
       (${titleExpr} is not null and ${titleExpr} ilike any(${titlePatternsParam}::text[])) as title_hit,
       ${peopleSelectExpr} as people,
       ${tagsSelectExpr} as tags
from top t
join ${schema}.memories m on m.id = t.id, q
order by t.rrf desc, t.id`;

  return { kind, hasAnd, hasOr, hasTrigram, hasFilters, hasPeopleFilter, slots, sql };
}

export function buildRetrievalSql(tier, profile, cfg = defaultConfig) {
  const plan = planStatement(tier, profile, cfg);
  return { name: statementName(tier, profile), text: plan.sql, paramCount: plan.slots.length };
}

// ---------------------------------------------------------------------------
// retrieve (section 6.1: one round trip)
// ---------------------------------------------------------------------------

function toVectorLiteral(vec) {
  const arr = vec instanceof Float32Array ? Array.from(vec) : vec;
  return `[${arr.join(",")}]`;
}

function quoteLexeme(t) {
  return `'${String(t).replace(/'/g, "''")}'`;
}

function rangeLiteral(from, to) {
  if (!from && !to) return null;
  const lower = from ? `${from}T00:00:00Z` : "";
  const upper = to ? `${to}T00:00:00Z` : "";
  return `[${lower},${upper})`;
}

// Filters: profile.filters === false forces null span / empty people
// regardless of anything else. When true, an explicit query.filters wins
// over what parseQueryFeatures inferred from the text (section 6.4: the
// declared_filters ablation is deliberately the easier setting).
function resolveFilters(profile, explicitFilters, features, kind) {
  if (!profile.filters) return { span: null, people: [] };
  const declared = explicitFilters ?? null;
  const dateFrom = declared?.date_from ?? (declared ? null : features.dateRange.from);
  const dateTo = declared?.date_to ?? (declared ? null : features.dateRange.to);
  // Inferred people drive a hard AND on m.people, so an ambiguous mention here
  // deletes the target outright. Declared filters come from the caller and are
  // taken at face value.
  const people = declared?.people ?? (declared ? [] : features.entities.peopleConfident);
  return {
    span: rangeLiteral(dateFrom ?? null, dateTo ?? null),
    people: kind === "real" ? (people ?? []) : [],
  };
}

// hnsw.ef_search is a GUC, not a bind parameter (section 6.1), and SET does
// not accept $N placeholders -- the value is always a plain config integer,
// never user input, so inlining it is safe. Cached per physical connection
// so a homogeneous workload issues the SET almost never (advisor guidance).
const lastVectorGucs = new WeakMap();

// ivfflat.probes rides along in the same statement rather than a second round
// trip: rung 3's gate can swap the vector index to IVFFlat (DESIGN.md section
// 7), and the engine has no way to tell which index the schema currently
// carries. Setting all of them is one string, costs nothing, and means the same
// prepared workload runs correctly against either index.
//
// hnsw.iterative_scan is the measured fallback DESIGN.md 6.1 left open for the
// filtered lane; see config.lanes.scale.filteredIterativeScan for the numbers.
// It is scale-path only, so the quality tier's filtered lane behaves exactly as
// it did before.
// pgvector declares hnsw.ef_search with max_val 1000. Found the hard way on
// 2026-08-25: a 10M "near-exact ceiling" run asked for 4,000 through the pool's
// startup options, the extension was not loaded yet so Postgres accepted it as
// an unvalidated placeholder, and every connection then served at the DEFAULT
// 40. The window ran to completion and reported 0.731 -- which reads as a
// plausible ceiling and is in fact this tier's ef_search 40 number. A sweep knob
// that silently becomes its own default is the worst kind of measurement bug,
// so the range is checked here instead of being discovered in a result.
const HNSW_EF_SEARCH_MAX = 1000;

function assertEfSearch(value, where) {
  if (!Number.isInteger(value) || value < 1 || value > HNSW_EF_SEARCH_MAX) {
    throw new Error(
      `vectorSessionSettings: hnsw.ef_search must be an integer in 1..${HNSW_EF_SEARCH_MAX} (pgvector's own range), ` +
        `got ${value} from ${where}. Postgres accepts an out-of-range value as a placeholder before the extension ` +
        `loads and then serves every query at the default, so this fails loudly rather than measuring the default.`,
    );
  }
}

export function vectorSessionSettings(tier, cfg, filterActive) {
  const scale = tierKind(tier) === 'synthetic';
  if (scale) {
    // Deliberately independent of filterActive. The settings differ per query
    // only when they have to, and here they do not: iterative scan costs an
    // unfiltered lane nothing (measured, 1M: 0.79 ms with it against 1.60 ms
    // without, the difference being noise on a warm index, both returning the
    // full 30). Making the string constant means the SET fires once per
    // physical connection instead of every time a date-filtered query follows
    // an unfiltered one on the same connection -- which, with 15% of the
    // workload carrying a date and 96 pooled connections, was turning roughly a
    // quarter of all queries into two round trips instead of one.
    const s = cfg.lanes.scale;
    assertEfSearch(s.efSearch, 'config.lanes.scale.efSearch');
    assertEfSearch(s.filteredEfSearch, 'config.lanes.scale.filteredEfSearch');
    return [
      `SET hnsw.ef_search = ${s.efSearch}`,
      `SET ivfflat.probes = ${s.ivfProbes}`,
      `SET hnsw.iterative_scan = ${s.filteredIterativeScan}`,
      `SET hnsw.max_scan_tuples = ${s.filteredMaxScanTuples}`,
    ].join('; ');
  }
  const laneCfg = cfg.lanes.quality;
  const efSearch = filterActive ? cfg.lanes.filteredEfSearch : laneCfg.efSearch;
  assertEfSearch(efSearch, filterActive ? 'config.lanes.filteredEfSearch' : 'config.lanes.quality.efSearch');
  return [
    `SET hnsw.ef_search = ${efSearch}`,
    `SET ivfflat.probes = ${laneCfg.ivfProbes}`,
    `SET hnsw.iterative_scan = off`,
    `SET hnsw.max_scan_tuples = 20000`,
  ].join('; ');
}

async function applyVectorGucs(client, settings) {
  // A pool that pinned exactly these in its connect hook has already applied them
  // to every connection it owns, which is the only way to get them onto all of
  // them -- see lib/safety.mjs for the race this replaces.
  if (!shouldIssueSessionSql(client, settings)) return;
  if (lastVectorGucs.get(client) === settings) return;
  await client.query(settings);
  lastVectorGucs.set(client, settings);
}

// The AND/OR lane bind parameters, derived from parsed query features.
// Extracted so load.mjs --verify-oracle can measure the SAME lanes the engine
// runs: the verify step needs each lane's rank at full depth, which retrieve()
// cannot report (its `lanes` map is assembled from the fused top-50), so it
// issues its own statement -- and the two must not drift apart in how they
// build the OR disjunction or the fragment bar.
export function lexicalQueryParams(qf) {
  const contentTerms = [...new Set(qf.terms.filter((t) => !STOPWORDS.has(t)))].slice(0, 32);
  return {
    raw: qf.raw,
    contentTerms,
    orQuery: contentTerms.map(quoteLexeme).join(" | ") || null,
    fragmentBar: Math.min(2, contentTerms.length),
  };
}

export async function retrieve(client, query, ctx) {
  // performance.now(), not Date.now(): these timings are single-digit
  // milliseconds and whole-millisecond quantization is ~20% error on a 5 ms
  // query -- enough to hide the per-lane deltas this tier is tuned against.
  const t0 = performance.now();
  // Section 3.2's hard rule: engine.mjs sees {text, filters} and nothing
  // else. Destructure once, never touch `query` again, so a full query
  // record carrying certificate/diagnostics cannot leak into retrieval.
  const { text, filters } = query;

  const cfg = ctx.cfg ?? defaultConfig;
  const tier = ctx.tier;
  const profile = ctx.profile;
  const vocab = ctx.vocab ?? EMPTY_VOCAB;
  const kind = tierKind(tier);

  const qf = parseQueryFeatures(text, vocab, cfg);
  const weights = laneWeights(qf, profile, cfg);
  // The trigram lane costs a word_similarity over every row the (unselective)
  // trigram index hands back -- measured ~1.4 s of the ~1.76 s a tuned query
  // took at 50K. Its base weight is 0, so on the ~85% of queries that are
  // neither typoSuspect nor rare-term it contributes w = 0 to every RRF sum
  // and pays that cost for nothing. Gating on the weight gives those queries a
  // second prepared statement rather than a branch inside one.
  //
  // DESIGN.md 6.2 asks for one plan across the workload so the LOAD bench
  // measures a single statement; that requirement is about the scale tier,
  // which has no trigram lane at all. Recorded as a tunable rather than a pure
  // optimization because it is not identity-preserving in principle: a zero-
  // weight lane still contributes ids to the fused set, and when fewer than
  // topK rows have rrf > 0 those ids can occupy trailing candidate slots that
  // the reranker is then free to promote. Measured on dev (see DESIGN.md 6.7).
  const trigramGated = cfg.lanes.trigramWhenWeighted && profile.lanes.includes("trigram") && weights.trigram === 0
    ? { ...profile, lanes: profile.lanes.filter((lane) => lane !== "trigram") }
    : profile;

  const scaleParams = kind === "synthetic" ? scaleQueryParams(qf, vocab, cfg) : null;

  // The scale profile's second query-dependent gate (config's vectorSkipDfCeiling):
  // when the query names something that exists in a handful of documents, the AND
  // lane is already exact and the ~3.0 ms ANN search adds nothing. The client only
  // decides that the query has that shape; whether the lane actually runs is
  // decided in SQL against the AND lane's real row count, so a conjunction that
  // came back empty still gets its vector lane.
  const scale = cfg.lanes.scale;
  const vectorGate = kind === "synthetic"
    && trigramGated.lanes.includes("and")
    && trigramGated.lanes.includes("vector")
    && scaleParams?.minTermDf !== null
    && scaleParams?.minTermDf !== undefined
    && scaleParams.minTermDf <= scale.vectorSkipDfCeiling;
  const effectiveProfile = vectorGate ? { ...trigramGated, vectorGate: true } : trigramGated;

  const plan = planStatement(tier, effectiveProfile, cfg);
  const resolved = resolveFilters(effectiveProfile, filters, qf, kind);

  const { contentTerms, orQuery, fragmentBar } = lexicalQueryParams(qf);
  const rareTokens = contentTerms.slice(0, 32);
  const titlePatterns = qf.quoted.slice(0, 16).map((q) => `%${q}%`);

  const values = plan.slots.map(({ key }) => {
    switch (key) {
      case "raw": return qf.raw;
      case "orQuery": return orQuery;
      case "lexemes": return contentTerms;
      case "fragmentBar": return fragmentBar;
      case "andFrags": return scaleParams.andFrags;
      case "orFrags": return scaleParams.orFrags;
      case "baseLexemes": return scaleParams.baseLexemes;
      case "oovTerms": return scaleParams.oovTerms;
      case "vector": return toVectorLiteral(ctx.queryVector);
      case "span": return resolved.span;
      case "people": return resolved.people;
      case "andWeight": return weights.and;
      case "orWeight": return weights.or;
      case "vectorWeight": return weights.vector;
      case "trigramWeight": return weights.trigram;
      case "rareTokens": return rareTokens;
      case "titlePatterns": return titlePatterns;
      default: throw new Error(`retrieve: unbound param slot "${key}"`);
    }
  });

  const filterActive = Boolean(resolved.span) || resolved.people.length > 0;
  await applyVectorGucs(client, vectorSessionSettings(tier, cfg, filterActive));

  const sqlStart = performance.now();
  const { rows } = await client.query({ name: statementName(tier, effectiveProfile), text: plan.sql, values });
  const sqlMs = performance.now() - sqlStart;

  let candidates = rows.map((row, i) => ({
    // The statement's final ORDER BY is `t.rrf desc, t.id`, so arrival order IS
    // the fused rank. Carried explicitly because the rerank re-sorts in place:
    // without it there is no way afterwards to ask whether a final top-10 row
    // came from deep in the candidate set, which is how cfg.rerank.topK is
    // priced (a cut is provably free when no survivor sat past the new cap).
    fusedRank: i + 1,
    // memories.id is a bigint column, and node-postgres returns bigint as a
    // JS string (avoiding precision loss above 2^53) rather than a number.
    // Every id in the corpus JSON (targets, dup_group members, memoriesById
    // keys) is a plain JS number, so leaving this a string makes every
    // downstream `===` / Set/Map lookup silently fail -- ids here are dense
    // 1..N, always well inside Number.isSafeInteger, so this cast is exact.
    id: Number(row.id),
    laneRanks: row.lane_ranks ?? {},
    rrf: Number(row.rrf),
    rerankScore: null,
    // Raw pass-through until (and unless) ctx.rerank replaces it: rerank.mjs
    // owns the real RerankFeatures shape (its own file, not this module's
    // contract), so this is a documented fallback, not a guess at its keys.
    features: {
      cosine: row.cosine === null ? null : Number(row.cosine),
      lexical: row.lexical === null ? null : Number(row.lexical),
      rareHit: Boolean(row.rare_hit),
      titleHit: Boolean(row.title_hit),
      dupGroup: row.dup_group,
      occurredAt: row.occurred_at,
      people: row.people ?? [],
      tags: row.tags ?? [],
    },
  }));

  let rerankMs = 0;
  if (typeof ctx.rerank === "function" && profile.rerank) {
    const rerankStart = performance.now();
    candidates = await ctx.rerank(qf, candidates, cfg);
    rerankMs = performance.now() - rerankStart;
    candidates = [...candidates].sort((a, b) => (b.rerankScore ?? -Infinity) - (a.rerankScore ?? -Infinity));
  }

  const lanes = {};
  for (const row of rows) {
    for (const [lane, rnk] of Object.entries(row.lane_ranks ?? {})) {
      (lanes[lane] ??= []).push({ id: Number(row.id), rnk });
    }
  }
  for (const lane of Object.keys(lanes)) {
    lanes[lane].sort((a, b) => a.rnk - b.rnk);
    lanes[lane] = lanes[lane].map((e) => e.id);
  }

  return { hits: candidates, lanes, timings: { sqlMs, rerankMs, totalMs: performance.now() - t0 } };
}

// ---------------------------------------------------------------------------
// CLI: node engine.mjs "<query json>" [--tier NAME] [--profile NAME] [--vocab path]
// ---------------------------------------------------------------------------
//
// lib/safety.mjs, lib/synth-vectors.mjs, and scripts/lib/embeddings.mjs are
// sibling/repo modules this file does not own. They are loaded with a
// dynamic import inside this CLI branch ONLY, guarded by try/catch --
// never at module scope -- so importing parseQueryFeatures/laneWeights/
// buildRetrievalSql from this file never depends on them existing yet.
// When a dependency is missing, the CLI still prints features, lane
// weights, and the exact SQL + bound params it would have run, instead of
// crashing.

async function loadVocab(path) {
  if (!path) return EMPTY_VOCAB;
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path, "utf8"));
  return {
    totalDocs: raw.totalDocs ?? 1,
    df: raw.df ?? {},
    people: raw.people ?? {},
    places: raw.places ?? {},
  };
}

async function resolveQueryVector(text, tier, explicitVector) {
  if (explicitVector) return Float32Array.from(explicitVector);
  if (tier.vector === "real") {
    const mod = await import("../../scripts/lib/embeddings.mjs");
    return await mod.embedQuery(text);
  }
  throw new Error(
    `no vector for a synthetic-vector tier ("${tier.schema}"): synth-vectors.mjs's queryVector() needs a ` +
    `known targetId/clusterId from the generated corpus, which an ad-hoc debug query does not have. ` +
    `Pass one explicitly: {"text": "...", "vector": [<${tier.dims} floats>]}`,
  );
}

function printSection(title) {
  console.log(`\n== ${title} ==`);
}

async function runCli() {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(a);
    }
  }
  const queryJsonArg = positional[0];
  if (!queryJsonArg) {
    console.error('usage: node engine.mjs \'{"text": "..."}\' [--tier quality50k] [--profile tuned] [--vocab path.json]');
    process.exitCode = 1;
    return;
  }

  let queryInput;
  try {
    queryInput = JSON.parse(queryJsonArg);
  } catch (err) {
    console.error(`invalid query JSON: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (!queryInput.text) {
    console.error('query JSON must include "text"');
    process.exitCode = 1;
    return;
  }

  const tierName = flags.tier ?? "quality50k";
  const profileName = flags.profile ?? "tuned";
  const tier = defaultConfig.tiers[tierName];
  const profile = defaultConfig.profiles[profileName];
  if (!tier) throw new Error(`unknown tier "${tierName}" (config.tiers: ${Object.keys(defaultConfig.tiers).join(", ")})`);
  if (!profile) throw new Error(`unknown profile "${profileName}" (config.profiles: ${Object.keys(defaultConfig.profiles).join(", ")})`);

  console.log(`tier=${tierName} (schema ${tier.schema}, vector ${tier.vector}) profile=${profileName}`);

  const vocab = await loadVocab(flags.vocab).catch((err) => {
    console.log(`(vocab unavailable: ${err.message}; idf/oov/entity scoring degraded to empty vocab)`);
    return EMPTY_VOCAB;
  });

  const qf = parseQueryFeatures(queryInput.text, vocab, defaultConfig);
  printSection("query features");
  console.log(JSON.stringify(qf, null, 2));

  const weights = laneWeights(qf, profile, defaultConfig);
  printSection("lane weights");
  console.log(JSON.stringify(weights, null, 2));

  const built = buildRetrievalSql(tier, profile, defaultConfig);
  printSection(`SQL (${built.name}, ${built.paramCount} params)`);
  console.log(built.text);

  let queryVector;
  try {
    queryVector = await resolveQueryVector(queryInput.text, tier, queryInput.vector);
  } catch (err) {
    printSection("skipped: no query vector");
    console.log(err.message);
    return;
  }

  let safety;
  try {
    safety = await import("./lib/safety.mjs");
  } catch (err) {
    printSection("skipped: retrieval (lib/safety.mjs not landed yet)");
    console.log(`Import failed: ${err.message}`);
    console.log("Once it lands: node engine.mjs will connect to the bench Postgres and print ranked hits here.");
    return;
  }

  const client = safety.benchClient();
  await client.connect();
  try {
    const ctx = { tier, profile, vocab, cfg: defaultConfig, queryVector, rerank: null };
    const result = await retrieve(client, { text: queryInput.text, filters: queryInput.filters }, ctx);
    printSection(`ranked hits (${result.hits.length})`);
    for (const hit of result.hits) {
      console.log(`  id=${hit.id} rrf=${hit.rrf.toFixed(5)} rerankScore=${hit.rerankScore ?? "n/a"} laneRanks=${JSON.stringify(hit.laneRanks)}`);
    }
    printSection("timings (ms)");
    console.log(JSON.stringify(result.timings, null, 2));
  } finally {
    await client.end();
  }
}

// Only run the CLI when this file is executed directly, never on import.
// pathToFileURL rather than string-concatenating "file://": a repo path with a
// space or any character needing percent-encoding makes the naive form never
// match, which would silently turn the CLI into a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
