// Every tunable for the recall bench lives here (DESIGN.md section 3.4).
// This file is a frozen contract: gen-corpus.mjs, load.mjs, engine.mjs,
// rerank.mjs, and both bench-*.mjs scripts all read the same shape, so a
// key rename here breaks every sibling module at once.
//
// Additive-only deviations from the DESIGN.md 3.4 listing, each because
// "every tunable lives in config.mjs" (this module's own mandate) means a
// number section 3.4 never named a field for cannot just be hardcoded in
// engine.mjs instead:
//   - `weighting.dateBoost`: section 6.3's `w.vector += 0.2` on a resolved
//     date has no 3.4 entry.
//   - `weighting.paraphrase`: section 6.3 defines looksParaphrase as "long,
//     low maxIdf, no entities" prose with no named thresholds.
//   - `dates`: the closed-world date parser (section 3.6) needs a reference
//     point for templates with no year in the text ("last <Month>", "around
//     <Month>", bare month names); DESIGN.md never names one either.
//     referenceIso is pinned to lib/lexicon.mjs's own REFERENCE_NOW so both
//     sides resolve the same templates the same way.
//   - `resolveTier()`: section 3.4 splits a tier's knobs across `tiers` (size,
//     dims, schema) and `corpus` (seeds, family mix, dup groups), but every
//     downstream signature in 3.6 takes a single `tier`. Composing the two
//     halves lives here so all five entry points get the identical object.
// Every key that DESIGN.md 3.4 does show verbatim is left exactly as shown --
// nothing already in section 3.4 is renamed, reshaped, or renumbered.

