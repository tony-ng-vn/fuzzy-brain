# Recall bench

A disposable harness that measures hybrid retrieval and reports whatever it actually finds.
The design, the claims it tests, and the reasoning behind every gate live in `DESIGN.md`.
This file is only about how to run it.

Two claims are under test.
Claim A is about quality: on a 50,000-memory corpus with a 1,000-query test split, a naive vector-only baseline lands well below a tuned lexical/vector retriever with reciprocal-rank fusion, and the tuned system reaches Recall@10 >= 0.91.
Claim B is about scale: hybrid retrieval over 10,000,000 synthetic memories sustains >= 2,400 queries per second at <= 41 ms median latency.

## Measured results

All three tiers have been run against a live cluster.
Full reasoning and every supporting table are in `DESIGN.md`; this is the headline numbers only.

| Tier | Recall | Throughput | Verdict |
| --- | --- | --- | --- |
| `quality50k` (claim A) | tuned Recall@10 **0.977**, 95% bootstrap CI [0.968, 0.986]; naive baseline 0.697 | -- | **PASS** (gate is Recall@10 >= 0.91) |
| `rehearsal1m` | R@10 0.917 | 1,200 QPS sustained open-loop, p50 12 ms; ~1,786 QPS closed-loop ceiling | gate is 2,400 QPS; not reached at 1M, but recall and cost profile are real measurements of a working system |
| `full10m` (claim B) | R@10 **0.967** with the binary-quantized lane (0.938 with halfvec at `ef_search` 400) | **60 QPS** sustained open-loop, p50 73 ms, on this laptop (40 QPS at p50 95 ms before binary quantization) | **FAIL on rate, by ~40x** -- recall passes; the shortfall is memory-bound on this machine, not a defect in the retrieval design (`DESIGN.md` sections 7.6 and 7.8) |

Two entries have been added since the first pass.
The `learned` profile, whose lane and rerank weights were fit from the dev split rather than tuned by hand, scores Recall@10 **0.998** on the `quality50k` test split, 95% CI [0.995, 1.000]; `tuned` is left byte-identical so every earlier number still reproduces (`DESIGN.md` 7.7).
And a binary-quantized vector lane (`tunedScaleBinary`, a 256-bit Hamming index reranked by halfvec cosine) raised the 10M tier from 40 to 60 sustained QPS and from R@10 0.938 to 0.967 at the same time, because a 32-byte-per-row graph stays resident where a 512-byte one does not (`DESIGN.md` 7.8).

The 10M run is still the honest one to read carefully: the corpus builds, the index builds, the recall floor is cleared, and the throughput gate still fails, because the working set does not fit in this machine's memory.
`DESIGN.md` 7.6 and 7.8 have the full build, the recall frontier, the throughput tables, the root-cause evidence, and the arithmetic for what a bigger machine would need.

## The machine guard

A load run refuses to start when it would overwhelm the machine it runs on.
`lib/resource-guard.mjs` checks four things before the first query: the working set against 70 percent of RAM, the connection count against four per core, swap already in use, and the current load average against the core count.
It also samples swap while a run is in flight and stops the run if the run itself starts swapping.
`scripts/full-validation.sh` breaks out of its rate climb at the first saturated window, because no offered rate above a saturated one can produce a better number.

This exists because a 10M run at 150 to 200 offered QPS drove about 100 backends against a 20.93 GB working set on a 24 GB laptop, took swap to 15.6 GB of 16 GB and load average to 72 on 12 cores, and made the desktop unusable until it was killed by hand.
Every input to that outcome was knowable before the run started.

Pass `--force` to `bench-load.mjs` to override the guard on a machine that can take it.
It prints what it is overriding.

## The safety rule, first

This harness never touches the real brain.
It never reads `.env.local`, it never reads the managed database's connection variable, and every entry point calls `assertBenchTarget()` before it opens a connection.

