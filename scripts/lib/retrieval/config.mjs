// Tunables for the product's recall verb.
//
// The functions in this directory take a cfg argument and never reach for a
// global, so the bench harness passes its own frozen config
// (experiments/recall-bench/config.mjs) and the product passes this one. Only
// the numbers differ; the code that reads them is shared.
//
// Every value here starts from the bench's measured tuning. The four that
// differ are marked, and each one differs because the brain is three orders of
// magnitude smaller than the bench corpus, not because the rule was rejected.

export const retrievalDefaults = {
  // Textbook RRF damping, one constant per lane so a lane can be flattened
  // independently later. edge is the ratified-why lane the bench has no
  // equivalent of; it uses the same damping as every other lane.
  rrfK: { and: 60, or: 60, vector: 60, trigram: 60, edge: 60 },

  // word_similarity floor for the trigram lane, straight from the bench.
  trigramThreshold: 0.3,

  weighting: {
    base: { and: 1.0, or: 1.3, vector: 1.0, trigram: 0.0 },
    rareTermBoost: { and: 1.8, trigram: 0.2 },
    paraphraseBoost: { vector: 1.6, or: -1.3, and: -0.7 },
    typoBoost: { trigram: 1.5, and: -0.8 },
    // Inert in the product until a person lexicon exists: nothing fills
    // vocab.people, so no query ever extracts an entity. Kept at the bench
    // value rather than deleted, so the rule is here the day it can fire.
    entityBoost: { and: 2.0 },
    dateBoost: { vector: 0.2 },
    // DIFFERS from the bench (9.5). maxIdf can never exceed ln(totalDocs),
    // and the brain is a few hundred rows, so ln(N) is about 6.1 and a floor
    // of 9.5 is unreachable -- the rule would be dead code. 5.0 means "this
    // word is in at most N/148 rows", which at 451 rows is a term appearing
    // in three rows or fewer, and stays a sane definition of rare as the
    // brain grows.
    rareIdfFloor: 5.0,
    oovRatioFloor: 0.34,
    // DIFFERS from the bench (minTerms 16). The bench's paraphrase family is
    // generated at a median of 25 terms; a person types 5 to 12. 8 is the
    // smallest length that cannot collide with typoMaxTerms below, which
    // matters because the two rules pull the AND lane in the same direction
    // and firing both at once would zero it.
    paraphrase: { minTerms: 8, oovFloor: 0.5 },
    // DIFFERS from the bench (8), for the collision reason just above: a typo
    // query is short, a paraphrase is long, and 6 versus 8 keeps a gap.
    typoMaxTerms: 6,
  },

  dates: {
    // Real "now": a person asking about "last june" means the june before
    // today, not before a pinned corpus anchor.
    referenceIso: null,
    // DIFFERS from the bench, which enables every template. "may" and "march"
    // are ordinary English words, and a bare month name in a real question is
    // far more often a verb than a date filter, so bare-month is left out.
    templates: [
      "in-month-year", "that-season-of-year", "before-year",
      "after-year", "in-year", "last-month", "around-month",
    ],
  },

  rerank: {
    topK: 25,
    // The bench's fitted vector, unchanged. `fused` carries the stage: the
    // RRF order is already the strongest signal, and the other features
    // refine it at magnitudes too small to overturn it.
    weights: { fused: 6.0, lexical: 0.0, cosine: 0.3, entity: 0.0, recency: 0.0,
               dateFit: 0.5, rareHit: 0.5, dupPenalty: -0.5, titleHit: 0.2 },
    recencyHalfLifeDays: 730.5,
    dateFitHalfLifeDays: 365.25,
  },
};
