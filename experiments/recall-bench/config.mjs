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
    // efSearch was 100 and that was measuring the index, not the corpus.
    // Measured 2026-08-24 at 50K, same queries and targets, vector Recall@10
    // by exact cosine versus through the HNSW index:
    //
    //   family              exact   ef100   ef200   ef400   ef800
    //   paraphrase_nolex    1.000   0.886   0.957   0.986   0.986
    //   rare_token          0.929   0.914   0.929   0.929   0.929
    //   entity_swap         0.529   0.529   0.529   0.529   0.529
    //   near_dup            0.800   0.429   0.557   0.714   0.771
    //   date_filter         0.429   0.357   0.400   0.414   0.429
    //   partial_ref         0.357   0.343   0.357   0.357   0.357
    //   typo_noisy          0.714   0.486   0.600   0.657   0.671
    //   mix-weighted        0.752   0.639   0.693   0.729   0.741
    //
    // The loss lands exactly where this corpus plants dense near-duplicate
    // clusters: a dup group renders identical prose, so its members' vectors
    // sit on top of each other, the HNSW neighbour lists around them saturate
    // with each other, and the search settles inside the cluster without
    // reaching the one member the query asked for. That is an index-recall
    // defect, not corpus difficulty -- the oracle certifies the same lane at
    // 0.800 for near_dup by exact cosine (DESIGN.md 4.3.1: the gate is "a
    // statement about the lane, not about the index"), and an ablation whose
    // rung 0 is 37 points under its own lane is not measuring the rung.
    //
    // 400 is 4x the lane depth and recovers the bulk of it. Scale-tier
    // efSearch is deliberately untouched: claim B's latency budget is priced
    // at `lanes.scale`, and nothing here changes it.
    quality: { depth: 100, efSearch: 400, ivfProbes: 12 },
    // The scale tier's extra knobs exist because ranking an unbounded candidate
    // set is what capped the 1M rehearsal at 10-16 QPS (measured 2026-08-24: an
    // OR over three common terms matched 862,972 of 1M rows and took 383 ms in
    // the index+heap scan alone, before a single ts_rank_cd ran). Every number
    // below is a bound on how much work ONE query may do, priced against the
    // ~5 core-ms per query that 2,400 QPS on 12 cores allows. See DESIGN.md 6.6.
    scale: {
      // efSearch was 40, chosen when the vector lane could not reach any recall
      // floor at any setting and 40 was simply the cheapest way not to reach
      // one (DESIGN.md 7.2). With the geometry fixed (7.3) the frontier has a
      // solution, so this is now chosen the way decision 3 always meant it to
      // be: the smallest value whose WHOLE-PIPELINE recall clears 0.90.
      //
      // Measured at 1M on the re-embedded corpus, real drifted query vectors,
      // recall-sample-rate 1.0, a full pass over all 4,000 test queries per
      // point, every window valid (scripts/pipeline-ef-sweep.sh):
      //
      //   ef_search   R@10 mix   R@1 mix   single-stream p50
      //   10          0.819      0.756     3.71 ms
      //   16          0.817      0.789     3.61 ms
      //   24          0.860      0.839     3.79 ms
      //   40          0.897      0.877     3.50 ms   <- misses by 0.003
      //   44          0.906      0.890     4.18 ms   <- smallest that clears
      //   48          0.916      0.900     4.01 ms
      //   56          0.929      0.917     4.41 ms
      //   64          0.939      0.929     3.89 ms
      //   100         0.965      0.960     5.60 ms
      //
      // 44 is the literal smallest and it clears by 0.006, which is thinner
      // than the margin any other knob in this file is held to. 48 clears by
      // 0.016 at a latency indistinguishable from 44's -- the p50 column
      // carries roughly +/- 0.4 ms of run-to-run noise, and it is not monotone
      // in ef_search, which is itself the finding that the lane's cost is
      // mostly fixed rather than proportional to ef.
      depth: 30, efSearch: 48, ivfProbes: 8,
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
      // The scale profile's query-dependent lane policy (DESIGN.md 6.3, priced
      // in 6.7). The vector lane costs ~3.0 ms on every family uniformly and is
      // the single largest remaining line item, but on a query naming something
      // that exists in exactly one document the conjunction already has the
      // answer and the ANN search is buying nothing.
      //
      // The trigger is the rarest query term's EXACT document frequency, out of
      // term_stats, not the approximate stemmer's idf. Measured over 60 test
      // queries per family at 1M, the rarest term's df is:
      //   rare_token       1 /     1 /     1   (min/median/max)
      //   paraphrase      15 /    22 / 11993
      //   near_dup        15 /    34 / 12694
      //   partial_ref     37 /    59 /    75
      //   date_filter    231 / 24762 / 48906
      //   entity_swap  11993 / 24880 / 33600
      //   typo_noisy   12098 / 36908 / 50060
      // A ceiling of 5 separates rare_token cleanly with the nearest other
      // family 3x away, which is why this is a df threshold and not an idf one.
      vectorSkipDfCeiling: 5,
      // ...and even then the lane is only skipped when the AND lane actually
      // came back with something. Expressed in SQL as the same one-time InitPlan
      // filter the OR lane uses, so a rare-token query whose conjunction returns
      // nothing still gets its vector lane and the gate fails safe.
      vectorSkipAndFloor: 1,
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
      // Now BELOW the unfiltered efSearch (48), which inverts the convention
      // lanes.filteredEfSearch documents for the quality tier ("a selective
      // filter must not starve the lane, so the filtered path is never the
      // weaker one"). The scale tier is exempt and the exemption is measured:
      // this lane runs hnsw.iterative_scan, which keeps widening the search
      // until enough rows pass the filter, so what bounds it is
      // filteredMaxScanTuples and not ef_search. 7.2 measured that directly --
      // across the whole filtered grid, moving ef_search 40 -> 200 moved
      // date_filter hit@30 by 0.085 while moving max_scan_tuples 2,000 ->
      // 100,000 moved it by 0.380. Raising this number would cost latency and
      // buy almost nothing; the knob that matters is the one below it.
      filteredEfSearch: 40,
      filteredIterativeScan: 'relaxed_order',
      // Re-swept on the corrected geometry at ef_search 48, because 7.2 flagged
      // its own method here: with this knob pinned while efSearch swept,
      // date_filter contributed a fixed floor to every row of that frontier.
      // Swept properly (scripts/filtered-arm-sweep.sh):
      //
      //   max_scan_tuples   date_filter R@10   R@10 mix   single-stream QPS
      //   2,000             0.884              0.915      208
      //   8,000             0.937              0.924      173
      //   20,000            0.938              0.924      139
      //   50,000            0.940              0.925      101
      //
      // It stays at 2,000. The lane saturates at 8,000 and the extra costs 17%
      // of the single-stream rate for 0.009 of mix-weighted recall, which is
      // the wrong trade when the gate is already met at 0.915. The knob is
      // where the throughput claim is priced, not where the recall gate is won.
      filteredMaxScanTuples: 2_000,
    },
    rrfK: { and: 60, or: 60, vector: 60, trigram: 60 },
    trigramThreshold: 0.3,
    // Skip the trigram lane entirely on queries whose trigram weight is 0
    // (neither typoSuspect nor rare-term), instead of running it and
    // multiplying its RRF contribution by zero. See engine.mjs's comment in
    // retrieve() for why this is a tunable rather than a pure optimization.
    trigramWhenWeighted: true,
    // efSearch to apply when a metadata filter is present on the vector lane
    // (section 6.1: "hnsw.ef_search is raised to 200 when a filter is present
    // so a selective filter does not starve the lane"). Not filter-free depth.
    // Kept at 2x the unfiltered value it accompanies (was 200 against an
    // unfiltered 100). Section 6.1 raises ef_search when a filter is present
    // precisely so a selective filter does not starve the lane; leaving this
    // at 200 while the unfiltered lane moved to 400 would invert that and make
    // the filtered path the weaker one. Does not touch the naive profile,
    // which runs with filters off.
    filteredEfSearch: 800,
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
    // Fitted from the dev split by fit-rerank.mjs --fit-lanes (coordinate
    // descent over the multipliers in `weighting` below; DESIGN.md 7.7).
    // rerank.weights stayed at the committed values -- fit-rerank.mjs's
    // logistic-regression fit for those scored WORSE than committed on dev
    // (0.980 vs 0.989) and was not adopted. weightingOverrides replaces the
    // named sub-object wholesale where present; base.trigram and the whole
    // of rareTermBoost are absent on purpose (rareTermBoost never fires on
    // this corpus -- measured dev maxIdf tops out at 8.87, under the 9.5
    // floor -- and base.trigram has no affordable way to gather real data
    // for the ~85% of dev queries the committed profile never runs the
    // trigram lane on; see fit-rerank.mjs's file header). Measured dev
    // recall@10: 0.989 -> 0.998, paired bootstrap delta vs `tuned` on dev
    // [0.004, 0.015] (excludes 0). See .out/quality50k/learned-weights.json
    // for the full comparison and the per-weight bootstrap CIs.
    learned:    { lanes: ["and", "or", "vector", "trigram"], weighting: "query-dependent",
                  filters: true, rerank: true,
                  weightingOverrides: {
                    base:            { and: 2.6, or: 0.2, vector: -1.4 },
                    paraphraseBoost: { vector: 1.6, or: -1.3, and: -0.7 },
                    typoBoost:       { trigram: 0.2, and: -0.8 },
                    entityBoost:     { and: 2 },
                    dateBoost:       { vector: 0.2 },
                  } },
    // Claim B's wording is FTS/GIN + ANN + metadata filters + rerank; trigram is
    // not in it, and a trigram GIN over 10M x 200 chars would cost 5-8 GB and blow
    // the disk budget. The trigram lane is quality-tier only, and the scale tier
    // runs this three-lane profile.
    tunedScale: { lanes: ["and", "or", "vector"], weighting: "query-dependent",
                  filters: true, rerank: true },
  },

  weighting: {
    // Query-dependent lane weights: see section 6.3 for what each dial means.
    // or was 0.6. partial_ref is the family the OR lane is there to solve, and
    // at 0.6 its targets fused at rank 42-49 -- inside the candidate set,
    // outside the top 10. Measured on the dev split, partial_ref goes
    // 0.671 -> 0.943 -> 0.986 -> 1.000 as this moves 0.6 -> 1.0 -> 1.3 -> 1.6.
    // 1.3 is where partial_ref is essentially solved and paraphrase_nolex has
    // not yet started paying for it (see paraphraseBoost).
    base:            { and: 1.0, or: 1.3, vector: 1.0, trigram: 0.0 },
    // Never fires on this corpus: measured maxIdf for rare_token is 4.73,
    // nowhere near rareIdfFloor. Left inert rather than lowered, because the
    // family it was meant for already scores 1.000 and the only queries a
    // lower floor would catch are paraphrase_nolex (maxIdf 8.42), which this
    // boost's AND up-weighting is measurably wrong for.
    rareTermBoost:   { and: 1.8, trigram: 0.2 },   // applied when maxIdf >= rareIdfFloor
    // or was +0.8. Section 6.3 up-weights OR for paraphrases, but the naive
    // vector-only baseline beats the hybrid on this family, so its text lanes
    // are noise, not signal. At base.or 1.3 the old +0.8 compounded to 2.1 and
    // cost the family 6 points. -1.3 takes the OR lane to zero for paraphrase
    // queries specifically, leaving base.or free to serve partial_ref:
    // measured together, paraphrase 0.970 -> 0.991 with partial_ref held at
    // 0.986. Driving `and` to zero as well changes nothing (0.991 either way),
    // so it is left where section 6.3 put it.
    paraphraseBoost: { vector: 1.6, or: -1.3, and: -0.7 },
    typoBoost:       { trigram: 1.5, and: -0.8 },
    // and was 1.3. Measured on the dev split, entity_swap goes
    // 0.873 -> 0.909 -> 0.936 as this moves 0.0 -> 1.3 -> 2.0, and 2.6 buys
    // nothing because base.and + 2.0 already sits on the [0, 3] clamp.
    entityBoost:     { and: 2.0 },
    // Section 6.3's dateRange rule ("text lanes lose discrimination once the
    // filter has already cut the year") has no named config field in the 3.4
    // listing; added here rather than hardcoded in engine.mjs.
    dateBoost:       { vector: 0.2 },
    rareIdfFloor: 9.5,             // ln(N/df); calibrated on the dev split only
    oovRatioFloor: 0.34,           // share of query terms absent from the corpus vocabulary
    // Section 6.3 defines looksParaphrase as "long, low maxIdf, no entities".
    // Measured on the dev split, the middle clause is backwards for this
    // corpus: paraphrase_nolex has the HIGHEST maxIdf of any family (median
    // 8.42) and rare_token the near-lowest (4.73), because a paraphrase query
    // is built to share no vocabulary with its target, so the terms it does
    // share are incidental and rare. At maxIdfCeiling 6.0 the rule fired on
    // 11 of 230 paraphrase queries and the family scored 0.170.
    //
    // What actually identifies the family is being LONG and mostly
    // out-of-vocabulary: median 25 terms and oovRatio 0.76, against <= 12
    // terms and oovRatio 0.00 for every family the rule must not catch.
    // Measured separation at these values: 228 of 230 paraphrase queries, and
    // zero queries from any other family.
    paraphrase: { minTerms: 16, oovFloor: 0.5 },
    // A typo and a paraphrase both look out-of-vocabulary, and oovRatio alone
    // cannot tell them apart -- at oovRatioFloor 0.34 all 230 paraphrase
    // queries were flagged typoSuspect and handed the trigram boost and the
    // AND penalty meant for typos. Length separates them cleanly: typo_noisy
    // runs 5 terms, paraphrase_nolex 25. With this ceiling the rule catches
    // 70 of 70 typo_noisy queries and no paraphrase query at all.
    typoMaxTerms: 8,
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
    // Was 50. Cut to 25 on the evidence that the extra 25 have never once
    // changed an answer: across 45 measurement windows on the re-embedded 1M
    // corpus, the deepest fused rank that ever survived into a final top-10 is
    // 21, and the count of survivors from past rank 25 is 0.
    //
    // DESIGN.md 7.2 priced this cut as "provably free and unnecessary" and put
    // the saving at 0.06-0.10 ms. Free it is; unnecessary it is not, and the
    // saving was understated. Measured as an INTERLEAVED A/B rather than two
    // sequential arms -- this machine drifts by 0.51 ms of p50 over half an
    // hour of sustained load, which is three times the effect, and a
    // sequential comparison reported every cut as a slowdown -- the paired
    // delta is -0.179 ms of p50, negative in 4 of 4 pairs, with mix-weighted
    // R@10 unchanged at 0.915.
    topK: 25,                      // candidates handed to the reranker
    // Fitted on the dev split by coordinate descent (fit-rerank.mjs), per
    // section 6.5. What the fit found is that `fused` carries this stage: the
    // RRF order already places the target in the top 10 for 98.9% of dev
    // queries and inside the candidate set for 100% of them, so a scorer that
    // outranks the fusion prior can only lose ground. Section 6.5's own
    // starting vector, which had no fusion term at all, measured 0.728.
    //
    // With the prior in place every variant the descent reached ties at 0.9890
    // on dev -- pure fusion, the descent's own output, and this vector all land
    // on the same number, moving queries between families without changing the
    // total. The descent's output got there with lexical -1, entity -2 and
    // dupPenalty -2, which is it fitting the noise floor of 1,000 queries
    // rather than finding signal. This vector is the interpretable member of
    // that tie: the fusion order, refined by the features section 6.5 names,
    // at magnitudes small enough that none of them can overturn it.
    weights: { fused: 6.0, lexical: 0.0, cosine: 0.3, entity: 0.0, recency: 0.0,
               dateFit: 0.5, rareHit: 0.5, dupPenalty: -0.5, titleHit: 0.2 },
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
    // Fraction of load queries whose result is checked against its target, so
    // every throughput run reports whole-pipeline recall alongside the rate
    // (DESIGN.md 6.8: a system that does not retrieve has no throughput claim).
    // Sampled rather than universal to keep the hot path to a retrieval call
    // and one object literal; the check itself is arithmetic done after the
    // window closes. At 0.1 a 180 s window at 1,200 QPS still yields ~21,000
    // probes, roughly 3,000 per family, which is a +/- 1 point error bar.
    recallSampleRate: 0.1,
  },
};

// Dev-loop sweep hook: BENCH_CONFIG_OVERRIDE is a JSON object deep-merged into
// the config above, so a weight sweep is a shell loop rather than an edit to
// this file between every run.
//
// This does not weaken the audit trail. bench-recall.mjs derives the config
// hash it writes to TEST-RUNS.log from config.weighting, config.rerank and
// config.lanes AFTER this merge, so an overridden run logs a different hash
// than the committed defaults and is visible as its own configuration. The
// committed values stay the reproducible ones: DESIGN.md 6.5 requires the
// fitted vector to live in this file, so anything that survives tuning is
// written back here rather than left in an environment variable.
function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

if (process.env.BENCH_CONFIG_OVERRIDE) {
  deepMerge(config, JSON.parse(process.env.BENCH_CONFIG_OVERRIDE));
}

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
