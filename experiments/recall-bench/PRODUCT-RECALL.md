# Porting the bench engine into the product

The harness proved a retrieval design on a frozen, synthetic 50,000-memory corpus.
This note records what happened when the same design was put behind `scripts/recall.mjs`, against the real evidence store.
It is deliberately not in `DESIGN.md`: nothing here is a claim-A or claim-B result, and none of it was measured on the bench corpus.

## What is shared, and what is not

Six modules moved to `scripts/lib/retrieval/`, and both the harness and the product import them: `text.mjs` (tokenizer, stemmer), `dates.mjs` (the closed-world date parser), `features.mjs` (`parseQueryFeatures`, `laneWeights`), `fuse.mjs` (the RRF formula in JavaScript), `rerank.mjs` (`rerankFeatures`, `rerankScore`, `rerank`), and `config.mjs` (the product's tunables).
`experiments/recall-bench/engine.mjs` and `rerank.mjs` re-export the DESIGN.md 3.6 signatures with the bench config bound as the default, so no bench call site changed and the harness measured identically afterwards: `bench-recall.mjs --tier smoke1k --profile tuned --split dev` still reports Recall@10 1.000, with byte-identical per-query top-10 hit lists, rerank scores, lane weights and query features.

The SQL is not shared and cannot be.
The bench fuses inside one prepared statement over one `memories` table; the product searches two layers, plus a lane over ratified edge whys, and then walks one hop of the graph, which is not one statement.
`fuse.mjs` is the product's side of the fusion formula, pinned in `tests/retrieval-shared.test.mjs` against the same fixture the bench's own SQL oracle uses in `tests/recall-bench-rrf.test.mjs`.

## Tunables that had to change, and the measurement behind each

| Tunable | Bench | Product | Why |
| --- | --- | --- | --- |
| `rareIdfFloor` | 9.5 | 5.0 | `maxIdf` can never exceed `ln(totalDocs)`. The brain is a few hundred rows, so `ln(N)` is about 6.1 and the bench floor is unreachable: the rule would be dead code. 5.0 means "in at most `N/148` rows". |
| `paraphrase.minTerms` | 16 | 8 | The bench generates paraphrase queries at a median of 25 terms. A person types 5 to 12. |
| `paraphrase.oovFloor` | 0.5 | 0.6 | This rule deletes the OR lane. At 0.5, half the question's words are in the brain, which is not a rewording; "what does the embed sweep actually fill in" sat exactly on the boundary and lost every fragment it used to find. |
| `typoMaxTerms` | 8 | 6 | Keeps a gap against `minTerms`. Both rules pull the AND lane down, and firing both at once would zero it. |
| `base.or` | 1.3 | 1.0 | 1.3 was tuned for the bench's `partial_ref` family, which the brain has no equivalent of. Measured over the 18 questions below, 1.3 changed exactly one answer against 1.0 and changed it for the worse: an OR fragment pushed a strong vector hit out of the top ten and the state fell from `evidence` to `partial`. 0.8 measured identical to 1.0. |
| `rareTermBoost.trigram` | 0.2 | 0.0 | At brain scale the rare-term rule fires on most specific questions, and the trigram lane costs roughly two seconds against the real store. |
| `trigramThreshold` | 0.3 | 0.4 | See below. |
| `dates.templates` | all | no `bare-month` | "may" and "march" are ordinary English words. A bare month name in a real question is far more often a verb than a date filter. |

The entity rules (`entityBoost`, the people and places extraction, the hard people filter) are inert in the product: nothing fills a person lexicon yet.
They are left in place rather than deleted, so they work the day one exists.

## The trigram threshold, measured on the real store

`public.evidence` holds 47,366 spans.
Five hand-typed typo questions and three letter-soup queries, scored by `word_similarity` against their best match:

| Query | Best match |
| --- | --- |
| securty vulnerabilites reviw | 0.567 |
| brigtness and contrst bars | 0.688 |
| medaipipe face landmrk | 0.593 |
| chnagelog fomat rule | 0.500 |
| drone ligth show portrat | 0.645 |
| bcdfghjklmnp qrstvwxzbcdf ghjklmnpqrst vwxzbcdfghjk | 0.250 |
| zqxjv wkfmb ptghn lrdsc | 0.125 |
| xkqz vbnm plkj hgfd | 0.148 |

0.40 sits in the gap with about 0.15 of margin on each side.
It is also where the lane becomes affordable, because pg_trgm's GIN prefilter is threshold-driven rather than a post-filter:

| Threshold | Rows the index hands back | Wall time |
| --- | --- | --- |
| 0.30 | 1,047 | 3.1 s |
| 0.40 | 24 (capped) | 1.9 s |
| 0.45 | 766 | 0.79 s |
| 0.60 | 0 | 0.32 s |

0.45 is cheaper still and drops one of the five real typos (0.440), so 0.40 is the choice.
A letter-soup query costs 88 ms at 0.40, because the index hands back nothing.

One product-only deviation from the bench's SQL: the lane searches the question's **content words**, not the raw sentence.
Measured against brain_dev, "where is the kite festival" matched "where is the url to the site?" above 0.4 on the strength of "where is the" alone.
A shared stopword prefix is not a typo.

## Eighteen real-shaped questions, before and after

Run with `node scripts/recall.mjs "<q>" --json` against `BRAIN_SCHEMA=brain_dev` (451 embedded spans, no nodes, no edges), on the commit before the rewrite and on the commit after it.
Fourteen of the eighteen are unchanged in both state and top hit and are listed as "same".

| Question | Before | After |
| --- | --- | --- |
| what did we decide about the face reveal spec | `evidence` -- the face-reveal design span | `evidence` -- the V8 studio span |
| how did we fix the position.x crash in the brain map | `evidence` | same |
| what did the security review find about nodeLabel | `evidence` | same |
| the guide for jumbo portraits for drone light shows | `evidence` | same |
| what is this repo's changelog format rule | `evidence` | same |
| which granola tools is the mcp server scoped to | `evidence` | same |
| what was blocking the background updater | `evidence` | same |
| how does a skill get triggered | `evidence` | same |
| create two worktrees and a pr on the other repo | `evidence` | same |
| does mediapipe face landmark output look like a portrait | `evidence` -- "test with your photo first" | `evidence` -- Tony's own "the portrait loks like this" |
| what do the brightness and contrast bars do in v8 | `evidence` | same |
| can a node carry more than one type like location | `evidence` -- an unrelated security-review span | `evidence` -- the span that actually discusses node types |
| securty vulnerabilites reviw | `missing` -- nothing at all | `partial` -- the security-review span, through the trigram lane |
| what did I say in july 2026 about the brain map | `partial` | same |
| why was that verification run not valid | `evidence` | same |
| what does the embed sweep actually fill in | `partial` | same |
| how much did the cost of my apartment increase | `partial` | same |
| where is the kite festival | `missing` | same |

The typo question is the headline: it had no answer before and has the right one now.
Two answers got better and one got worse.

The one that got worse is worth naming plainly.
For "what did we decide about the face reveal spec", the V8 span is the only row all three lanes agree on -- AND rank 1, OR rank 8, vector rank 6 -- and fuses to 0.0507 against the design span's 0.0365 from two lanes.
That is reciprocal-rank fusion doing exactly what it is for, and the span it picked does discuss the reveal spec; it is simply not the document a person would have reached for.
Nothing here is a bug, and nothing here is worth retuning a threshold over on a sample of one.

Wall time per question, median over the eighteen: 2,294 ms before, 2,456 ms after.
Both numbers are dominated by fixed cost rather than by retrieval -- a question that matches nothing at all takes about 1,850 ms, which is Node starting up and the local embedding model loading.
The retrieval work itself went from roughly 450 ms to roughly 600 ms, for a document-frequency probe, four lanes per layer instead of two, and the edge lane.

A randomized letter-soup question was run twenty more times after the rewrite.
All twenty answered `missing` with zero hits, which is the admission rule holding: below the strong-vector threshold a row has to have been matched by a lane that reads actual words.