That guard is a positive allowlist rather than a blocklist.
A connection is refused unless the host is `127.0.0.1` or `localhost`, the port is exactly `55433`, and the database name is exactly `recallbench`.
Anything else fails closed, including a typo.

The only way to point the harness somewhere else is `BENCH_DATABASE_URL`, a deliberately separate variable, and even that has to satisfy the allowlist.
`tests/recall-bench-safety.test.mjs` greps every `.mjs` file in this directory and fails if any of them mentions the managed database at all.

Destructive SQL is fine here and only here, because everything in `recallbench` is synthetic and thrown away.

## Prerequisites

Docker Desktop does not start on this machine, so the database is a native throwaway Postgres cluster rather than a container.
`DESIGN.md` section 12 is the addendum that supersedes every Docker reference in the earlier sections.

You need Homebrew PostgreSQL 17 at `/opt/homebrew/opt/postgresql@17/bin` with pgvector linked in, which is already set up here.
`infra/pg-up.sh` gates on the rest: at least 40 GB free, the `vector` and `pg_trgm` extensions, and a real `halfvec` index build with both HNSW and IVFFlat cosine opclasses.
A failed gate aborts the script and prints the fallback from `DESIGN.md` section 9 instead of running a benchmark that would report a meaningless number.

## Running it

### The cluster

```sh
infra/pg-up.sh [--tier <name>] [--recreate]   # create, gate, tune, start
infra/pg-status.sh                            # read-only: is it up, which schemas exist
infra/pg-down.sh [--keep-data]                # stop, and delete .data/pgdata unless told not to
```

The cluster listens on `127.0.0.1:55433` only.
Connections go over TCP, not a socket, because a socket path under this repo would exceed the 103-byte limit macOS puts on them.
Server tuning comes from `infra/postgresql.bench.conf` and is appended to `postgresql.conf` at init time, before the first start, since several of those settings do not take effect on a running cluster.

### Generating a corpus

```sh
node gen-corpus.mjs --tier smoke1k --split both --verify
```

Flags are `--tier`, `--split` (`dev`, `test`, or `both`, default `both`), `--out`, `--verify`, and `--self-check`.

This step needs no database and no embedding model, so it is the fastest way to prove the harness works.
The smoke tier takes about 18 seconds and writes into `.out/smoke1k/`:

- `memories.jsonl`, 1,000 records
- `queries-dev.jsonl` and `queries-test.jsonl`, 100 queries each
- `queries-multi.jsonl`, the separately reported multi-target set
- `oracle.json`, written only with `--verify` -- and provisional: it certifies the lexical lanes only, and carries `vector.verified: false` until the post-load verify step runs (see `DESIGN.md` section 4.3.1)
- `CORPUS.lock`, the freeze point described in `DESIGN.md` section 4.4

Expect a warning that the smoke tier only fits about 65 of the configured 300 multi-target cases.
That is deliberate and it is reported rather than hidden: `config.corpus.multiTargetCount` is a single number shared by every tier, and 300 cases do not fit inside a 1,000-memory budget that has already spent 838 memories on the dev and test splits.

Every entry point resolves its tier through `resolveTier(name)` in `config.mjs`, which composes the `tiers` half of the config with the `corpus` half.
Do not hand-build a tier object from `config.tiers[name]`.
It is missing the family mix and the seeds, and because the generator seeds its RNG from the tier name, a hand-merged tier silently produces a different corpus than the one on disk.

### Loading, and the embedding sweep

```sh
node load.mjs --tier smoke1k [--stream] [--skip-embed] [--vector-index hnsw|ivfflat] [--resume]
```

This is the expensive step.
It creates the tier schema, `COPY`s the memories in, runs the real embedding sweep, caches the query vectors, and builds the indexes, printing a timing for each stage.

Budget about 20 minutes for the quality tier, which embeds 52,000 texts at the measured 50.4 texts per second.
The smoke tier is about 22 seconds of embedding.
Progress is checkpointed every 5,000 rows, so `--resume` picks up after a crash instead of starting over.

