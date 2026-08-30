// Query features and query-dependent lane weights.
//
// Shared by scripts/recall.mjs and experiments/recall-bench/engine.mjs, which
// re-exports both functions bound to its own config. Pure: no database, no
// model, no clock beyond the date parser's reference point.

import { STOPWORDS, tokenize, stem } from "./text.mjs";
import { parseDateRange } from "./dates.mjs";
import { retrievalDefaults } from "./config.mjs";

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

export const EMPTY_VOCAB = { totalDocs: 1, df: new Map(), people: new Map(), places: new Map() };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractEntities(lowerText, vocab) {
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

// An alias that is also ordinary English costs more than it earns. Two guards,
// because the two failure shapes differ:
//   - A stopword alias carries no entity evidence at all and is dropped
//     outright. No retrieval system should filter on the article "an".
//   - A non-stopword alias is ambiguous when it appears in materially more
//     documents than actually carry the person tag. Ambiguous mentions still
//     feed the entity rerank feature and the AND-lane boost, which only
//     reorder; they are kept out of the hard filter and out of
//     looksParaphrase, which delete.
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

export function parseQueryFeatures(text, vocab, cfg = retrievalDefaults) {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();
  const v = vocab ?? EMPTY_VOCAB;
  const w = cfg.weighting;

  const { terms, quoted } = tokenize(raw);
  // Pure-digit tokens (years, mostly) belong to the date parser below, not
  // here: no word vocabulary tracks bare numbers, so a literal "2024" is
  // always out-of-vocabulary and would make every dated question look like a
  // typo regardless of its actual words.
  const contentTerms = terms.filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
  // Key df lookups with the SAME stemmer that built the index. A vocab whose
  // builder used a different stemmer passes its own as vocab.stem; every
  // disagreement otherwise reads as an out-of-vocabulary term that never
  // happened, which inflates oovRatio and suppresses maxIdf -- the two
  // features every weighting rule keys on.
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

  // Confident mentions only: an ambiguous alias that is also an ordinary word
  // must not disqualify a genuine paraphrase.
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

const LANES = ["and", "or", "vector", "trigram"];

export function laneWeights(features, profile, cfg = retrievalDefaults) {
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
  // Rules are additive; the clamp happens once at the end so a query matching
  // several rules still lands where the sum of the deltas says, rather than
  // where the first rule to saturate put it.
  if (features.maxIdf >= w.rareIdfFloor) addAll(w.rareTermBoost);
  if (features.looksParaphrase) addAll(w.paraphraseBoost);
  if (features.typoSuspect) addAll(w.typoBoost);
  if (features.entities.people.length > 0) addAll(w.entityBoost);
  if (features.dateRange.from || features.dateRange.to) addAll(w.dateBoost);
  for (const lane of LANES) out[lane] = Math.min(3, Math.max(0, out[lane] ?? 0));
  return out;
}