export const config = {
  db: {
    url: process.env.BENCH_DATABASE_URL ?? "postgres://bench:bench@127.0.0.1:55433/recallbench",
    poolSize: 96,
  },

  tiers: {
    smoke1k:    { memories: 1_000,     queriesPerSplit: 100,   vector: "real",      dims: 768, bodyChars: [340, 400], schema: "bench_smoke" },
    quality50k: { memories: 50_000,    queriesPerSplit: 1_000, vector: "real",      dims: 768, bodyChars: [340, 400], schema: "bench_q50k"  },
    rehearsal1m:{ memories: 1_000_000, queriesPerSplit: 2_000, vector: "synthetic", dims: 256, bodyChars: [180, 220], schema: "bench_r1m"   },
    full10m:    { memories: 10_000_000,queriesPerSplit: 5_000, vector: "synthetic", dims: 256, bodyChars: [180, 220], schema: "bench_x10m"  },
  },

  corpus: {
    seedMemories: "fuzzy-brain-recall-bench-v1/memories",
    seedDev:      "fuzzy-brain-recall-bench-v1/queries/dev",
    seedTest:     "fuzzy-brain-recall-bench-v1/queries/test",
    // Shifted 2026-08-24 (DESIGN.md 4.4 step 4, the one knob that procedure
    // names for moving naive). Measured per-family vector-only Recall@10 at
    // 50K, post-repair: paraphrase 0.900, rare_token 0.920, entity_swap 0.553,
    // near_dup 0.72, date_filter 0.535, partial_ref 0.230, typo_noisy 0.430.
    //
    // DESIGN.md 4.4 says to shift toward rare_token/typo_noisy/paraphrase to
    // move naive, on the projection that rare_token's vector recall is 0.35.
    // Measured it is 0.920, so the SAME knob moves naive the other way, and
    // section 4.1 already records that inversion. Weight therefore moves TO
    // rare_token and paraphrase_nolex (the two families the real embedder
    // handles) FROM entity_swap, partial_ref and typo_noisy.
    //
    // Gate-safety of the shift: rare_token takes the largest share increase
    // and its verified oracle is 1.000, so it cannot cost the 0.97 ceiling.
    // paraphrase_nolex moves only 3 points because it is the family whose
    // oracle depends on the repair loop converging.
    familyMix: { paraphrase_nolex: 0.23, rare_token: 0.22, entity_swap: 0.11,
                 near_dup: 0.15, date_filter: 0.15, partial_ref: 0.07, typo_noisy: 0.07 },
    // Big enough to actually crowd a top-10, small enough that the group is
    // findable at all. 12-20 was the first, and it was measured inert: with the
    // whole group excluded from the ranking, the target already scored 0.413
    // vector Recall@10 against 0.427 with the siblings present, because the
    // confusion set was never in the top 10 to crowd anything.
    //
    // Once the planted terms became rare enough to address (mustIncludeVocab
    // below), that reversed: the target's external-competition rank rose to
    // 0.810 while measured recall stayed 0.427, so the siblings then cost the
    // family 0.38. 4-8 is where both halves hold -- a group of 8 leaves two
    // top-10 slots, so merely finding the group still does not score it, which
    // is the property DESIGN.md 4.2 asks for and what gives the `dupPenalty`
    // rerank feature something to earn back.
    dupGroupSize: [4, 8],
    clusters: 400,                 // topic clusters at 50K; scaled to 20_000 at 10M
    multiTargetShare: 0.0,         // headline test split is single-target on purpose (section 5)
    multiTargetCount: 300,         // separate reported set -> queries-multi.jsonl

    // Additive knobs (section 4.1 names each family's mechanism but no
    // numbers). Both exist because the family's designated solving lane has a
    // measurable floor below which the family is unsolvable rather than hard.
    typo: {
      // A transposition inside a short word destroys most of its trigrams, so
      // the trigram lane -- the only lane this family leaves standing -- can
      // no longer reach the target. Six characters is where the corrupted
      // token still shares enough trigrams to clear trigramThreshold.
      minTermLength: 6,
      // word_similarity divides by the QUERY's trigram count, so every extra
      // clean term dilutes the corrupted one's contribution. One companion is
      // enough to anchor the query topically without sinking the lane.
      maxCleanTerms: 1,
    },
    partialRef: {
      // The vague filler words are out-of-vocabulary by construction, so this
      // family's OR lane is driven entirely by the (detail, noun) pair. When
      // that pair co-occurs in more documents than the lane can rank, the
      // target is not findable however good the engine is.
      maxPairCoOccurrence: 10,
      // How many vague filler words the query wraps the (detail, noun) pair in.
      // Was 3. Measured 2026-08-24 over 120 partial_ref queries against the
      // loaded 50K corpus, varying ONLY the filler count and holding the pair
      // and the target fixed: vector Recall@10 went 0.283 (3 words) -> 0.317
      // (2) -> 0.333 (1) -> 0.375 (0). Every filler word is corpus-wide noise
      // that dilutes the two terms carrying the family's actual signal. One is
      // kept because DESIGN.md 4.1 defines the family as "one true detail plus
      // vague framing" -- at zero there is no framing left and the family
      // stops being a half-remembered reference.
      vagueWords: 1,
    },

    // Which pool each confusion-set family draws its planted `mustInclude`
    // terms from (measured calibration, 2026-08-24 -- see DESIGN.md 4.1).
    //
    // A topic's `concreteNouns` pool is 7 words wide and 50,000 memories share
    // 32 topics, so ~1,560 memories draw padding sentences from the same 7
    // nouns. A query built out of two of them names a phrase that thousands of
    // unrelated filler memories also contain, and the vector lane cannot find
    // the target's confusion set at all -- not because the family's planted
    // mechanism is hard, but because the corpus vocabulary is too dense to
    // address. `buildMultiTargetCase` already hit this and already moved to
    // DETAIL_WORDS (40-word pool, planted only where a family asks for it) for
    // exactly this reason; these two families follow it.
    //
    // Measured, same corpus, same targets, varying only the query vocabulary:
    // a date-shaped query over a (detail, noun) pair scores 0.412 vector
    // Recall@10 against 0.025 for today's two-topic-noun text. The planted
    // mechanism is untouched: every year still renders identical prose and the
    // date is still the only thing separating them.
    // `topicNouns` draws from the target's own topic (the dense 7-word
    // window), `crossTopicNouns` from the whole CONCRETE_NOUNS pool (106
    // words, so the two terms usually belong to different topics and almost
    // nothing contains both), `detailWords` from DETAIL_WORDS.
    //
    // At most ONE detail word per family, deliberately: a near_dup group
    // shares its mustInclude across all 12-20 members, so planting two detail
    // words there put the same detail PAIR in 16 memories at once and blew the
    // (noun, detail, detail) rarity that multi_target's own certificate
    // depends on -- measured, 16/300 multi-target queries went unreachable.
    // One detail word per memory creates no detail-detail co-occurrence at
    // all, and the pair rarity comes from the cross-topic noun instead.
    mustIncludeVocab: {
      // Three terms, not two. Measured against the loaded 50K corpus, holding
      // the targets fixed and varying only the query: a two-term date query
      // (cross-topic noun + detail word) scores 0.100 external Recall@10, a
      // three-term one 0.544. Rarity alone was not enough -- one common noun
      // still addresses the ~1,500 filler memories that use it as padding, and
      // it takes a third term to make the combination specific.
      date_filter: { topicNouns: 1, crossTopicNouns: 1, detailWords: 1 },
      near_dup:    { topicNouns: 1, crossTopicNouns: 1, detailWords: 1 },
    },
  },

  // The oracle ceiling (section 4.3) and its post-load verification.
  oracle: {
    bestLaneRankAt: 10,            // "best-lane-rank@10": the gate's k
    gate: 0.97,                    // section 4.3's threshold
    // Rounds of re-verbalize -> re-embed -> re-verify the repair loop will run
    // before it reports a family as non-converging. Bounded on purpose: a
    // family that cannot converge is a finding, not something to loop on.
    repairRounds: 4,
    // Rounds of RE-TARGET the repair loop escalates to once re-verbalizing has
    // run out. Re-verbalizing only rephrases a query around the same target,
    // so a target that is unreachable however the question is worded cannot
    // converge -- measured at 50K, re-verbalize left 54 paraphrase_nolex and
    // 8 entity_swap queries failing after every round. Re-targeting picks a
    // different memory (a different member of the same confusion set, or a
    // different paraphrase frame) from a forked sub-stream, so it is as
    // reproducible as the first draft. Still bounded: a query that cannot
    // converge across 4 re-verbalizations x 5 re-targets is a finding.
    retargetAttempts: 5,
    // Re-verbalization draws from a seeded sub-stream keyed by qid and round,
    // so a repaired corpus is as reproducible as an unrepaired one.
    repairSeed: "fuzzy-brain-recall-bench-v1/repair",
    // Generation-time fallback for partial_ref / typo_noisy queries whose
    // re-verbalize rounds keep returning to the SAME doomed (detail, noun)
    // pair or planted token, because re-verbalizing only rephrases the query
    // around content the target memory already carries -- it never changes
    // what got planted. Anchor resampling draws a BRAND NEW candidate pair or
    // token from a forked sub-stream, verifies it against the real corpus
    // index (co-occurrence / trigram ceiling) BEFORE writing it into the
    // target memory, and only commits on a verified pass. Bounded so a
    // family that structurally cannot converge is reported, not looped on
    // forever (DESIGN.md 4.2, calibration decision 2026-08-23).
    anchorResampleAttempts: 20,
  },

  lanes: {
    // Per tier: the quality tier can afford depth, the scale tier cannot.
    // These are the knobs that decide whether ~5 ms of CPU per query is enough,
    // so the scale values are priced for recall cost at the 1M rung (rung 3).
    quality: { depth: 100, efSearch: 100, ivfProbes: 12 },
    // The scale tier's extra knobs exist because ranking an unbounded candidate
    // set is what capped the 1M rehearsal at 10-16 QPS (measured 2026-08-24: an
    // OR over three common terms matched 862,972 of 1M rows and took 383 ms in
    // the index+heap scan alone, before a single ts_rank_cd ran). Every number
    // below is a bound on how much work ONE query may do, priced against the
    // ~5 core-ms per query that 2,400 QPS on 12 cores allows. See DESIGN.md 6.6.
    scale: {
      depth: 30, efSearch: 40, ivfProbes: 8,
      // Hard row caps applied BEFORE ranking, as an unordered LIMIT inside the
      // candidate CTE so the bitmap heap scan stops early. Measured cost of a
      // scale-tier candidate row (to_tsvector recompute + ts_rank_cd + the
      // fragment bar) is ~13 us, so 400 rows is ~5 ms of worst-case lane work.
      andCandidateCap: 400,
      orCandidateCap: 400,
      // Rare-term anchoring (WAND-style): the OR tsquery is built from only the
      // highest-IDF query terms, rarest first, while their cumulative document
      // frequency stays inside this budget. That is what bounds the OR lane's
      // match count by construction rather than by truncation.
      orAnchorMaxTerms: 3,
      orAnchorDfBudget: 300,
      // The OR lane only runs when the AND lane came back with fewer than this
      // many rows. Expressed in SQL as a one-time InitPlan filter so the whole
      // thing still travels as one prepared statement (DESIGN.md 6.1).
      andFirstThreshold: 10,
      // At most this many out-of-vocabulary terms get spell-corrected against
      // the trigram-indexed term_stats table inside the same statement.
      spellMaxTerms: 3,
      // pg_trgm similarity floor a correction candidate must clear. Below this
      // the term is dropped rather than "corrected" to something unrelated.
      spellMinSimilarity: 0.3,
      // Filtered vector lane. DESIGN.md 6.1 assumed raising ef_search to 200
      // would keep a date-filtered lane from starving and said the 1M rehearsal
      // would measure whether that is enough. It was measured (2026-08-24, one
      // three-month window over the ten-year corpus, ~2.5% selective) and it is
      // not: ef_search 200 returned 5 rows of 30 and cost 8 ms, ef_search 40
      // returned 0 rows. pgvector's own answer, iterative scan, returns the full
      // 30 in 3.8 ms with the scan bounded at 5,000 tuples -- better on both
      // axes than the number the design guessed. maxScanTuples is the bound
      // that keeps it from becoming the 21 ms it costs at 20,000; 2,000 was
      // then measured to still return the full 30 at roughly a third of the
      // 5,000 cost, and the load report's per-lane row count is what keeps that
      // claim honest across the whole workload rather than one query.
      filteredEfSearch: 40,
      filteredIterativeScan: 'relaxed_order',
      filteredMaxScanTuples: 2_000,
    },
    rrfK: { and: 60, or: 60, vector: 60, trigram: 60 },
    trigramThreshold: 0.3,
    // efSearch to apply when a metadata filter is present on the vector lane
    // (section 6.1: "hnsw.ef_search is raised to 200 when a filter is present
    // so a selective filter does not starve the lane"). Not filter-free depth.
    filteredEfSearch: 200,
    // Section 6.2's OR-lane fragment bar ("a row counts only when it holds at
    // least min(2, terms) of the query's lexemes") has no tunable here on
    // purpose: engine.mjs computes the bar per query as min(2, contentTerms)
    // and enforces it with a count over the unnested lexemes, so there is no
    // number for config to own. An earlier draft of this file declared an
    // orFragmentMaxTerms knob for a pairwise-AND expansion that was never
    // built; it has been removed rather than left describing a mechanism the
    // engine does not have.
  },

  profiles: {
    // Baseline 1: vector-only top-10. Zero tunables, which is exactly why it is
    // safe to calibrate corpus difficulty against it (section 4.4).
    naive:      { lanes: ["vector"], weighting: "fixed", weights: { vector: 1 },
                  filters: false, rerank: false },
    // Baseline 2: all lanes, equal weights, textbook RRF, no query awareness.
    fixedRrf:   { lanes: ["and", "or", "vector"], weighting: "fixed",
                  weights: { and: 1, or: 1, vector: 1 }, filters: false, rerank: false },
    tuned:      { lanes: ["and", "or", "vector", "trigram"], weighting: "query-dependent",
                  filters: true, rerank: true },
    // Claim B's wording is FTS/GIN + ANN + metadata filters + rerank; trigram is
    // not in it, and a trigram GIN over 10M x 200 chars would cost 5-8 GB and blow
    // the disk budget. The trigram lane is quality-tier only, and the scale tier
    // runs this three-lane profile.
    tunedScale: { lanes: ["and", "or", "vector"], weighting: "query-dependent",
                  filters: true, rerank: true },
  },

  weighting: {
    // Query-dependent lane weights: see section 6.3 for what each dial means.
    base:            { and: 1.0, or: 0.6, vector: 1.0, trigram: 0.0 },
    rareTermBoost:   { and: 1.8, trigram: 0.2 },   // applied when maxIdf >= rareIdfFloor
    paraphraseBoost: { vector: 1.6, or: 0.8, and: -0.7 },
    typoBoost:       { trigram: 1.5, and: -0.8 },
    entityBoost:     { and: 1.3 },
    // Section 6.3's dateRange rule ("text lanes lose discrimination once the
    // filter has already cut the year") has no named config field in the 3.4
    // listing; added here rather than hardcoded in engine.mjs.
    dateBoost:       { vector: 0.2 },
    rareIdfFloor: 9.5,             // ln(N/df); calibrated on the dev split only
    oovRatioFloor: 0.34,           // share of query terms absent from the corpus vocabulary
    // looksParaphrase = "long, low maxIdf, no entities" (section 6.3 prose).
    // These three thresholds are what that sentence cashes out to; tuned on
    // the dev split alongside rareIdfFloor/oovRatioFloor.
    paraphrase: { minTerms: 6, maxIdfCeiling: 6.0 },
  },

  // Additive: the closed-world date parser (section 3.6) needs a reference
  // point to resolve the three relative templates that carry no year in the
  // text ("last <Month>", "around <Month>", bare month names). DESIGN.md
  // does not name one. referenceIso: null defaults to real wall-clock "now";
  // once lib/lexicon.mjs's generator lands, set this to whatever anchor date
  // it used, or those three templates resolve against the wrong year in the
  // synthetic corpus. See engine.mjs's date-parser comments.
  dates: {
    // Matches lib/lexicon.mjs's REFERENCE_NOW exactly: the corpus generator
    // resolves "last <Month>"/bare-month templates against this fixed
    // anchor, not wall-clock time, so the parser has to use the same one.
    referenceIso: "2026-01-01T00:00:00.000Z",
  },

  rerank: {
    topK: 50,                      // candidates handed to the reranker
    weights: { lexical: 0.9, cosine: 1.0, entity: 1.4, recency: 0.2,
               dateFit: 1.6, rareHit: 2.0, dupPenalty: -0.7, titleHit: 0.5 },
    // Additive: section 6.5 names a `recency_decay` feature and a `date_fit`
    // that "decays outside" the parsed range, but gives neither a time
    // constant. Both live here rather than in rerank.mjs for the same reason
    // as dateBoost above -- they are dials someone will tune on the dev split,
    // and section 6.5 requires the fitted values to be committed so a reported
    // run reproduces from the repo alone.
    recencyHalfLifeDays: 730.5,    // two years: a decade-wide corpus should not flatten to ~0
    dateFitHalfLifeDays: 365.25,   // one year outside the parsed range is worth half
  },

  load: {
    mode: "open", offeredQps: 2400, durationSec: 120, warmupSec: 60,
    closedLoopSweep: [8, 16, 32, 64, 96, 128, 192],
    distinctQueries: 200_000,
    latencyBudgetMs: { p50: 41 },
  },
};