Caching query vectors is not a nicety.
Tuning takes dozens of `bench-recall` runs, and re-embedding 2,000 queries costs 26 seconds every time.

`--stream` skips writing `memories.jsonl` and feeds the generator straight into `COPY`, which matters only at the 10M tier where the file would cost roughly 4 GB of scratch disk.

### Verifying the oracle, after loading

```sh
node load.mjs --tier smoke1k --verify-oracle [--repair-rounds 3]
```

Run this after the load, before any bench.
It measures every query's rank in every lane against the corpus that was actually embedded, with the vector lane as an exact cosine rank in SQL, and rewrites `oracle.json` with `vector.verified: true`.
That file is the authoritative oracle; the one `gen-corpus --verify` writes is a provisional lexical-only number.

Queries no lane reaches are re-verbalized against the same target from a seeded sub-stream, re-embedded in place, and re-measured, for at most `config.oracle.repairRounds` rounds.
A family that does not converge inside that bound is printed as a finding rather than looped on.

The step refuses to trust a query-vector cache that does not match the query text on disk, and re-embeds instead.
Regenerating a corpus without re-running the sweep is exactly how a verified-looking oracle gets measured against vectors for questions nobody asked.

### The quality bench (claim A)

```sh
node bench-recall.mjs --tier quality50k --profile tuned --split test --ablation --taxonomy
```

Flags are `--tier`, `--profile` (default `tuned`), `--split` (default `test`), `--ablation`, `--taxonomy`, `--declared-filters`, `--limit`, and `--out`.

Tune against `--split dev` as often as you like.
The test split is the headline number and `bench-recall.mjs` appends every test-split run to `TEST-RUNS.log`, so if a reported number came from the fortieth attempt, that is visible in the repo.

`--ablation` walks the six-rung ladder from vector-only up to the full tuned system and prints where each point came from.
`--taxonomy` assigns one cause to every miss.

### The load bench (claim B)

```sh
node bench-load.mjs --tier full10m --profile tunedScale --mode open --offered-qps 2400 --duration 120 --warmup 60
```

Other flags are `--connections`, `--sweep`, `--sweep-duration`, `--sweep-warmup`, `--seed`, and `--out`.

Start with `--mode select1`.
That is the client-bottleneck probe: if a trivial query cannot clear roughly 10,000 QPS over loopback, the harness is measuring the Node client rather than Postgres and the run is invalid.

The headline number is open-loop, because a closed-loop run can report 2,400 QPS while coordinated omission hides the real median.
`--mode closed` gives the concurrency sweep, which is useful context and not the claim.

## Tests

```sh
npm run test:bench
```

Every file under `tests/recall-bench-*.test.mjs` runs without a database and without a model.
They cover the safety allowlist and the no-managed-database audit, the corpus contract (determinism, record shape, dense ids, solvability certificates), the metric definitions in `lib/stats.mjs`, and the reciprocal-rank-fusion formula on both sides: a fixture-pinned oracle in JavaScript, and the SQL `engine.mjs` actually emits, asserted to compute the same thing.

Two tests inside `recall-bench-corpus.test.mjs` build the full 50,000-memory `quality50k` corpus, one of them a second and third time in child processes, which is minutes of single-core work.
They are gated behind `RECALL_BENCH_HEAVY=1` and skip cleanly without it; `npm run test:heavy` runs them on their own.

`npm test` runs the whole repo suite, this harness included, with those two still skipped by default.

## Continuous integration

`.github/workflows/recall-bench.yml` runs on every pull request and on push to `main`, scoped to paths under `experiments/recall-bench/**` and `tests/recall-bench-*`, plus `workflow_dispatch` for a manual run.
It has three jobs.

`recall-bench unit` runs `npm run test:bench` with no database, which is every file in `tests/recall-bench-*.test.mjs` except the two `RECALL_BENCH_HEAVY` corpus tests above.

