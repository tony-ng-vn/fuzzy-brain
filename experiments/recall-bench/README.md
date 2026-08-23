# Recall bench

A disposable harness that measures hybrid retrieval and reports whatever it actually finds.
The design, the claims it tests, and the reasoning behind every gate live in `DESIGN.md`.
This file is only about how to run it.

Two claims are under test.
Claim A is about quality: on a 50,000-memory corpus with a 1,000-query test split, a naive vector-only baseline lands well below a tuned lexical/vector retriever with reciprocal-rank fusion, and the tuned system reaches Recall@10 >= 0.91.
Claim B is about scale: hybrid retrieval over 10,000,000 synthetic memories sustains >= 2,400 queries per second at <= 41 ms median latency.

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
- `oracle.json`, written only with `--verify`
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
node --test tests/recall-bench-*.test.mjs
```

All four files run without a database and without a model.
They cover the safety allowlist and the no-managed-database audit, the corpus contract (determinism, record shape, dense ids, solvability certificates), the metric definitions in `lib/stats.mjs`, and the reciprocal-rank-fusion formula on both sides: a fixture-pinned oracle in JavaScript, and the SQL `engine.mjs` actually emits, asserted to compute the same thing.

`npm test` runs these alongside the rest of the repo suite.

## Layout

```
config.mjs        every tunable, plus resolveTier(); the frozen contract
gen-corpus.mjs    memories, queries, ground truth, solvability certificates, oracle ceiling
load.mjs          COPY ingest, embedding sweep, query-vector cache, index build
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
Everything downstream of `load.mjs` has been syntax-checked and imports cleanly, but has not been executed against a live cluster.

Three gaps are worth knowing about before trusting a number out of this harness.

`schemas.mjs` from `DESIGN.md` section 2 does not exist.
Nothing imports it, and both test files check record shapes directly against the documented shape instead, so this is a missing belt rather than a missing braces.

`infra/psql.sh` from section 3.7 does not exist either.
`infra/pg-status.sh` covers the read-only half of what it was for.

The multi-target set is generated but never reported.
`bench-recall.mjs` has no multi-target path at all, so `queries-multi.jsonl` and the macro-averaged recall that section 5 promises alongside the headline are currently written and then ignored.
`macroRecallAtK` in `lib/stats.mjs` is the piece that reporting would use.
