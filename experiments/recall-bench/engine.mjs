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

import { config as defaultConfig } from "./config.mjs";

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
  const found = { people: extractOneKind(lowerText, vocab?.people), places: extractOneKind(lowerText, vocab?.places) };
  return found;
}

function extractOneKind(lowerText, mapOrObj) {
  const hits = []; // { slug, index }
  for (const [slug, aliasesRaw] of entriesOf(mapOrObj)) {
    const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [aliasesRaw];
    let earliest = -1;
    for (const alias of aliases) {
      const needle = String(alias ?? "").toLowerCase().trim();
      if (!needle) continue;
      const re = new RegExp(`\\b${escapeRe(needle)}\\b`);
      const idx = lowerText.search(re);
      if (idx >= 0 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    if (earliest >= 0) hits.push({ slug, index: earliest });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.slug);
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
  const stems = contentTerms.map(stem);

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

  const looksParaphrase =
    terms.length >= w.paraphrase.minTerms &&
    maxIdf <= w.paraphrase.maxIdfCeiling &&
    entities.people.length === 0 &&
    entities.places.length === 0;
  const typoSuspect = oovRatio >= w.oovRatioFloor;

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
  return `${lanes}_w${profile.weighting}_f${profile.filters ? 1 : 0}_r${profile.rerank ? 1 : 0}`;
}

function statementName(tier, profile) {
  return `retrieve_${tier.schema}_${profileSignature(profile)}`;
}

function laneDepthCfg(tier, cfg) {
  return tierKind(tier) === "real" ? cfg.lanes.quality : cfg.lanes.scale;
}

// Builds the SQL text and the ordered list of bind-parameter slots. Shared
// by buildRetrievalSql (public contract) and retrieve (which needs the
// same slot order to bind values) so the two can never drift apart.
function planStatement(tier, profile, cfg) {
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
    laneCtes.push(`or_lane as (
  select m.id, row_number() over (order by ts_rank_cd(${ftsExpr}, q.orq) desc, m.id) as rnk
  from ${schema}.memories m, q,
       lateral (select ${ftsExpr} as doc_tsv offset 0) fts_doc
  where ${ftsExpr} @@ q.orq
    and (select count(*) from unnest(${lexemesParam}::text[]) ql where fts_doc.doc_tsv @@ to_tsquery('english', ql)) >= ${fragmentBarParam}${spanClause}${peopleClause}
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
  const people = declared?.people ?? (declared ? [] : features.entities.people);
  return {
    span: rangeLiteral(dateFrom ?? null, dateTo ?? null),
    people: kind === "real" ? (people ?? []) : [],
  };
}

// hnsw.ef_search is a GUC, not a bind parameter (section 6.1), and SET does
// not accept $N placeholders -- the value is always a plain config integer,
// never user input, so inlining it is safe. Cached per physical connection
// so a homogeneous workload issues the SET almost never (advisor guidance).
const lastEfSearch = new WeakMap();

async function applyEfSearch(client, value) {
  if (lastEfSearch.get(client) === value) return;
  await client.query(`SET hnsw.ef_search = ${value}`);
  lastEfSearch.set(client, value);
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
  const t0 = Date.now();
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
  const plan = planStatement(tier, profile, cfg);
  const resolved = resolveFilters(profile, filters, qf, kind);

  const { contentTerms, orQuery, fragmentBar } = lexicalQueryParams(qf);
  const rareTokens = contentTerms.slice(0, 32);
  const titlePatterns = qf.quoted.slice(0, 16).map((q) => `%${q}%`);

  const values = plan.slots.map(({ key }) => {
    switch (key) {
      case "raw": return qf.raw;
      case "orQuery": return orQuery;
      case "lexemes": return contentTerms;
      case "fragmentBar": return fragmentBar;
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
  const baseEfSearch = laneDepthCfg(tier, cfg).efSearch;
  await applyEfSearch(client, filterActive ? cfg.lanes.filteredEfSearch : baseEfSearch);

  const sqlStart = Date.now();
  const { rows } = await client.query({ name: statementName(tier, profile), text: plan.sql, values });
  const sqlMs = Date.now() - sqlStart;

  let candidates = rows.map((row) => ({
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
    const rerankStart = Date.now();
    candidates = await ctx.rerank(qf, candidates, cfg);
    rerankMs = Date.now() - rerankStart;
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

  return { hits: candidates, lanes, timings: { sqlMs, rerankMs, totalMs: Date.now() - t0 } };
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
