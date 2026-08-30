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

  // DIFFERS from the bench (0.3). Measured against the real evidence store
  // (47,366 spans) on 2026-08-30: five hand-typed typo questions scored
  // 0.44 to 0.69 against their own answer, and three letter-soup queries
  // topped out at 0.25. 0.40 sits in that gap with about 0.15 of margin on
  // each side. It is also where the lane becomes affordable -- the GIN
  // prefilter is threshold-driven, so the same typo query costs 3.1 s at
  // 0.30, 1.9 s at 0.40 and 0.79 s at 0.45, and 0.45 already drops one of
  // the five real typos (0.440).
  trigramThreshold: 0.4,

  weighting: {
    // DIFFERS from the bench, which sets or to 1.3. That number was tuned for
    // the bench's partial_ref family -- queries deliberately built as
    // half-remembered fragments -- and the brain has no such family. Measured
    // over 18 real-shaped questions against brain_dev, 1.3 changed exactly one
    // answer against 1.0, and changed it for the worse: an OR-lane fragment
    // pushed a strong vector hit out of the top ten and the state fell from
    // "evidence" to "partial". The OR lane is what feeds "partial", so
    // ranking it above the exact lane inverts the ordering this store is
    // about. 0.8 measured identical to 1.0, so 1.0 it is.
    base: { and: 1.0, or: 1.0, vector: 1.0, trigram: 0.0 },
    // DIFFERS from the bench, which also adds 0.2 to trigram here. At brain
    // scale the rare-term rule fires on most specific questions (any word in
    // three rows or fewer clears the floor below), and the trigram lane costs
    // roughly two seconds against the real evidence store. Paying that on
    // most questions to help a lane the AND boost already covers is the wrong
    // trade, so the trigram lane is left to the one rule that needs it: a
    // short question whose words are not in the brain at all.
    rareTermBoost: { and: 1.8, trigram: 0.0 },
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
    // DIFFERS from the bench (minTerms 16, oovFloor 0.5). The bench's
    // paraphrase family is generated at a median of 25 terms; a person types 5
    // to 12. 8 is the smallest length that cannot collide with typoMaxTerms
    // below, which matters because the two rules pull the AND lane in the same
    // direction and firing both at once would zero it. The floor moves up
    // because this rule DELETES the OR lane: at 0.5 exactly half the question's
    // words are in the brain, which is not a rewording, and "what does the
    // embed sweep actually fill in" lost every fragment it used to find. At
    // 0.6 the rule fires only when the question really does share almost
    // nothing with what is stored.
    paraphrase: { minTerms: 8, oovFloor: 0.6 },
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