// Composes a config.tiers[name] entry with the corpus-wide knobs it needs.
//
// Every entry point must resolve tiers through this one function. A raw
// config.tiers entry is missing familyMix/dupGroupSize/seeds, and the corpus
// generator seeds its RNG off tier.name, so a hand-merged tier object either
// crashes or -- worse -- silently produces a different corpus than the one
// gen-corpus.mjs wrote to disk.
//
// Cluster count is keyed by vector type, not tier size: DESIGN.md 3.4 says
// clusters are "400 at 50K; scaled to 20,000 at 10M" but does not say what
// rehearsal1m uses. Since rehearsal1m and full10m share vector="synthetic",
// dims=256, and bodyChars -- they are the same generation recipe at
// different N -- this reads that as "20,000 clusters at every synthetic
// tier", the more consistent interpretation. Flagged as an interpretation,
// not a literal transcription.
export function resolveTier(name, cfg = config) {
  const base = cfg.tiers[name];
  if (!base) throw new Error(`resolveTier: unknown tier "${name}"; expected one of ${Object.keys(cfg.tiers).join(', ')}`);
  const isReal = base.vector === 'real';
  return {
    name,
    ...base,
    clusters: isReal ? cfg.corpus.clusters : 20_000,
    familyMix: cfg.corpus.familyMix,
    dupGroupSize: cfg.corpus.dupGroupSize,
    multiTargetShare: cfg.corpus.multiTargetShare,
    multiTargetCount: cfg.corpus.multiTargetCount,
    seedMemories: cfg.corpus.seedMemories,
    seedDev: cfg.corpus.seedDev,
    seedTest: cfg.corpus.seedTest,
    laneDepth: isReal ? cfg.lanes.quality.depth : cfg.lanes.scale.depth,
  };
}