`recall-bench smoke` runs the harness end to end against a `pgvector/pgvector:pg17` service container published on `127.0.0.1:55433` as db `recallbench`, user `bench`, matching this file's own allowlist exactly.
It generates the `smoke1k` corpus, loads it with real embeddings, verifies the oracle, then runs `bench-recall.mjs` for the `naive` and `tuned` profiles on the dev split.
The job fails if tuned Recall@10 drops below 0.95, a floor set 0.05 under the 1.000 this measured on 2026-08-30 against a freshly built `smoke1k`, reproduced twice.
That margin is not query-sampling noise -- recall@10 is deterministic SQL over a fixed corpus -- it is there because `--verify-oracle`'s repair loop re-embeds and re-verbalizes queries that no lane reached, and that loop is embedding-dependent, so a runner with different floating-point behavior can repair a different number of queries than this machine did.
The embedding model (`nomic-ai/nomic-embed-text-v1.5`, about 650 MB) is cached with `actions/cache`, keyed on the model id, so it downloads once and every later run restores it instead of re-fetching from the Hugging Face hub.

`recall-bench heavy corpus` runs `npm run test:heavy`, the two 50,000-memory corpus tests, and only runs on `workflow_dispatch` -- never on a pull request or a push -- because each run is minutes of single-core work.

The service container only needs the `pgvector/pgvector:pg17` image plus `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD`.
`load.mjs`'s own `createSchema` step already issues `create extension if not exists vector` and `pg_trgm` before it creates a tier's table, so nothing in `infra/schema.sql` needs to run separately.
`infra/postgresql.bench.conf` is tuning for the million-row tiers (`shared_buffers`, parallel workers, `jit`), not correctness, so the smoke job runs on the image's defaults.

## Layout

```
config.mjs        every tunable, plus resolveTier(); the frozen contract
gen-corpus.mjs    memories, queries, ground truth, solvability certificates, oracle ceiling
load.mjs          COPY ingest, embedding sweep, query-vector cache, index build, post-load oracle verification
engine.mjs        lanes, query features, lane weighting, fusion SQL, filters
rerank.mjs        the linear rerank scorer, tuned independently
bench-recall.mjs  Recall@10, the ablation ladder, the failure taxonomy
bench-load.mjs    open-loop and closed-loop load generation

lib/safety.mjs        assertBenchTarget, benchClient, benchPool
lib/stats.mjs         Recall@k, MRR, macro recall, seeded bootstrap CI
lib/report.mjs        console tables shared by both benches
lib/rng.mjs           seeded RNG with named sub-streams
lib/lexicon.mjs       people, places, topics, disjoint vocabularies, date templates
lib/synth-vectors.mjs deterministic cluster vectors for the scale tiers
lib/jsonl.mjs         streaming read and write

infra/            cluster lifecycle, schema DDL, server tuning
.data/            git-ignored: the throwaway cluster
.out/             git-ignored: corpora, query-vector cache, results
```

## What is not built yet

The corpus generator and its tests run end to end.
Everything downstream of `load.mjs` has since been run against a live cluster at all three tiers -- see Measured results above and `DESIGN.md` sections 5, 7.4, and 7.6.

Three gaps are worth knowing about before trusting a number out of this harness.

`schemas.mjs` from `DESIGN.md` section 2 does not exist.
Nothing imports it, and both test files check record shapes directly against the documented shape instead, so this is a missing belt rather than a missing braces.

`infra/psql.sh` from section 3.7 does not exist either.
`infra/pg-status.sh` covers the read-only half of what it was for.

The multi-target set is generated but never reported.
`bench-recall.mjs` has no multi-target path at all, so `queries-multi.jsonl` and the macro-averaged recall that section 5 promises alongside the headline are currently written and then ignored.
`macroRecallAtK` in `lib/stats.mjs` is the piece that reporting would use.
