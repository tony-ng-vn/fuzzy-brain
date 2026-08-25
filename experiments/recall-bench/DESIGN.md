# Recall bench: design

A disposable, self-contained harness that measures two things about hybrid retrieval and reports whatever it actually finds.

**Claim A (quality).**
On a 1,000-query, 50,000-memory benchmark, a naive baseline scores well below a tuned query-dependent lexical/vector retriever with reciprocal-rank fusion, and the tuned system reaches Recall@10 >= 0.91.

**Claim B (scale).**
Hybrid retrieval over 10,000,000 synthetic memories -- Postgres GIN full-text, pgvector ANN, metadata filters, and a rerank stage -- sustains >= 2,400 queries/sec at <= 41 ms median latency on this machine.

Both claims are only worth stating if the harness can also fail them.
Every gate below is written so a miss is reported as a miss, and the doc names the fallback rather than a fudge.

> **Read section 12 first.** Docker Desktop is broken on this machine, so the database runs as a throwaway native Postgres 17 cluster on port 55433 rather than a container. Section 12 supersedes every Docker reference in sections 0, 7, and 8.1. Everything else in this document stands unchanged.

---

## 0. Non-negotiables

The real brain is off-limits.
This harness never reads `DATABASE_URL`, never reads `.env.local`, and never opens a connection to the managed Polygres database.

Everything runs against a new disposable container:

- image `pgvector/pgvector:pg17`
- published on `127.0.0.1:55433` only
- database `recallbench`, role `bench`
- data directory bind-mounted at `experiments/recall-bench/.data/pgdata`, which is git-ignored

The guard is a positive allowlist, not a denylist.
`lib/safety.mjs` exports `assertBenchTarget(connectionString)`, which throws unless **all** of these hold: host is `127.0.0.1` or `localhost`, port is exactly `55433`, database name is exactly `recallbench`.
Every entry point calls it before it connects.
`tests/safety.test.mjs` greps every `.mjs` file in this directory for the literals `DATABASE_URL` and `.env.local` and fails if either appears outside `lib/safety.mjs`, mirroring the audit discipline in `tests/sandbox-routing.test.mjs`.

Destructive SQL is fine here and only here.
`recallbench` is created, filled, measured, and thrown away; `infra/pg-down.sh` deletes the container and the data directory.

---

## 1. Measured facts this design rests on

### 1.1 Machine

Apple M4 Pro, 12 cores, 24 GB RAM, 68 GB free on the data volume, Docker CLI 26.6.0.
Note: the Docker daemon was not running when these notes were written, so every Postgres-side capability below is written as a **gate check at the smoke tier**, with a named fallback, not as an assumed fact.

### 1.2 Embedding throughput (real, measured)

Probe: `scripts/lib/embeddings.mjs` as shipped (nomic-embed-text-v1.5, fp32, 768-dim, in-process transformers.js), weights already cached in `~/.fuzzy-brain/models`.

| Input | Batch | Throughput |
| --- | --- | --- |
| Short lines (~80 chars) | 8 | 105.3 texts/sec |
| Short lines (~80 chars) | 32 | 97.9 - 107.3 texts/sec |
| Memory-length bodies (367 chars) | 16 | 43.5 texts/sec |
| Memory-length bodies (367 chars) | 32 | 48.0 texts/sec |
| Memory-length bodies (367 chars) | 64 | **50.4 texts/sec** |
| Memory-length bodies, steady state | 32 x 3 | 46.6 texts/sec |

Model load plus first inference: 414 ms with weights on disk.
Single query embed (`embedQuery`, one text, includes the `search_query:` prefix): 12.8 ms.

**Multi-process sharding is wasted engineering, and that is a result, not a footnote.**
Aggregate throughput on 367-char bodies: 1 worker ~50/sec, 3 workers 54.9/sec (18.3 + 18.2 + 18.4), 6 workers 50.5/sec.
onnxruntime already spreads a single batch across the cores (the single-process probe ran at 238% CPU), so a worker pool buys about 10% at three workers and goes negative at six.
The sweep is therefore **single-process, batch 64**.

### 1.3 Derived time estimate

Realistic-length bodies are what drive the estimate, not the short-line number.

- 51,000 embeddings at 50.4 texts/sec = **1,012 seconds, about 17 minutes**.
- The actual quality-tier sweep is 50,000 memories + 2,000 queries (1,000 dev + 1,000 test) = 52,000 texts = **about 17.3 minutes**.
- The 1,000-memory smoke tier = 1,100 texts = **about 22 seconds**.

Budget 20 minutes wall clock for the quality-tier sweep and treat anything past 25 minutes as a signal that the bodies are longer than designed.

---

## 2. Directory layout

One responsibility per file, so several agents can implement in parallel without editing the same file.

```
experiments/recall-bench/
  DESIGN.md                 this document
  README.md                 how to run it (owner: docs)
  config.mjs                every tunable, all tiers and profiles      [FROZEN FIRST]
  schemas.mjs               JSONL record shapes + validators           [FROZEN FIRST]

  infra/
    pg-up.sh                create container, verify prerequisites, apply tuning
    pg-down.sh              stop container, delete .data/pgdata
    psql.sh                 thin wrapper: docker exec psql into recallbench
    schema.sql              DDL for all four tiers, guarded by \set tier
    postgresql.bench.conf   server tuning, bind-mounted

  lib/
    safety.mjs              assertBenchTarget, connect helper
    rng.mjs                 seeded RNG with named sub-streams
    lexicon.mjs             people, places, topics, disjoint vocabularies, templates
    synth-vectors.mjs       deterministic cluster vectors for the 10M tier
    jsonl.mjs               streaming read/write
    stats.mjs               percentiles, mean, bootstrap CI
    report.mjs              table + JSON rendering shared by both benches

  gen-corpus.mjs            memories + queries + ground truth + oracle ceiling
  load.mjs                  COPY ingest, embedding sweep, query-vector cache, index build
  engine.mjs                lanes, query features, weighting, RRF, filters
  rerank.mjs                the rerank stage (separate file: it is tuned independently)
  bench-recall.mjs          Recall@10, ablation ladder, failure taxonomy
  bench-load.mjs            open-loop and closed-loop load generator

  tests/
    contract.test.mjs       schemas.mjs + config.mjs shape (guards both downstream agents)
    safety.test.mjs         the allowlist and the DATABASE_URL grep
    rng.test.mjs            determinism and sub-stream independence
    gen-corpus.test.mjs     ground-truth validity, family mix, solvability certificates
    engine.test.mjs         feature parsing, lane weighting, RRF math, filter inference
    rerank.test.mjs         scorer monotonicity and tie stability
    smoke.test.mjs          the 1K tier end to end (skipped when the container is down)

  .data/                    git-ignored: pgdata
  .out/                     git-ignored: corpora, query-vector cache, result JSON
```

`config.mjs` and `schemas.mjs` are the **first artifact and the freeze point**.
`gen-corpus.mjs` and `engine.mjs` are both downstream of those shapes, so changing them mid-flight breaks two agents at once.
`tests/contract.test.mjs` lands with them and validates every record the generator emits.

Add to `.gitignore`:

```
experiments/recall-bench/.data/
experiments/recall-bench/.out/
```

---

## 3. Contracts

### 3.1 Memory record (JSONL, one object per line)

```jsonc
{
  "id": 41732,                       // int, dense 1..N, also the DB primary key
  "kind": "event",                   // event|person|preference|quote|place|project|note
  "title": "The night the kitchen finally felt like ours",
  "body": "On the second Tuesday of March, Doan cooked pho ...",
  "raw": "doan made pho and it was the first time the kitchen ...",
  "people": ["doan", "minh"],        // slugs from lexicon.PEOPLE
  "places": ["dobson-road"],         // slugs from lexicon.PLACES
  "tags": ["cooking", "moving-in"],  // topic slugs
  "occurred_at": "2024-03-12T19:30:00.000Z",
  "cluster_id": 137,                 // topic cluster; drives synthetic vectors and near-dups
  "dup_group": 812,                  // int or null: near-duplicate family membership
  "rare_token": "kbz-4417",          // string or null: planted globally-unique token
  "distinguisher": "star anise"      // string or null: the detail that separates it from its dup siblings
}
```

`body` targets 340-400 characters at the 50K tier (matching the throughput probe) and 180-220 characters at the 10M tier (disk budget).
`raw` mirrors the repo's two-layer node shape so the harness exercises the same weighted `tsvector` the real schema uses; it is a lowercased, compressed restatement, never a copy.

### 3.2 Query record (JSONL)

```jsonc
{
  "qid": "test-000412",
  "split": "dev",                    // dev | test
  "family": "paraphrase_nolex",      // see 4.1
  "text": "what did we eat the night the new place stopped feeling empty",
  "targets": [41732],                // ground-truth memory ids
  "declared_filters": {              // what an API caller COULD pass; not used by the headline run
    "date_from": null, "date_to": null, "people": []
  },
  "certificate": {                   // proof the query is answerable, written at generation time
    "solvable": true,
    "signals": ["vector"],           // which lanes can reach every target at configured lane depth
    "dup_siblings": 0,
    "planted_distractors": 0,
    "lexical_overlap": 0.0           // Jaccard over stemmed content lexemes, query vs target body
  },
  "diagnostics": {                   // for the failure taxonomy only; never reaches the engine
    "distractor_ids": [41733, 41734],
    "difficulty": 2
  }
}
```

Hard rule: `engine.mjs` receives `{ text, filters }` and nothing else.
`certificate` and `diagnostics` exist so `bench-recall.mjs` can explain failures, and `bench-recall.mjs` must never pass them into retrieval.
`tests/engine.test.mjs` asserts the `retrieve` signature cannot see them.

### 3.3 Ground truth

Ground truth is the `targets` array; there is no separate qrels file.
`gen-corpus.mjs` writes three files per tier into `.out/<tier>/`:

- `memories.jsonl`
- `queries-dev.jsonl`
- `queries-test.jsonl`
- `queries-multi.jsonl` (`corpus.multiTargetCount` queries with 2-3 targets; reported separately, never in the headline -- section 5)
- `oracle.json` (section 4.3)

At the 10M tier no memory JSONL is written at all: `load.mjs --stream` pulls straight from `generateMemories()` into `COPY`, saving roughly 4 GB of scratch disk.
Determinism is identical either way because both paths consume the same generator.

### 3.4 Config shape (`config.mjs`)

```js
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
    familyMix: { paraphrase_nolex: 0.20, rare_token: 0.15, entity_swap: 0.15,
                 near_dup: 0.15, date_filter: 0.15, partial_ref: 0.10, typo_noisy: 0.10 },
    // Big enough to actually crowd a top-10. A group of 3-8 cannot: siblings plus
    // the target still fit in ten slots, so merely finding the group would score.
    // Large groups stay solvable through the planted `distinguisher` (section 4.2).
    dupGroupSize: [12, 20],
    clusters: 400,                 // topic clusters at 50K; scaled to 20_000 at 10M
    multiTargetShare: 0.0,         // headline test split is single-target on purpose (section 5)
    multiTargetCount: 300,         // separate reported set -> queries-multi.jsonl
  },

  lanes: {
    // Per tier: the quality tier can afford depth, the scale tier cannot.
    // These are the knobs that decide whether ~5 ms of CPU per query is enough,
    // so the scale values are priced for recall cost at the 1M rung (rung 3).
    quality: { depth: 100, efSearch: 100, ivfProbes: 12 },
    scale:   { depth: 30,  efSearch: 40,  ivfProbes: 8  },
    rrfK: { and: 60, or: 60, vector: 60, trigram: 60 },
    trigramThreshold: 0.3,
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
    paraphraseBoost: { vector: 1.6, or: 0.8, and: 0.3 },
    typoBoost:       { trigram: 1.5, and: 0.2 },
    entityBoost:     { and: 1.3 },
    rareIdfFloor: 9.5,             // ln(N/df); calibrated on the dev split only
    oovRatioFloor: 0.34,           // share of query terms absent from the corpus vocabulary
  },

  rerank: {
    topK: 50,                      // candidates handed to the reranker
    weights: { lexical: 0.9, cosine: 1.0, entity: 1.4, recency: 0.2,
               dateFit: 1.6, rareHit: 2.0, dupPenalty: -0.7, titleHit: 0.5 },
  },

  load: {
    mode: "open", offeredQps: 2400, durationSec: 120, warmupSec: 60,
    closedLoopSweep: [8, 16, 32, 64, 96, 128, 192],
    distinctQueries: 200_000,
    latencyBudgetMs: { p50: 41 },
  },
};
```

### 3.5 Database schema

Two shapes, one file (`infra/schema.sql`, parameterized by `\set tier`).

**Real-vector tiers (`smoke1k`, `quality50k`):**

```sql
create table :schema.memories (
  id            bigint primary key,
  kind          text not null,
  title         text not null,
  body          text not null,
  raw           text not null,
  people        text[] not null default '{}',
  places        text[] not null default '{}',
  tags          text[] not null default '{}',
  occurred_at   timestamptz not null,
  cluster_id    int not null,
  dup_group     int,
  rare_token    text,
  embedding     vector(768),
  fts tsvector generated always as (
      setweight(to_tsvector('english', title), 'A')
   || setweight(to_tsvector('english', raw),   'B')
   || setweight(to_tsvector('english', body),  'C')
  ) stored
);

create index on :schema.memories using gin (fts);
create index on :schema.memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 200);
create index on :schema.memories using gin (people array_ops);
create index on :schema.memories using gin (tags   array_ops);
create index on :schema.memories (occurred_at);
create index on :schema.memories using gin ((title || ' ' || body) gin_trgm_ops);
```

The weighted `fts` deliberately mirrors `scripts/schema.sql` (title A, raw B, body C) so what the bench learns transfers to the real recall path.

**Synthetic-vector tiers (`rehearsal1m`, `full10m`):**

```sql
create unlogged table :schema.memories (   -- unlogged: disposable, and it skips WAL
  id          bigint primary key,
  body        text not null,
  kind_id     smallint not null,
  person_id   smallint not null,
  place_id    smallint not null,
  occurred_at date not null,               -- date, not timestamptz: 4 bytes x 10M
  cluster_id  int not null,
  embedding   halfvec(256)
);

-- fts is an EXPRESSION index, not a stored column: saves ~3 GB of heap at 10M.
-- Every lane query must use the identical expression or the index is not used.
create index on :schema.memories using gin (to_tsvector('english', body));
create index on :schema.memories using hnsw (embedding halfvec_cosine_ops)
  with (m = 16, ef_construction = 128);
create index on :schema.memories (occurred_at);
create index on :schema.memories (person_id, occurred_at);
```

**Disk budget at 10M** (measured against `pg_total_relation_size` at the 1M rehearsal, then multiplied by 10):

| Object | Estimate |
| --- | --- |
| heap (~784 B/row, no TOAST: 520 B halfvec stays inline) | 8.0 GB |
| GIN on `to_tsvector(body)` | ~2.0 GB |
| HNSW on `halfvec(256)`, m=16 | ~7.0 GB |
| btree x 3 | ~0.7 GB |
| **total** | **~17.7 GB** |

That leaves headroom inside the 35 GB ceiling for the 1M rehearsal schema (~1.8 GB) to coexist and for index-build temp files.
`load.mjs` prints `pg_total_relation_size` after every build and `bench-load.mjs` refuses to start if the total exceeds 30 GB.

### 3.6 Function signatures

```js
// lib/safety.mjs
export function assertBenchTarget(connectionString: string): void;   // throws on anything but the allowlist
export function benchClient(): pg.Client;                            // calls assertBenchTarget first
export function benchPool(size: number): pg.Pool;

// lib/rng.mjs -- xoshiro128** over an FNV-1a seed hash
export function makeRng(seed: string): Rng;
// Rng: { u32(), float(), int(lo, hi), pick(arr), sample(arr, n), shuffle(arr), gauss(), fork(label): Rng }
// fork() gives each field its own stream, so adding a field never shifts what
// earlier fields produced -- that is what keeps a seed stable across edits.
export function hashString(s: string): number;

// lib/synth-vectors.mjs -- deterministic, no model, no I/O
export function clusterCentroid(clusterId: number, dims: number): Float32Array;
export function memoryVector(id: number, clusterId: number, dims: number, jitter: number): Float32Array;
export function queryVector(targetId: number, clusterId: number, dims: number, drift: number): Float32Array;
export function toHalfvecLiteral(v: Float32Array): string;

// gen-corpus.mjs
export function* generateMemories(tier: TierConfig): Iterable<MemoryRecord>;
export function buildMemoryIndex(memories: MemoryRecord[]): MemoryIndex;
export function generateQueries(tier: TierConfig, split: "dev"|"test", index: MemoryIndex): QueryRecord[];
export function certifyQuery(q: QueryRecord, index: MemoryIndex, tier: TierConfig): Certificate;
export function oracleCeiling(queries: QueryRecord[], index: MemoryIndex, tier: TierConfig): OracleReport;

// load.mjs
export async function createSchema(client, tier): Promise<void>;
export async function copyMemories(client, tier, source: Iterable<MemoryRecord>): Promise<{ rows, ms }>;
export async function embedMemories(client, tier, opts: { batchSize, checkpointEvery, onProgress }): Promise<{ embedded, ms }>;
export async function cacheQueryVectors(queries, cachePath: string, opts: { batchSize }): Promise<{ cached, ms }>;
export async function buildIndexes(client, tier, opts: { vectorIndex: "hnsw"|"ivfflat" }): Promise<BuildReport>;

// engine.mjs
export function parseQueryFeatures(text: string, vocab: Vocab, cfg): QueryFeatures;
export function laneWeights(features: QueryFeatures, profile, cfg): { and, or, vector, trigram };
export function buildRetrievalSql(tier, profile): { name: string, text: string, paramCount: number };
export async function retrieve(client, query: { text: string, filters?: Filters }, ctx: EngineContext): Promise<RetrievalResult>;
// EngineContext = { tier, profile, vocab, cfg, queryVector: Float32Array|number[], rerank?: RerankFn }
// RetrievalResult = { hits: Candidate[], lanes: Record<string, number[]>, timings: { sqlMs, rerankMs, totalMs } }
// Candidate = { id, laneRanks, rrf, rerankScore, features: RerankFeatures }

// rerank.mjs
export function rerankFeatures(qf: QueryFeatures, candidate): RerankFeatures;
export function rerankScore(f: RerankFeatures, weights): number;
export function rerank(qf: QueryFeatures, candidates: Candidate[], cfg): Candidate[];
```

`QueryFeatures`:

```js
{
  raw, terms: string[], stems: string[],
  maxIdf: number, meanIdf: number,
  rareTerms: string[],                 // stems with idf >= weighting.rareIdfFloor
  oovRatio: number,                    // share of stems absent from the corpus vocabulary
  entities: { people: string[], places: string[] },
  dateRange: { from: string|null, to: string|null },
  quoted: string[],                    // spans inside double quotes
  looksParaphrase: boolean,            // long, low maxIdf, no entities
  typoSuspect: boolean                 // oovRatio >= weighting.oovRatioFloor
}
```

**The date parser is closed-world and must stay that way.**
It recognizes exactly the finite template list `lib/lexicon.mjs` emits: `in <Month> <Year>`, `in <Year>`, `last <Month>`, `that <Season> of <Year>`, `around <Month>`, `before/after <Year>`, plus the bare month names.
It is not a general natural-language date parser and no agent should build one.
`tests/engine.test.mjs` enumerates every generator template and asserts the parser resolves each one, which is the entire contract.

### 3.7 CLIs

```
infra/pg-up.sh   [--tier <name>] [--recreate]
infra/pg-down.sh [--keep-data]
infra/psql.sh    <sql or -f file>

node gen-corpus.mjs   --tier quality50k [--split both] [--out .out/quality50k] [--verify]
node load.mjs         --tier quality50k [--stream] [--skip-embed] [--vector-index hnsw|ivfflat] [--resume]
node bench-recall.mjs --tier quality50k --profile tuned --split test
                      [--ablation] [--limit N] [--out .out/recall-tuned-test.json] [--taxonomy]
node bench-load.mjs   --tier full10m --profile tunedScale
                      [--mode open|closed|select1] [--offered-qps 2400] [--duration 120]
                      [--warmup 60] [--connections 96] [--sweep 8,16,32,64,96,128,192]
                      [--in-container] [--out .out/load-10m.json]
```

Every script prints the resolved connection target and the tier schema on line one, so a wrong target is visible before anything runs.

---

## 4. Corpus design

### 4.1 The difficulty mix, and why each family is there

The mix exists to put a defensible naive baseline in the 60-80% band while leaving real, earnable headroom above it.
Each family is chosen because it breaks a *specific* lane, so improving it requires a *specific* mechanism rather than general luck.

| Family | Share | What it plants | Which lane it breaks | Which mechanism earns it back |
| --- | --- | --- | --- | --- |
| `paraphrase_nolex` | 23% | Query drawn from the topic's **paraphrase vocabulary**, which shares no stems with the memory vocabulary. Jaccard overlap is asserted to be 0. | FTS AND returns nothing; OR returns noise | Vector lane, up-weighted when `looksParaphrase` |
| `rare_token` | 22% | A globally unique token (`kbz-4417`, an odd surname, a one-off product name) present in exactly one memory | Vector lane: a rare token barely moves a 768-dim sentence embedding, so cosine ranks topical neighbors above the exact match | AND lane up-weighted on high `maxIdf`, plus the `rareHit` rerank feature |
| `entity_swap` | 11% | 2-4 memories identical in topic and phrasing, differing only in the person or place | Vector lane: near-identical sentences, cosine cannot separate them | Entity extraction + `entity` rerank feature + AND-lane boost |
| `near_dup` | 15% | A `dup_group` of 4-8 near-identical memories; only one carries the `distinguisher` the query mentions | Both lexical and vector: the siblings crowd the top 10 | `dupPenalty` rerank feature (demote later members of an already-represented group) + the distinguisher term |
| `date_filter` | 15% | The same recurring event across 4-6 years; the query names one year or month, alongside three planted terms | Every lane without metadata: all years look identical | Closed-world date parsing -> `occurred_at` range filter + `dateFit` rerank feature |
| `partial_ref` | 7% | A half-remembered reference: one true detail plus vague framing ("the thing I said about the kitchen after we moved") | AND lane (too few matching terms) | OR lane with a fragment bar, fused with vector |
| `typo_noisy` | 7% | 1-2 character-level corruptions on the discriminating term | AND lane returns nothing; OR lane returns noise | Trigram lane, activated when `oovRatio` crosses the floor |

The projected naive score, family by family (vector-only top-10 over the full corpus): 0.20 x 0.95 + 0.15 x 0.35 + 0.15 x 0.50 + 0.15 x 0.55 + 0.15 x 0.45 + 0.10 x 0.80 + 0.10 x 0.60 = **~0.61**.
That is a projection, not a result.
The calibration procedure in 4.4 is what turns it into a number, and the mix is allowed to move only inside that procedure.

**Measured at the 1K smoke tier (2026-08-23), the projection is optimistic about how badly a modern embedder does.**
Naive came in at 0.880, with the per-family vector-only numbers landing well above their projections for the families whose lane the vector was supposed to break -- `rare_token` 1.000 against 0.35, `entity_swap` 1.000 against 0.50.
The `entity_swap` result was checked rather than assumed: its group members now render byte-identical prose apart from the swapped entity, and cosine still ranks the queried name first, so a name token dominates 350 characters of otherwise identical text.
There is also an arithmetic floor under naive that no dial reaches.
`paraphrase_nolex` is 20% of the mix and the vector lane is its only lane, so the 0.97 ceiling gate forces its vector recall to ~0.97 and it contributes ~0.194 to naive unconditionally; naive <= 0.85 therefore requires the other 80% to average <= 0.82, and measured they average 0.89.
Two resolutions exist and both change a frozen contract, so neither is taken here: shift the mix away from `paraphrase_nolex` toward the families a non-vector lane solves (4.4's own prescription, but it invalidates the projections above), or accept that the smoke band was set against a projection the real embedder disproves and re-check the band at 50K, where competitor density is 50x higher.

#### 4.1.1 The 2026-08-24 calibration: which dials moved naive, and which did not

The 50K corpus first measured naive at 0.530, well under the 0.60-0.80 gate, and the obvious dials turned out to be the wrong ones.
Every number below is measured against the loaded 50K corpus, holding targets fixed and varying one thing.

**The three crowding dials were inert, and the measurement says why.**
The way to see it is to rank the target with its own confusion set excluded, which separates "the group crowds the target" from "the group was never in the top 10 to crowd anything".

| Crowding dial | Recall@10 with the group excluded | Measured with the group present | Read |
| --- | --- | --- | --- |
| `near_dup` group of 12-20 | 0.413 | 0.427 | siblings cost ~0; the group was unreachable |
| `entity_swap` 2-4 members | 0.540 | 0.520 | shrinking to 2-3 buys 0.007 |
| `date_filter` 4-6 years | 0.073 | 0.053 | shrinking to 3-4 buys 0.005 |

**The dial that binds is vocabulary density.**
50,000 memories share 32 topics, and a topic's `concreteNouns` pool is 7 words wide, so ~1,560 memories draw padding sentences from the same seven nouns.
A query naming two of them addresses thousands of unrelated filler memories, and the vector lane never finds the confusion set at all -- not because the family's planted mechanism is hard, but because the corpus vocabulary is too dense to address.
`buildMultiTargetCase` had already hit this and already moved to `DETAIL_WORDS` for exactly this reason.

Rarity alone was not the fix, though, and that took two measurements to learn.
A two-term query built from a cross-topic noun plus a rare detail word scored **0.100**; the same query with a third term scored **0.544**.
One common noun still addresses every filler memory that uses it as padding, so the combination has to be specific, not merely rare in one of its halves.

| Dial | Before -> after | Measured |
| --- | --- | --- |
| `date_filter` planted terms | 2 topic nouns -> topic noun + cross-topic noun + detail word | external Recall@10 0.100 (2 terms) -> 0.544 (3 terms) |
| `near_dup` planted terms | 3 topic nouns -> topic noun + cross-topic noun + detail word | external Recall@10 0.413 -> 0.810 |
| `near_dup` group size | 12-20 -> 4-8 | only live *after* the terms got rare: 0.810 external against 0.427 measured meant the siblings then cost 0.38 |
| `partial_ref` vague filler words | 3 -> 1 | 0.283 -> 0.317 (2 words) -> 0.333 (1 word) -> 0.375 (0 words) |
| family mix | see `config.corpus.familyMix` | arithmetic on the measured per-family values |

Two dials were deliberately left alone after being measured inert: `entity_swap`'s 2-4 members and `date_filter`'s 4-6 years.
Changing either would move naive by under a point while making the table above disagree with the code, which is a worse trade than leaving a dial where the design put it.

One dial the measurements argued *against* changing: `partial_ref`'s noun.
Moving it to a cross-topic noun scored 0.133, worse than the 0.230 it already had, because a two-term query does not discriminate however rare its terms are.

**The mix shift, and why it runs opposite to 4.4's prescription.**
4.4 says to shift weight toward `rare_token`, `typo_noisy` and `paraphrase_nolex` to bring naive *down*, on the projection that `rare_token`'s vector recall is 0.35.
Measured it is 0.920, so the same knob moves naive *up*, and weight moves toward those families to raise naive rather than lower it.
`rare_token` takes the largest increase because its verified oracle is 1.000, so the shift cannot cost the 0.97 ceiling; `paraphrase_nolex` moves only 3 points because it is the family whose oracle depends on the repair loop converging.

### 4.2 The solvability certificate

An unanswerable query silently caps the benchmark's ceiling and no amount of engine work recovers it.
Every generated query must therefore carry a certificate, and `gen-corpus.mjs` **throws** rather than emitting one that fails:

1. **At least one planted signal.** Every query carries at least one of: a distinguishing token present in the target and absent from its distractors, a resolvable date constraint, or a named entity unique to the target within its confusion set.
2. **Best-lane rank.** At least one lane ranks the target at position 10 or better, measured offline by brute force: the AND/OR/trigram lanes by direct lexeme scoring against the in-memory index, the vector lane by exact cosine over the whole corpus (cheap at 50K, and exact, so it is a true statement about the lane rather than a guess about the index). This *is* the solvability test, and it is what 4.3 aggregates.
3. **Lane reachability at depth.** At the configured lane depth, at least one lane retrieves every target. This is the weaker companion to rule 2, kept because the `not_retrieved` failure bucket is defined against it.
4. **Lexical-overlap truth.** For `paraphrase_nolex`, the measured stem Jaccard is asserted to be exactly 0. The family name has to be literally true or the family is not testing what it claims.

There is deliberately no separate crowding bound on `dup_group` size.
An earlier draft capped siblings so a target could always fit in a top-10 alongside them, which made `near_dup` an easy family: merely finding the group would score.
Rule 2 replaces it and does the job properly, because a target buried under fifteen siblings fails best-lane rank unless the planted `distinguisher` gives some lane a way to separate it.

### 4.3 The oracle ceiling

`gen-corpus.mjs --verify` writes `oracle.json` with two numbers, overall and per family.

**The gate number is best-lane-rank@10: the fraction of queries whose target is ranked 10 or better by at least one lane in isolation.**
This is what an ideal fusion could achieve if it always picked the right lane, and it can genuinely come in at 0.88 and stop the ladder.

The second number is depth-100 reachability -- the fraction of queries where some lane surfaces the target anywhere in its candidate list.
That one is reported as a weaker diagnostic and is **not** a gate, because certificate rule 3 guarantees it, so gating on it would be gating on a tautology.

#### The date-constrained families are scored with their date applied (added 2026-08-24)

Certificate rule 1 lists "a resolvable date constraint" as a planted signal on equal footing with a distinguishing token and a unique entity, and rule 2 asks whether *some lane* reaches the target.
For a family that plants a date, those two only agree if lane reachability is measured with the date applied, so `date_filter` queries are scored that way.

This is a definition fix, not a loosening, because the engine genuinely carries the mechanism end to end: the closed-world parser (section 3.6, its templates enumerated by `tests/recall-bench-*.test.mjs`) resolves the range out of the query text, and section 6.1 pushes that range into every lane's own `WHERE` clause rather than applying it after fusion.
Scoring the lanes without it measures the corpus against a question the engine answers.
The filter is bound half-open, `[from, to)`, matching `engine.mjs`'s `m.occurred_at <@ q.span`; a different inclusivity would certify a filter the engine does not have.

Only families that plant a date get one -- `declared_filters` carries a closed range only where a builder set it -- and `oracle.json` reports the filtered and unfiltered numbers side by side under `overall`/`perFamily` and `unfiltered`, so the mechanism's worth is visible rather than asserted.
Measured at 50K: 1.0000 filtered against 0.9965 unfiltered overall, and 1.000 against 0.977 for `date_filter` itself.

**Gate: best-lane-rank@10 >= 0.97 at the 1K smoke tier and again at 50K.**
Below that, the corpus is too hard for the claim and the mix must be loosened *before* any engine tuning happens -- which is allowed, because at that point no tuned number exists to steer toward.

#### 4.3.1 Vector certification is post-load, and why (added 2026-08-23, after the rung-1 smoke run)

The vector lane cannot be certified at generation time, and the first smoke run proved that the hard way.

`gen-corpus.mjs` runs before any embedding exists, so its original implementation certified the vector lane against `lib/synth-vectors.mjs` proxy vectors and said so in a comment.
Measured against the real embedder (`scripts/lib/embeddings.mjs`, nomic-embed-text-v1.5), the proxy was not merely imprecise, it was inverted: it certified every `paraphrase_nolex` query at rank 1 while the real model ranked those same targets around 500th.
The harness reported an oracle ceiling of 1.0 for a corpus whose real ceiling was 0.765, and a gate that cannot fail is not a gate.

So certification is split by what each half can actually prove:

- **Offline, in `gen-corpus.mjs`.** The lexical lanes only, and as a rank *ceiling* rather than a rank -- the largest position the target can hold under any tie-break Postgres might apply. AND reports its match-set size; OR counts rows matching at least as many query lexemes as the target; trigram brackets `word_similarity` between a lower bound from one concrete extent and an upper bound from the best window's trigram overlap. A ceiling of 10 or better is a true statement about the lane, where the earlier code's guess at `ts_rank_cd`'s ordering was not. `oracle.json` written here carries `vector.verified: false`.
- **Post-load, in `load.mjs --verify-oracle`.** Every lane's real rank against the corpus that was actually loaded and actually embedded, with the vector lane measured as an exact cosine rank in SQL rather than the HNSW lane's approximate one -- rule 2 above asks for a statement about the lane, not about the index, and a count over a distance comparison cannot use the index. This rewrites `oracle.json` with `vector.verified: true` and keeps the offline numbers alongside under `provisionalOffline` so the two can be compared rather than one silently replacing the other.

**The authoritative oracle is the verified file.** `bench-recall.mjs` prints `oracle.overall.bestLaneRankAt10` in its headline table, and that key means the post-load number once verify has run.

`--verify-oracle` also runs a bounded repair loop (`config.oracle.repairRounds`).
A query no lane reaches is re-verbalized against the *same* target from a seeded sub-stream, re-embedded in place, and re-measured.
Repair is text-only by construction: the query-vector cache's offsets are derived from the dev and test file lengths, so adding or removing a query would shift every offset after it.
Repair belongs before the freeze in 4.4 step 6, and `CORPUS.lock` now hashes the query files as well as `memories.jsonl` so that ordering is checkable rather than a convention.
Re-verbalizing alone could not converge 54 `paraphrase_nolex` and 8 `entity_swap` queries at 50K, because it only rephrases a query around the *same* target and a target that is unreachable however it is worded has nothing left to try.
So the loop escalates to **re-targeting** (`config.oracle.retargetAttempts`): it picks a different memory for the query to be about and regenerates the query against it, from a forked seeded sub-stream, bounded at 4 re-verbalizations x 5 re-targets.
`entity_swap` and `date_filter` move to another member of their own confusion set, and the old target becomes a distractor so `declared_filters` and the `crowded_by_dups` taxonomy bucket keep describing the query.
`paraphrase_nolex` has no confusion set to move inside, so its candidate pool is other paraphrase targets *within the same split* whose own query the oracle already reaches -- the strongest available evidence that a fresh query off that frame will rank that memory -- with each memory claimed at most once.
`near_dup` is deliberately refused: its distinguisher lives in the target's body, so re-targeting it would mean rewriting a memory that is already embedded and loaded, which the post-load boundary forbids.
The checkpoint's identity therefore covers the target as well as the text, or a resumed run could score ranks measured against a memory the query no longer points at.

A family that will not converge inside the bound is reported as a finding, not looped on.

### 4.4 Calibration procedure, with the freeze point marked

The task asks for a corpus hard enough that naive lands at 60-80% and a tuned system that reaches 91%.
Those pull against each other, and if the mix is adjusted while watching the *tuned* number, the 91% is manufactured rather than measured.
The ordering below is what keeps it honest, and it is a procedure, not a principle:

1. Generate at the 1K smoke tier with the mix in `config.corpus.familyMix`.
2. Compute best-lane-rank@10. If it is below 0.97, loosen the mix (smaller dup groups, fewer distractors, stronger distinguishers) and go to 1.
3. Measure the **`naive` profile only**. Vector-only top-10 has zero tunables, so watching it cannot leak into the tuned system.
4. If naive is outside 0.60-0.80, adjust the family mix and go to 1.
5. Generate the 50K corpus and confirm naive stays in band there. Adjust and repeat if it does not.
6. **FREEZE.** Write `.out/quality50k/CORPUS.lock` containing the seed strings, the family mix, the config hash, and the SHA-256 of `memories.jsonl`. From here the corpus is immutable.
7. Develop and tune the engine against `queries-dev.jsonl` **only**. Any number of runs is fine.
8. Run `queries-test.jsonl` **once per candidate configuration** and report that number as the headline.
9. `bench-recall.mjs` refuses to run the test split unless `CORPUS.lock` exists and its hash matches, and it appends every test-split run to `.out/quality50k/TEST-RUNS.log` with a timestamp and the config hash. The log is the audit trail: if the headline came from the fortieth test-split run, that is visible.

Which knob to turn, so the corpus track does not flail between steps 2 and 4.
The families where a *non-vector* lane is the solver -- `rare_token`, `typo_noisy`, `paraphrase_nolex` -- lower the naive score without lowering the ceiling, because the ceiling is best-lane rank and their solving lane is unaffected.
`near_dup` and `date_filter` lower both at once, since crowding and year-collisions hurt every lane including the one that would have solved the query.
So: shift weight toward the first group to bring naive down into the band, and hold the second group steady to protect the ceiling.

Any change to the corpus after step 6 invalidates the claim and requires a new lock file and a new lock version.

---

## 5. The metric, defined once

**Recall@10 = the fraction of test queries whose target appears in the top 10 returned hits.**

The headline 1,000-query test split is **single-target by construction** (`multiTargetShare: 0.0`), which makes that definition unambiguous.
This is a deliberate choice: with 1-3 targets per query, "Recall@10" can mean per-query fractional recall, or "any target in the top 10" (a materially weaker claim), and a claim that has to be literally true cannot rest on which one a reader assumes.

A separate `corpus.multiTargetCount` (300) multi-target set is generated into `queries-multi.jsonl` and reported alongside, using macro-averaged per-query recall -- `mean over queries of |top10 intersect targets| / |targets|` -- and labeled as such.
It never enters the headline number.

Reported alongside the headline, always:

- Recall@1, Recall@5, Recall@10, MRR@10
- Per-family Recall@10, so a single family carrying the result is visible
- 95% bootstrap confidence interval over queries (10,000 resamples). At n=1000 and p=0.91, the interval is roughly +/- 1.8 points, so **0.91 is claimed only when the lower bound also clears 0.91**.
- The oracle ceiling, on the same table, so the reader can see how much headroom was left

### 5.1 The ablation ladder

`bench-recall.mjs --ablation` runs the same test split through each rung and prints one table.
The claim is not "the tuned system is better"; it is "here is where each point came from".

| Rung | Configuration |
| --- | --- |
| 0 | `naive`: vector-only, top 10 by cosine |
| 1 | `fixedRrf`: AND + OR + vector, equal weights, standard RRF, no filters, no rerank |
| 2 | rung 1 + query-dependent lane weights |
| 3 | rung 2 + trigram lane |
| 4 | rung 3 + metadata filters inferred from the query |
| 5 | rung 4 + rerank = **`tuned`** |

### 5.2 Failure taxonomy

For every query the tuned profile misses, `--taxonomy` assigns exactly one cause, using `diagnostics` and the per-lane rank data the engine returns:

- `not_retrieved` -- no lane surfaced the target at the configured lane depth (a generator bug, since the certificate promised otherwise; this bucket should be empty and a non-zero count fails the run)
- `lost_in_fusion` -- some lane had it, fused rank > 10
- `lost_in_rerank` -- top 10 before rerank, outside after
- `crowded_by_dups` -- 3 or more members of the target's `dup_group` ranked above it
- `entity_confusion` -- half or more of the top 10 are the query's known `distractor_ids`
- `filter_excluded` -- an inferred metadata filter removed the target (the most dangerous bucket: a filter that helps on average can still destroy individual queries)
- `date_misparse` -- the closed-world parser produced a range the target falls outside

---

## 6. The engine

### 6.1 One round trip

All lanes, fusion, and filtering happen in a **single prepared statement** per query that returns the top 50 with rerank features attached; `rerank.mjs` then scores those 50 in Node.
This is not a micro-optimization -- at 2,400 QPS a second round trip per query is a second 2,400 QPS of network and backend work, and the claim does not survive it.

Sketch (quality tier; the XL tier is the same shape with `to_tsvector('english', body)` in place of the `fts` column and `halfvec` in place of `vector`):

```sql
with q as (select $1::text as raw, $2::tsquery as andq, $3::tsquery as orq,
                  $4::vector as vec, $5::daterange as span, $6::text[] as people),
and_lane as (
  select m.id, row_number() over (order by ts_rank_cd(m.fts, q.andq) desc, m.id) as rnk
  from memories m, q
  where m.fts @@ q.andq
    and (q.span is null or m.occurred_at <@ q.span)
    and (cardinality(q.people) = 0 or m.people && q.people)
  order by ts_rank_cd(m.fts, q.andq) desc, m.id limit $7),
or_lane as ( ... same shape with q.orq and a fragment bar ... ),
vec_lane as (
  select m.id, row_number() over (order by m.embedding <=> q.vec) as rnk
  from memories m, q
  where m.embedding is not null
    and (q.span is null or m.occurred_at <@ q.span)
  order by m.embedding <=> q.vec limit $7),
trg_lane as ( ... word_similarity over title || ' ' || body, gated by $11 ... ),
fused as (
  select id,
         sum(w) as rrf,
         jsonb_object_agg(lane, rnk) as lane_ranks
  from (
    select id, rnk, 'and' as lane, $8::float / (60 + rnk) as w from and_lane
    union all select id, rnk, 'or',     $9::float  / (60 + rnk) from or_lane
    union all select id, rnk, 'vector', $10::float / (60 + rnk) from vec_lane
    union all select id, rnk, 'trigram',$11::float / (60 + rnk) from trg_lane
  ) all_lanes group by id),
-- Cut to 50 BEFORE touching the heap. `fused` holds up to 4 x depth deduped ids;
-- joining `memories` ahead of the limit would fetch every one of them. At 2,400 QPS
-- that is roughly 960K random page accesses per second instead of 120K, and the
-- planner is not reliably going to push the limit down for you.
top as (select id, rrf, lane_ranks from fused order by rrf desc, id limit 50)
select t.id, t.rrf, t.lane_ranks,
       1 - (m.embedding <=> q.vec)              as cosine,
       ts_rank_cd(m.fts, q.orq)                 as lexical,
       m.people, m.tags, m.occurred_at, m.dup_group, m.rare_token,
       (m.rare_token is not null and m.rare_token = any($12::text[])) as rare_hit,
       (m.title ilike any($13::text[]))         as title_hit
from top t join memories m on m.id = t.id, q
order by t.rrf desc, t.id;
```

The `daterange` filter is pushed into every lane rather than applied afterward.
Filtering after fusion is the classic ANN mistake: the top 100 vector neighbours can be entirely outside the date range, leaving nothing to filter.

Vector filtering interacts with HNSW, and pgvector handles it by over-fetching internally.
`hnsw.ef_search` is raised to 200 when a filter is present so a selective filter does not starve the lane.
The 1M rehearsal measures whether that is enough, and if a filtered vector lane returns fewer than 30 rows more than 1% of the time, the fallback is an iterative scan (`hnsw.iterative_scan = relaxed_order`), measured, not assumed.

### 6.2 The lanes

- **AND lane.** `websearch_to_tsquery`: every term must appear. High precision. Carries `rare_token` and entity queries.
- **OR lane.** `to_tsquery` with `|`, gated by the same fragment bar `scripts/recall.mjs` uses: a row counts only when it holds at least `min(2, terms)` of the query's lexemes, because one shared word inside a long body is corpus noise, not a fragment.
- **Vector lane.** Cosine over the embedding. 768-dim real at the quality tier, 256-dim halfvec at scale.
- **Trigram lane. Quality tier only.** `word_similarity` over `title || ' ' || body`, gated by `trigramThreshold`. Within the quality tier it is switched on by weight, not by branching, so the SQL plan stays identical across queries (a weight of 0 zeroes the lane's contribution while keeping one prepared statement for the whole workload).

  The scale tier has no trigram index and no trigram lane, and the `tunedScale` profile omits it (section 3.4). A `gin_trgm_ops` index over 10M x 200 chars would cost another 5-8 GB and break the disk budget, and without the index the lane would sequential-scan 10M rows on every typo query. Claim B's wording -- GIN full-text, ANN, metadata filters, rerank -- does not include it, so the scale tier is honestly a three-lane system and the report says so.

### 6.3 Query-dependent lane weighting

This is the mechanism that separates rung 2 from rung 1, and it is deliberately a small set of legible rules rather than a learned model -- with 1,000 dev queries, anything with many parameters would fit noise.

```
w = clone(weighting.base)
if maxIdf >= rareIdfFloor:        w.and += 1.8;  w.trigram += 0.2
if looksParaphrase:               w.vector += 1.6; w.or += 0.8; w.and -= 0.7
if typoSuspect:                   w.trigram += 1.5; w.and -= 0.8
if entities.people.length > 0:    w.and += 1.3
if dateRange resolved:            w.vector += 0.2      // text lanes lose discrimination once
                                                       // the filter has already cut the year
clamp every weight to [0, 3]
```

Seven dials, tuned on the dev split, reported on the test split.
`tests/engine.test.mjs` pins each rule to a fixture query so the rules stay readable and a change that silently inverts one fails a test.

### 6.4 Metadata filters

Filters are **inferred from the query text by default**, not handed to the engine.
That is the harder and more honest setting: a real user types "what did we do with Minh in March 2024", they do not pass a `daterange`.
`declared_filters` on the query record exists so an API caller can pass them explicitly, and `bench-recall.mjs --declared-filters` runs that as an ablation showing how much the inference costs.

The parser is closed-world (section 3.6).

### 6.5 The rerank stage

**The rerank is a feature-based scorer, not a cross-encoder, and the doc says so plainly.**
The measured embedder does ~50 texts/sec on this machine; a neural cross-encoder over 50 candidates x 2,400 queries/sec is off by five orders of magnitude, so any claim built on one would be fiction.
What runs is a linear scorer over features already returned by the retrieval statement:

```
score = 0.9*lexical_norm + 1.0*cosine + 1.4*entity_match + 0.2*recency_decay
      + 1.6*date_fit + 2.0*rare_hit + 0.5*title_hit - 0.7*dup_penalty
```

- `dup_penalty` grows with how many members of the same `dup_group` already sit above the candidate -- that is the mechanism that unblocks the `near_dup` family.
- `rare_hit` is binary and heavily weighted: an exact rare-token match is close to proof.
- `date_fit` is 1 inside the parsed range, decaying outside, so a misparsed date degrades instead of destroying.
- Cost per query: 50 candidates x 8 features of float arithmetic, on the order of tens of microseconds. It is not the bottleneck at 2,400 QPS and the load bench proves that by reporting `rerankMs` separately.

Weights are fit on the dev split by coordinate descent over a small grid, and the fitted vector is written into `config.rerank.weights` and committed, so the reported run is reproducible from the repo alone.

### 6.6 ADDENDUM (2026-08-24): the scale path is candidate-bounded, and this is what it costs

Sections 6.1 and 6.2 describe lanes that rank whatever matches.
At 50K that is fine.
At 1M it is not, and the rehearsal measured exactly how badly.

**What was measured on `bench_r1m`, before any of this landed.**

| Thing measured | Number |
| --- | --- |
| OR lane, disjunction over three common terms (`took \| watch \| work`) | 862,972 of 1,000,000 rows matched, 383 ms in the bitmap index and heap scan alone |
| OR lane, disjunction over three rare terms | 43 rows, 0.065 ms |
| 18-term AND via `websearch_to_tsquery` (GIN fast scan) | 0.375 ms |
| `to_tsvector('english', body)` recompute, per row | 11 us |
| `ts_rank_cd` over an already-materialized tsvector, per row | 1.1 us |
| Old fragment bar (`to_tsquery('english', ql)` per term per row), 500 rows x 18 terms | 4.7 ms |
| Vector lane, HNSW, `ef_search` 40, depth 30, unfiltered | 1.0-5.0 ms |
| Whole-workload result | 10-16 QPS ceiling, p50 428 ms at 3 offered QPS |

The 2,400 QPS target on 12 cores allows roughly **5 core-ms per query**.
One lane was spending seconds.
Ranking an unbounded candidate set is not a tuning problem, it is the wrong shape, so the scale tier changed shape.
The quality tier did not: rung 2's numbers are calibrated against the SQL in 6.1 and that SQL is unchanged there.

**What the scale path does instead.**

1. **Term statistics are precomputed, not sampled.**
   `lib/term-stats.mjs` writes two tables per schema after the load: `lexeme_stats(lexeme, ndoc)` for exact document frequency, and `term_stats(term, lexemes, frag, ndoc)` mapping a surface query word to the lexemes Postgres's parser really produces for it, a ready-made tsquery fragment over them, and the frequency of the rarest one.
   The engine loads both at startup.
   The surface form matters twice: anchoring picks terms by frequency and needs an exact lookup (the engine's own `stem()` is a documented approximation and disagrees with snowball often enough to make it unreliable), and spell correction matches typos against real words rather than truncated stems.
   The fragment matters because one query word is not always one lexeme -- a planted rare token like `fwz-0218` parses to `'fwz' & '-0218'`.
   Measured at 1M: 1,682 surface terms, 2,205 lexemes, 0.8 MB, 37.7 s to build.

2. **The OR lane is rare-term anchored (WAND-style), and honestly approximate.**
   The disjunction is rebuilt from only the highest-IDF query terms, added rarest first while their cumulative document frequency stays inside `lanes.scale.orAnchorDfBudget` (300), capped at `orAnchorMaxTerms` (3).
   Common terms are dropped from the lane entirely.
   That bounds the lane's match count by term rarity rather than by truncating a huge result -- the terms dropped are exactly the ones carrying no discrimination.

   **The approximation, stated plainly.** When even the rarest term in a query appears in more documents than the candidate cap, the lane cannot return a real ranked top-30 of the matches. On this corpus the cross-topic nouns the `entity_swap`, `typo_noisy` and `date_filter` families are built from sit at df ~24,000 of 1M. Running the lane there would return whichever 400 rows the heap scan reached first -- about a 1.7% chance of touching the target -- for 4.4 ms of `to_tsvector` recompute. So the lane stands down and the AND and vector lanes carry the query. This is a deliberate top-N candidate-bounded design, standard in production retrieval, and it is a real recall concession, not a free one. Every lane that stood down is visible in the load report's per-lane row counts.

3. **The AND lane runs first and caps its candidates.**
   `websearch_to_tsquery` is unchanged; a hard `LIMIT` inside the candidate CTE stops the bitmap heap scan early instead of materializing every match before ranking.
   The OR lane then runs only when the AND lane came back with fewer than `andFirstThreshold` (10) rows.
   That gate is an uncorrelated subquery, so Postgres evaluates it once as an InitPlan and hangs a One-Time Filter over the OR scan; `EXPLAIN` reports the scan as `never executed`.
   **This keeps the one-round-trip property of 6.1 intact** -- it is still a single prepared statement, not a client-side branch.

4. **The fragment bar survives, bounded and cheapened.**
   It is still `min(2, terms)`, and it is applied inside the capped candidate set.
   It now compares the query's lexemes against `tsvector_to_array(doc)` instead of parsing a fresh `to_tsquery` per query term per row.
   The corrected spelling of a typo counts toward the bar, or a query whose only recognizable word is one term would face a bar of 2 it could never clear.

5. **Typo tolerance moves to the query side.**
   6.2 ruled out a document trigram index at 10M (5-8 GB, over the disk budget), which left `typo_noisy` with no lane at scale.
   Instead, out-of-vocabulary terms are corrected against the trigram-indexed `term_stats` table inside the same statement -- a GIN trigram index on ~1,700 rows rather than 10M documents.
   Correction only fires when the share of unrecognized terms clears `weighting.oovRatioFloor`, so a query naming something the corpus does not contain is not "corrected" into something it does.
   A correction joins the OR lane only if the word it corrected *to* is itself selective, by the same rule as the anchors.

6. **The lexical rerank feature rides out of the lanes.**
   6.1's final projection recomputed `ts_rank_cd` over the top 50, which at scale is 50 more `to_tsvector` calls (~0.55 ms).
   The lanes now carry their own score into `fused`.
   One behavioural difference, scale-path only: a row that reached the top through the vector lane alone scores 0 lexically instead of whatever `ts_rank_cd` would have said.

7. **The query vector and the date range are read straight off the bind parameters**, not through the `q` CTE.
   6.1's `NOT MATERIALIZED` note exists because a materialized `q` made `embedding <=> q.vec` un-orderable by the HNSW index.
   Reading the Param directly makes each lane's plan independent of how the tsquery CTEs happen to materialize, which is the more robust form of the same fix.

8. **The filtered vector lane uses iterative scan, measured rather than assumed.**
   6.1 said `ef_search` is raised to 200 when a filter is present "so a selective filter does not starve the lane", and that the 1M rehearsal would measure whether that is enough.
   It was measured, on one three-month window over the ten-year corpus (~2.5% selective):

   | Setting | Rows returned (of 30) | Warm latency |
   | --- | --- | --- |
   | `ef_search` 200, iterative off (the design's guess) | 5 | 8.1 ms |
   | `ef_search` 40, iterative off | 0 | 0.9 ms |
   | `ef_search` 40, `iterative_scan = relaxed_order`, `max_scan_tuples` 20,000 | 30 | 21.2 ms |
   | `ef_search` 40, `iterative_scan = relaxed_order`, `max_scan_tuples` 5,000 | 30 | 3.8 ms |

   The design's number was both insufficient and expensive.
   The last row is what the scale tier now runs.
   The quality tier keeps `ef_search` 200 and no iterative scan, unchanged.

**What it bought, per family, at 1M** (one connection, mean over 10 test-split queries each, measured while another CPU-heavy job shared the machine -- so pessimistic):

| Family | Before this section | After |
| --- | --- | --- |
| typo_noisy | 11.0 ms, OR lane returning nothing | 1.7 ms, OR lane returning the corrected term |
| paraphrase_nolex | 5.7 ms | 4.4 ms |
| entity_swap | 7.1 ms | 7.0 ms |
| date_filter | 21.2 ms, vector lane returning 10.7 of 30 | 16.2 ms, vector lane returning 27.6 of 30 |
| Weighted mean | 8.4 ms | 5.6 ms |

Against the earlier whole-system state -- 10-16 QPS, p50 428 ms at 3 offered QPS -- this is a different machine.
Whether it clears 2,400 QPS is section 8's question, and section 8 answers it with the number that was measured.

---

### 6.7 ADDENDUM (2026-08-24, later the same day): where the remaining cost actually was

Section 6.6 and the rung 3 results below record a 6.94 core-ms weighted profile and conclude that clearing 2,400 QPS needs roughly 2 core-ms cut out of every query.
That conclusion was right about the size of the gap and wrong about where the gap lived.
This section records what the cost turned out to be, the three changes that removed most of it, and one change that was tried and is much worse.

Read the numbers below against a re-measured baseline, not against 6.94.
Two things changed underneath that figure.
The OR-bar fix (`perf(recall-bench): stem the OR fragment bar once per query`) landed after the per-family table was taken, which is why the table's `date_filter` reads 15.23 ms while the per-lane re-measurement immediately after it reads 10.30 ms.
And `retrieve` timed itself with `Date.now()`, quantizing single-digit-millisecond queries to whole milliseconds; it now uses `performance.now()`.
Re-measured on the same instrument, on the same query set, with none of this section's changes applied, the profile is **5.45 core-ms weighted median (5.51 mean)**, not 6.94.
The original numbers are left in place as history; the 10M no-go rests on 6.94, and 6.94 was stale by about 1.4 core-ms.

**The dominant cost was recomputing the tsvector, once per candidate row, on every query.**

DESIGN.md 3.5 gave the synthetic tiers an expression index over `to_tsvector('english', body)` and no stored column, to save heap at 10M.
That trade was made before anything measured what the recompute costs.
Measured at 1M over a fixed 400-row candidate set, on an idle box:

| Operation, 400 rows | Time |
| --- | --- |
| Read 400 bodies, no parsing | 0.195 ms |
| `to_tsvector('english', body)` over the same 400 | 4.509 ms |
| `ts_rank_cd` over an already-materialized tsvector | 0.299 ms |
| `ts_rank_cd` over a recomputed one | 4.176 ms |

So the parse is 10.4 us/row and the ranking it feeds is 0.68 us/row.
Both lexical lanes cap at 400 candidates, so a query with a full AND lane was paying about 4.3 ms to reproduce something it could have read.
The column costs 213 bytes/row: 227 MB at 1M (1,381 -> 1,608 MB), projecting to **about 16 GB at 10M against the 30 GB rung-3 footprint gate**, which the gate clears with room to spare.
The reversal is recorded in `infra/schema.sql` and `load.mjs` next to the original reasoning.

Proving it neutral was cheap and worth more than a recall number: a generated column produces the same lexemes as the expression, so both forms of the AND and OR lane were run against the same rows in the same session, and **274 of 274 lexical lanes returned identical ordered id lists**.

**The date-constrained AND lane was not paying for the `BitmapAnd` in general -- it was paying for wide ranges.**

The rung 3 results below attribute 6.52 ms marginal to a `BitmapAnd` of the `occurred_at` btree against the FTS GIN.
On a one-month window that is wrong: the date bitmap costs 0.003 ms and returns 42 rows.
On a whole-year window it is right and then some: the date bitmap costs 4.66 ms and covers 125,470 rows.
The `date_filter` family is a mix of both, which is why its per-query spread ran 6 to 16 ms while every other family was tight.

Three index shapes were priced against 14 `date_filter` queries, each inside a transaction that was rolled back, all on one connection so the comparison is same-session:

| Shape | Median | Mean |
| --- | --- | --- |
| Baseline: `occurred_at` btree x FTS GIN, `BitmapAnd` | 8.99 ms | 8.94 ms |
| **No date btree: FTS GIN alone, date as a heap recheck** | **6.46 ms** | **6.54 ms** |
| `btree_gin` multicolumn `gin (fts, occurred_at)` | 58.33 ms | 57.33 ms |
| `btree_gin` composite with the date btree also present | 58.31 ms | 57.40 ms |

**`btree_gin` is a 6.5x regression, not an improvement.**
A year-wide range makes GIN enumerate every date key in the range and merge their posting lists, which is far more work than the btree bitmap it replaces.
It is recorded here so nobody prices it again.

Removing the btree wins instead, and wins at every quantile, because the FTS conjunction is always the more selective side on this workload.
The scale tier therefore has no `occurred_at` btree; the quality tier keeps its own.
Results are unchanged: **280 of 280 test queries return identical ordered id lists**, which is the claim that matters and is a diff of the pipeline against itself.

**The vector lane is worth nothing on a query that names something unique.**

Section 6.6's gating policy asked for two query-dependent skips.
Only one of them survives contact with the corpus.

The one that works gates the *vector* lane, not a lexical one.
The ANN search costs about 3.0 ms uniformly across every family, and on a `rare_token` query the AND lane already returns exactly the target.
The trigger is the rarest query term's exact document frequency out of `term_stats`, and it separates cleanly -- measured over 60 test queries per family:

| Family | rarest term df, min / median / max |
| --- | --- |
| rare_token | 1 / 1 / 1 |
| paraphrase_nolex | 15 / 22 / 11,993 |
| near_dup | 15 / 34 / 12,694 |
| partial_ref | 37 / 59 / 75 |
| date_filter | 231 / 24,762 / 48,906 |
| entity_swap | 11,993 / 24,880 / 33,600 |
| typo_noisy | 12,098 / 36,908 / 50,060 |

A ceiling of 5 catches `rare_token` and nothing else, with the nearest other family 3x away.
The client only decides that a query has that shape; whether the lane runs is decided in SQL against the AND lane's real row count, as the same one-time InitPlan filter the OR lane already uses, so a rare-token query whose conjunction came back empty still gets its vector lane.
Measured back to back on one connection: **mix-weighted 4.16 -> 3.56 core-ms, `rare_token` 3.17 -> 0.36 ms**, with recall identical in every family -- 0.6686 overall with the gate on and 0.6686 with it off, over 700 queries, `rare_token` at 1.000 both ways.

The gate's safety is a property of the corpus, not a lucky measurement, and that is the stronger statement.
A planted rare token has document frequency 1 by construction, so the AND conjunction over every in-vocab term can match at most that one document, and `count(and_lane) >= 1` therefore *implies* the target.
The gate stops being safe the moment that stops holding -- if the rare tokens were ever planted in more than one document, or if `vectorSkipDfCeiling` were raised above the gap between `rare_token` (df 1) and the next family (df 15), the conjunction could return a non-target row and suppress the lane that would have found the right one.

**The other half of 6.6's gating policy cannot be built as specified, and this is why.**
Skipping the lexical lanes for "no-rare-term paraphrase-shaped queries" needs a signal for paraphrase shape, and `looksParaphrase` is not it.
It requires `maxIdf <= 6.0`, and measured over 60 queries per family it fires on **1 of 60 `paraphrase_nolex` queries and on 60 of 60 `entity_swap` and 60 of 60 `date_filter` queries**.
Gating on it would skip the lexical lanes for exactly the two families that depend on them and leave the paraphrase family untouched.
The threshold is miscalibrated against this corpus -- paraphrase queries carry moderately rare content words and sit at a median `maxIdf` of 10.77 -- and after the stored column landed the skip is worth about 0.2 core-ms anyway.
Recalibrating `looksParaphrase` is a quality-tier question, since that is where it also drives `paraphraseBoost`; it is not attempted here.

**`entity_swap`, priced and left alone.**
It is the second most expensive family at about 5.2 ms, and the cost is not where a depth reduction would reach it: about 2.0 ms is the GIN posting-list merge for a conjunction of two nouns that each sit at df ~24,000, about 0.7 ms is ranking, and about 3.0 ms is the vector lane.
Lane depth 30 -> 20 measures 0.16 core-ms weighted and a candidate cap of 150 measures 0.10, both inside this machine's run-to-run noise, and both spend fusion headroom to buy it.
Neither is taken.

**Where that leaves the profile.**

| | Weighted median | Weighted mean |
| --- | --- | --- |
| Re-measured baseline, same instrument, none of the above | 5.45 | 5.51 |
| After the stored tsvector column | 4.39 | 4.49 |
| After the vector-lane gate | 3.56 | 3.53 |
| Final, 20 queries per family | **3.64** | **3.67** |

The date-index change is not a separate row because its effect is confined to one family and the same-session A/B above is the honest measurement of it: `date_filter` 8.99 -> 6.46 ms.

Section 8 has the throughput this bought, and it is not the throughput this table predicts.

### 6.8 ADDENDUM (2026-08-24): the 1M vector lane finds the target 15% of the time, and every latency number above was measured against that

This is the most consequential thing measured in this session and it is not a cost finding.

**How it surfaced.** Every recall figure the scale tier has ever reported was measured by handing the engine the target's own stored `embedding` as the query vector.
`bench-load.mjs` documents that as deviation 2 in its own header -- `QueryRecord` carries no `cluster_id`, so a synthetic query vector could not be rebuilt from the query file alone -- and every probe written since inherited it.
Handing the retrieval engine the answer is not a query.
It makes the vector lane trivially exact and turns any recall number measured that way into an upper bound.

The vector *can* be rebuilt: `cluster_id` is a column on the corpus row, and `lib/synth-vectors.mjs` regenerates the drifted query vector from `(targetId, clusterId, dims, drift)` deterministically.
Rebuilt that way, `cos(stored, rebuiltMemory)` is 0.997, so the reconstruction is faithful to what was loaded.

**The reconstruction is right and the corpus is well-formed.**
Under exact cosine with the index disabled, the drifted query ranks its own target first, every time.

**The IVFFlat index is what loses them.**
Vector lane alone, depth 30, 120 drifted test queries at 1M, `lists = 1000` (reproduce with `experiments/recall-bench/scripts/probe-recall.mjs`):

| Setting | target at rank 1 | target in top 30 | median ms |
| --- | --- | --- | --- |
| exact, index disabled | 0.933 | **0.992** | 356.95 |
| `probes = 1` | 0.008 | 0.008 | 0.69 |
| **`probes = 8` (what the scale tier runs)** | 0.150 | **0.150** | 3.19 |
| `probes = 32` | 0.267 | 0.267 | 11.31 |
| `probes = 100` | 0.467 | 0.475 | 36.03 |
| `probes = 250` | 0.717 | 0.742 | 95.63 |

`hit@1` and `hit@30` are nearly equal at every probe count, and that is the tell: either the probed lists hold the target, in which case it ranks first because it ranks first exactly, or they do not, in which case it is absent altogether.
Depth is not the constraint; list routing is.

**The obvious explanation was tested and is only half right.**
The index is built at `lists = 1000`, the textbook `sqrt(1M)`, while the corpus has **20,000 natural clusters of 50 rows each**.
Each list therefore averages twenty unrelated cluster centroids, and a centroid that is a mean over twenty unrelated clusters sits near the global mean and carries little routing signal.
That predicts right-sizing `lists` would fix it.
It does not.

| | `lists = 1000` | `lists = 4000` |
| --- | --- | --- |
| Build time at 1M | **66.3 s** | **812.8 s** (13.5 min) |
| `probes = 8` | 0.150 @ 3.19 ms | 0.150 @ 1.75 ms |
| `probes = 32` | 0.267 @ 11.31 ms | 0.292 @ 4.22 ms |
| `probes = 100` | 0.475 @ 36.03 ms | 0.433 @ 10.26 ms |
| `probes = 250` | 0.742 @ 95.63 ms | 0.517 @ 23.06 ms |

At equal `probes`, more lists buys nothing in recall -- 0.150 either way at 8.
What governs `hit@30` is the **fraction of the index scanned**, not the granularity of the partition: `lists = 1000` at `probes = 250` scans 25% of the index for 0.742, while `lists = 4000` at the same 250 scans 6.25% for 0.517.
The routing signal really is weak, because a drifted query sits at cosine ~0.38 from its own target, and no partitioning of that space makes the target's list the obviously nearest one.

What right-sizing does buy is the **recall-per-millisecond frontier**, because each probe touches fewer rows.
At roughly 4 ms, `lists = 4000` at `probes = 32` scores 0.292 against `lists = 1000` at `probes = 8` scoring 0.150.
At roughly 10 ms it is 0.433 against 0.267.
**About 2x the recall for the same latency** -- real, worth having, and still nowhere near the exact lane's 0.992.

Two hard costs come with it, and both are rung-3 gate inputs.
The build is **12x slower** at 1M (66 s to 813 s), which is the same build-time gate that eliminated HNSW at 186 projected minutes.
And `lists = 16000`, the value that would actually match the cluster count, **cannot be built on this machine at all**: pgvector reports `memory required is 50240 MB, maintenance_work_mem is 6144 MB`.

One caveat that must not be lost in a write-up.
The synthetic tier's vectors are *generated from* cluster centroids, so sizing `lists` to the cluster count is tuning the index to the corpus's own construction.
That is legitimate for what rungs 3 and 4 measure, since both are synthetic, but it does not transfer to the 50K real-embedding arm, where `cluster_id` does not determine the vector.

**What this means for everything else in this document.**
The scale tier's vector lane costs about 3.0 ms and returns the right document 15% of the time.
So the 1,805 QPS ceiling in the rung 3 results, and every per-family cost in 6.7, are measurements of a system whose ANN search mostly misses -- fast partly because it is not finding anything.
Buying the recall back is not affordable at this shape: `probes = 250` reaches 0.742 and costs 95.63 ms, which on 12 cores is a ceiling near 125 QPS, and even that is below the exact lane's 0.992.

**Whole-pipeline recall at 1M, measured honestly**, tunedScale, 100 test queries per family:

| Family | Recall@1 | Recall@10 |
| --- | --- | --- |
| rare_token | 1.000 | 1.000 |
| near_dup | 0.950 | 1.000 |
| typo_noisy | 0.980 | 0.980 |
| partial_ref | 0.560 | 0.980 |
| entity_swap | 0.230 | 0.350 |
| date_filter | 0.100 | 0.190 |
| paraphrase_nolex | 0.180 | 0.180 |
| **overall** | | **0.669** |

The split is exactly the vector lane's footprint: every family a lexical lane can solve is at or near 1.0, and every family that depends on the vector lane has collapsed.
`paraphrase_nolex` is 0.23 of the mix and is *defined* as having no lexical overlap, so it has nothing else to fall back on.

**What this does not change.** The 6.7 cost work stands on its own: the stored tsvector column was proved neutral by 274 of 274 identical lexical lanes, the date-index change by 280 of 280 identical id lists, and both are diffs of the pipeline against itself. Core-ms is unaffected -- an IVFFlat probe costs what it costs whether or not it finds the target.

**What it does change** is what the 1M rung is evidence *for*.
Rung 3 exists to make the 10M decision cheaply, and the honest reading is now that the 1M rehearsal has two failing gates, not one: the throughput gate, and a vector lane whose recall would fail rung 2's quality bar by a wide margin if that bar were applied here.
Whether that is IVFFlat's fault or the synthetic geometry's is the open question -- drift 0.15 at 256 dims puts a query at cosine ~0.38 from its own target, which is a harder routing problem than real embeddings pose, and at 50K with real 768-dim vectors IVFFlat scored 0.363 naive Recall@10 rather than 0.150.
That question should be settled before any 10M build, because a 10M run inherits this lane.

---

### 6.9 ADDENDUM (2026-08-24): claim A tuned, and where the points actually came from

The tuned profile was measured before any tuning and scored **0.717** on the dev split -- twenty points *below* the `fixedRrf` baseline it is supposed to beat.
Every change below came out of the dev failure taxonomy rather than intuition, and each one is recorded with the dev delta it produced.
The test split was run once for the finished configuration and once for the ablation ladder.

**The taxonomy said the rerank was the problem, and it was.**
227 of the 283 dev failures were `lost_in_rerank`: the target reached the fused top 10 and the reranker pushed it out.
Section 6.5's feature list has no fusion term, so the rerank was *replacing* the retrieval ranking rather than refining it.
Fitting the eight listed features by coordinate descent could not repair that -- their best fit reached 0.873 while the un-reranked rung 4 reached 0.989.
Giving the scorer the fused RRF score as a ninth feature is what fixed it, and after that the fitted vector matches rung 4 exactly.
On this corpus the reranker's honest job is to preserve the fusion order, and the ablation reports that plainly: rung 5 buys 0.002 over rung 4.

**Three query-feature defects, each measured, each worth more than any weight.**

| Defect | What it did | Dev effect |
| --- | --- | --- |
| The indefinite article `an` extracted as a person | This corpus names people with Vietnamese given names; `an` and `van` are also ordinary English words. An inferred people filter is a hard AND, so it deleted the query's own target. | 33 queries filtered out their own target; `filter_excluded` 30 -> 0 |
| `looksParaphrase` keyed on *low* maxIdf | Backwards for this corpus: paraphrase_nolex has the **highest** maxIdf of any family (median 8.42) and rare_token the near-lowest (4.73), because a query built to share no vocabulary with its target shares only incidental rare words. The rule fired on 11 of 230 paraphrase queries. | paraphrase_nolex 0.170 -> 0.987 |
| `typoSuspect` keyed on OOV share alone | A typo and a paraphrase both look out-of-vocabulary, so all 230 paraphrase queries were flagged as typos and handed the trigram boost and AND penalty. Length separates them: 5 terms against 25. | typo_noisy 0.557 -> 1.000 |

Two lane weights then moved, both because a family's designated solving lane was under-weighted.
`base.or` 0.6 -> 1.3, because partial_ref is the family the OR lane exists to solve and its targets were fusing at rank 42-49 (0.686 -> 0.986).
`paraphraseBoost.or` +0.8 -> -1.3, because the naive vector-only baseline *beats* the hybrid on paraphrase_nolex, so its text lanes are noise; zeroing OR for those queries specifically is what let `base.or` serve partial_ref without a trade-off between the two.
`entityBoost.and` 1.3 -> 2.0 took entity_swap 0.909 -> 0.936, which is where base + boost meets the [0, 3] clamp.

**The ablation ladder, test split, one run per rung.**

| Rung | Configuration | Recall@10 | Recall@5 | MRR@10 |
| --- | --- | --- | --- | --- |
| 0 | `naive` | 0.697 | 0.592 | 0.462 |
| 1 | `fixedRrf` | 0.897 | 0.805 | 0.701 |
| 2 | + query-dependent lane weights | 0.934 | 0.853 | 0.736 |
| 3 | + trigram lane | 0.967 | 0.888 | 0.762 |
| 4 | + metadata filters | 0.975 | 0.897 | 0.774 |
| 5 | `tuned` | **0.977** | 0.898 | 0.775 |

Rungs 0 and 1 reproduce the previously published baselines exactly (0.697 and 0.897), which is the check that none of the tuning disturbed the things it is measured against.

**Claim A, stated exactly.**
Recall@10 on the 1,000-query test split is **0.977, 95% bootstrap CI [0.968, 0.986]** over 10,000 resamples.
Section 5 allows the 0.91 claim only when the lower bound also clears 0.91; it clears it by 5.8 points.
Per-family: paraphrase_nolex 0.996, rare_token 1.000, entity_swap 0.818, near_dup 1.000, date_filter 1.000, partial_ref 0.971, typo_noisy 1.000.
The `not_retrieved` gate is empty.

**What is still failing, and it is one family.**
23 of 1,000 test queries miss: 22 `lost_in_fusion` and 1 `date_misparse`.
20 of the 23 are entity_swap, the only family still under 0.97.
That family's distractors carry the *same* person as the target, so the people filter and the entity rerank feature -- the two mechanisms section 4.1 assigns to it -- cannot separate target from distractor once both are inside the filter.
The dev fit confirms it rather than contradicting it: coordinate descent drove the `entity` rerank weight *negative*, because post-filter the feature is pure noise.
Separating those would need the distinguisher term, not the entity, and that is a lane question rather than a weight question.

**Two performance fixes were needed before any of this was measurable**, and both are recorded because they changed the cost of the bench, not its numbers.
The OR lane's fragment bar rebuilt `to_tsquery('english', term)` per term per candidate row; a broad OR matches ~42K of the 50K rows, so a 13-term query ran roughly 540K parses inside one statement (451 ms -> 217 ms after stemming the terms once, verified result-identical on dev down to the same 86 failure records).
The trigram lane ran a `word_similarity` over every row on every query even when its weight was zero, which is the case for ~85% of queries; gating it on the weight is a 2.4x speedup on the dev split and is recorded as a tunable (`lanes.trigramWhenWeighted`) rather than a pure optimization, because a zero-weight lane can still contribute trailing candidate ids.

---

## 7. The scale ladder

Each rung has a gate.
A failed gate stops the ladder; it does not get waived.

### Rung 0: prerequisites (`infra/pg-up.sh`)

These are **checks that abort the script**, not notes, because the most likely way claim B fails on this machine is an under-provisioned Docker VM rather than anything about Postgres.

- Docker daemon reachable.
- **Docker VM memory >= 16 GB.** The macOS Docker VM commonly defaults to 8 GB regardless of the host's 24 GB. The ~7 GB HNSW index plus hot heap has to live in page cache; at 8 GB it will not, and claim B fails for a reason that has nothing to do with retrieval. `docker info --format '{{.MemTotal}}'`, abort with the fix instructions if short.
- Free disk >= 40 GB.
- Extensions present: `vector`, `pg_trgm`. **Gate, not assumption**, since these could not be verified while writing this doc.
- `halfvec` type exists and accepts an HNSW index with `halfvec_cosine_ops`. **Fallback if absent: `vector(256)`**, which doubles the vector bytes to 1,032 per row, pushes the 10M heap from 8.0 GB to about 13 GB and the total to about 23 GB, and requires re-running the disk budget before the 10M rung.
- IVFFlat with `halfvec_ip_ops` / `halfvec_cosine_ops` available, as the HNSW fallback.

Server tuning applied from `infra/postgresql.bench.conf`:

```
shared_buffers = 8GB
effective_cache_size = 16GB
work_mem = 32MB
maintenance_work_mem = 6GB
max_connections = 200
random_page_cost = 1.1
jit = off                            # JIT compilation costs more than it saves on sub-10ms queries
max_parallel_workers_per_gather = 0  # at ~100 concurrent clients, intra-query parallelism only adds contention
max_parallel_maintenance_workers = 7 # index builds are the exception: they want every core
synchronous_commit = off
```

### Rung 1: 1K smoke

Full pipeline, real embeddings, about 22 seconds of embedding.
Gates:

- `tests/*.test.mjs` all pass.
- Every query's targets exist in the corpus; every certificate is `solvable: true`.
- Best-lane-rank@10 >= 0.97.
- `not_retrieved` bucket is empty.
- Naive Recall@10 within 0.55-0.85 (a wider band than the 50K target; 100 queries per split has an error bar of about +/- 8 points).
- End-to-end wall clock under 5 minutes.

### Rung 2: 50K quality -- **claim A**

50,000 memories, 1,000 dev + 1,000 test queries, plus the 300-query multi-target set.
Embedding sweep: 52,000 texts at 50.4 texts/sec, batch 64, single process, ~17.3 minutes.
Checkpointed every 5,000 rows so a crash resumes rather than restarts, and query vectors are cached to `.out/quality50k/query-vectors.f32` during the same sweep.

**Caching query vectors is load-bearing, not a nicety.** Tuning needs dozens of `bench-recall` runs; re-embedding 2,000 queries at 12.8 ms each costs 26 seconds per run and would dominate the tuning loop for nothing.

Gates:

- Naive Recall@10 within 0.60-0.80.
- Best-lane-rank@10 >= 0.97.
- Every ablation rung monotonically non-decreasing, or the regression is explained in the report. A rung that hurts is a finding worth keeping, not something to hide.
- **Tuned Recall@10 >= 0.91 on the test split, with the bootstrap lower bound also >= 0.91.**
- `CORPUS.lock` present and matching; `TEST-RUNS.log` written.

### Rung 3: 1M scale rehearsal -- the decision point

Synthetic 256-dim vectors, no embedding model, generated straight into `COPY`.
This rung exists to make the expensive decisions cheaply, before four hours are sunk into a 10M build.

Measure:

- `COPY` throughput (rows/sec) -> extrapolated 10M ingest time.
- HNSW build wall clock and rows/sec -> extrapolated 10M build time.
- **Watch the build log for pgvector's message that the graph no longer fits in `maintenance_work_mem`.** Past that point the build spills to a much slower disk-based path, and the extrapolation from 1M stops being linear. Catching it here is the entire point of this rung.
- `pg_total_relation_size` per object -> extrapolated 10M footprint.
- A full `bench-load` run at 1M.

Gates:

- Projected 10M footprint <= 30 GB. Over that: drop to `halfvec(192)` or shorten `body`.
- ~~Projected HNSW build <= 90 minutes. Over that, **switch to IVFFlat** (`lists = 3162`, about `sqrt(10M)`, `ivfflat.probes = 12`), which builds in a fraction of the time at some recall cost, and record the recall cost by re-running rung 2's quality bench against an IVFFlat index at 50K.~~
  **REVISED 2026-08-24, see 7.1 below.** A one-time offline build of up to several hours is acceptable for the 10M claim run.
  The 90-minute number protected rehearsal iteration speed, not claim validity, and it was applied to the one build the claim actually depends on.
  Two binding constraints replace it: **(i) the build must not spill out of `maintenance_work_mem`** -- the graph is sized before the build and the session's `maintenance_work_mem` is set to hold it, with the spill message watched for during -- and **(ii) the resulting footprint stays inside the 30 GB disk budget above.**
- 1M load bench comfortably above 2,400 QPS. If 1M cannot clear it, 10M certainly cannot, and the honest move is to report the ceiling found rather than proceed.

### 7.1 DESIGN CHANGE (2026-08-24): the build-time gate is revised, and the scale tier returns to HNSW

This is a deliberate change to a gate, recorded as one.
Section 7 opens with "a failed gate stops the ladder; it does not get waived", and that rule is not being bent here: the gate is being **replaced by a different gate**, with the reasoning written down, because the original one was measuring the wrong thing.

**What the 90-minute number was protecting.**
The gate reads "projected HNSW build <= 90 minutes", and it fired: the 1M build extrapolated to 186 minutes at 10M, so the scale tier fell back to IVFFlat.
Ninety minutes is a sensible bound on *rehearsal iteration speed*.
A rung whose whole purpose is to make the 10M decision cheaply cannot afford an index that takes an hour and a half to rebuild every time a parameter moves, because the rung stops being cheap and the decision stops being made.

But the 10M build is not a rehearsal.
It happens **once**, offline, before the claim run, and nothing about claim B is measured while it runs.
Claim B is a statement about serving throughput and recall at 10M, and the wall clock of a one-time offline build is not an input to it.
Applying an iteration-speed budget to the single build the claim depends on is a category error, and it cost the tier its vector lane: 6.8 measured IVFFlat at `probes = 8` finding the target **15% of the time**, which dragged whole-pipeline recall to 0.669 and made every latency number in 6.6 and 6.7 a measurement of a system that mostly was not retrieving anything.
A retrieval claim whose retrieval does not work is not a cheaper claim, it is a different and worse one.

**So the gate is revised rather than waived.**
A one-time offline build of up to several hours is acceptable for the 10M claim run.
Two constraints replace the wall clock, and both are real failure modes rather than budget lines:

1. **The build must not spill out of `maintenance_work_mem`.**
   This is the constraint the original rung-3 text already called "the entire point of this rung" -- past the spill point pgvector drops to a much slower disk-based path and the extrapolation from 1M stops being linear, so a build that spills is not a slower build, it is an unpredictable one.
   The graph is therefore sized *before* the build and the session's `maintenance_work_mem` is set to hold it.
   Sizing is measured at 1M and extrapolated, not guessed; `shared_buffers` can be lowered for the build if the arithmetic needs the headroom, and restored before anything is measured.

2. **Disk stays inside the existing 30 GB budget**, which is unchanged and still checked by `bench-load`'s own startup assertion.

**What this does not change.**
The 50K IVFFlat-versus-HNSW measurement above stands as a measurement; it is simply no longer the reason the scale tier runs what it runs.
The 6.7 cost work is index-independent -- the stored tsvector column and the date-index change were both proved by id-list diffs of the pipeline against itself.
And the throughput gate is untouched: the scale tier returning to HNSW does not lower the 2,400 QPS bar, it only means the bar is now being measured against a system that retrieves.

### 7.2 RESULT (2026-08-24): HNSW does not rescue the scale tier's vector lane, and this is why

7.1 returned the scale tier to HNSW so that decision 3 -- "sweep `ef_search`, pick the smallest whose whole-pipeline recall clears 0.90" -- could be made against an index that actually retrieves.
It was built, it was swept, and **decision 3 has no solution.**
This section records the frontier, the mechanism, and what the mechanism means for the 10M rung, because the mechanism turns out to matter far more than the frontier.

**The build, against 7.1's two constraints.**
Both held, comfortably.

| | Measured at 1M |
| --- | --- |
| Graph memory | 1,227 bytes/tuple (pgvector reported the graph outgrowing a 128 MiB budget after 109,390 tuples) |
| `maintenance_work_mem` requested | 1,521 MB (sized from that constant, +30%) |
| Spill NOTICE during the build | **none** -- constraint (i) held |
| Build wall clock, m = 16, `ef_construction` = 200, 8 processes | **6 min 43 s** |
| Index size | 794 MB (against IVFFlat's 525 MB) |
| Schema total | 1,831 MB (977 MB heap, 854 MB indexes) |

Note what the build time does to the *original* gate on its own terms: the 90-minute gate fired on a projection of **186 minutes at 10M**, which came from an extrapolated 1M build of ~18.6 minutes.
The 1M build measures 6.7 minutes.
So the gate that eliminated HNSW fired against a number that does not reproduce -- the revision in 7.1 was justified by the wrong-category argument, and it turns out the arithmetic was stale too.

**The unfiltered frontier.** Vector lane alone, depth 30, 200 drifted test queries, `hnsw.iterative_scan = off` (reproduce: `ARM=unfiltered node scripts/hnsw-ef-sweep.mjs`).

| Setting | hit@1 | hit@30 | median ms |
| --- | --- | --- | --- |
| exact (index disabled) | 0.955 | **0.995** | 389.38 |
| `ef_search` 40 (what the tier pinned) | 0.085 | **0.085** | 2.09 |
| `ef_search` 64 | 0.120 | 0.120 | 2.69 |
| `ef_search` 100 | 0.155 | 0.155 | 3.91 |
| `ef_search` 200 | 0.230 | 0.230 | 6.78 |
| `ef_search` 400 | 0.335 | 0.335 | 11.93 |

Set beside 6.8's IVFFlat table at matched latency, **the index swap buys essentially nothing**: at ~3.2-3.9 ms IVFFlat scores 0.150 and HNSW 0.155; at ~11-12 ms IVFFlat scores 0.267 and HNSW 0.335.
`hit@1` and `hit@30` are equal at every single setting, which is the same tell 6.8 recorded -- the search either reaches the target, in which case it ranks first exactly, or never sees it at all.

**The filtered frontier is worse, and it exposes a measurement error in 6.6.**
Same method, 200 `date_filter` queries, the real `daterange` containment the lane runs (reproduce: `ARM=filtered node scripts/hnsw-ef-sweep.mjs`).

| `ef_search` | iterative | `max_scan_tuples` | rows of 30 | **hit@30** | median ms |
| --- | --- | --- | --- | --- | --- |
| 40 | `relaxed_order` | 2,000 (what the tier pinned) | 25.2 | **0.160** | 3.88 |
| 40 | `relaxed_order` | 20,000 | 26.5 | 0.410 | 18.16 |
| 40 | `relaxed_order` | 100,000 | 28.3 | 0.540 | 26.07 |
| 100 | `relaxed_order` | 2,000 | 25.8 | 0.190 | 4.54 |
| 200 | `relaxed_order` | 2,000 | 26.0 | 0.245 | 6.96 |
| 200 | `relaxed_order` | 20,000 | 26.6 | 0.450 | 21.81 |
| 40 | `off` | 20,000 | 2.7 | 0.080 | 1.84 |

**Rows returned barely moves across the entire grid -- 25 to 28 of 30 -- while target hit@30 runs 0.080 to 0.545.**
Section 6.6 chose `filteredMaxScanTuples = 2,000` on the evidence that it "still returned the full 30 at roughly a third of the 5,000 cost".
It does return the full 30. The 30 hold the target 16% of the time.
That is deviation 2 doing its damage one level down: with the target's own embedding as the query, any 30 rows the lane returned contained the answer, so row count looked like a proxy for recall and is not one.
The axis that actually moves recall is `max_scan_tuples`, not `ef_search`, and every point on the frontier is unaffordable, unfindable, or both -- the best is 0.545 for 27 ms on 15% of the mix.

**The mechanism, measured rather than reasoned.**
The obvious story is that the synthetic corpus's 20,000 clusters give the index weak routing signal.
That story is wrong, and the corpus geometry says so directly.

| Measured on the loaded corpus | Cosine |
| --- | --- |
| query to its own target | 0.393 |
| query to rank 2 of the exact top 30 | 0.297 |
| query to rank 30 of the exact top 30 | 0.248 |
| query to a **same-cluster sibling** | **0.185** |
| query to a different cluster | -0.040 |
| sibling to sibling | 0.265 |

And the diagnostic that ties it together: **the exact top-30 contains 1.2 same-cluster rows out of 30.**

So the "topic clusters" do not exist in the vector space at all.
`jitter = 0.10` at 256 dims perturbs by `0.10 * sqrt(256) = 1.6` against a unit centroid, which is large enough that a sibling pair (0.265) is indistinguishable from the best of a million unrelated rows (~0.30).
What the corpus actually contains is a **noise floor** -- every one of 1M vectors sitting at cosine ~0.25-0.30 from the query by chance -- with the target as a lone spike 0.096 above it, placed there by construction because the query was drifted off the target.

That is the hardest possible case for any approximate nearest-neighbour method, and it explains both failures at once:

- **IVFFlat** partitions by k-means over vectors with no cluster structure to find, so its centroids carry no routing information. 6.8 measured this as "more lists buys nothing at equal probes".
- **HNSW** navigates by following edges toward higher similarity. The target's own graph neighbours are the rows nearest *it*, which are noise rows, not rows near the query -- the siblings that were supposed to be its neighbourhood sit at 0.185, **below the top-30 floor**. There is no gradient from the query's region to the target because the target is a spike, not a mode. Greedy descent has nothing to descend.

Different mechanisms, identical symptom, which is exactly why "switch the index" was never going to work and why the frontier climbs only as fast as brute force does: `ef_search` 40 to 400 is a 10x scan for 4x the recall, and reaching 0.90 needs a scan fraction that is not an index at all.

**Graph degree was tested too, and it matters more than the paragraph above implies.**
The mechanism argument predicts that a denser graph should not help much, since the problem is described as an absent gradient rather than a crowded neighbour list.
That prediction is **wrong**, and the measurement is recorded here rather than quietly dropped.
Same corpus, same 200 drifted queries, `ef_construction` 200 held, varying only `m`:

| `ef_search` | m = 16 hit@30 | m = 16 ms | **m = 32 hit@30** | m = 32 ms |
| --- | --- | --- | --- | --- |
| 40 | 0.085 | 2.09 | **0.125** | 3.92 |
| 100 | 0.155 | 3.91 | **0.290** | 7.52 |
| 400 | 0.335 | 11.93 | **0.620** | 25.28 |
| build wall clock at 1M | 6 min 43 s | | **17 min 12 s** | |
| index size at 1M | 794 MB | | **981 MB** | |

Doubling `m` roughly **doubles hit@30 at equal `ef_search`**, and it wins on the recall-per-millisecond frontier too, not just at equal `ef_search`.
So degree is a real axis here and the honest statement of the mechanism is the weaker one: the geometry makes this a hard ANN problem -- an isolated spike with no neighbourhood structure to descend -- and *within* that regime, recall tracks how much of the index the search touches, which both `m` and `ef_search` buy.

It still does not reach the floor at any affordable point.
m = 32 at `ef_search` 400 is the best measured setting anywhere in this document, and it costs **25.28 ms of vector lane alone** for a lane that still misses 38% of targets.
That is roughly seven times the entire per-query budget, and it caps throughput near `7.86 x 1000 / 25.3` -- about **310 QPS** -- against a 2,400 QPS claim.
Build cost scales with it: 2.6x at 1M, which extrapolates past 7 hours at 10M for m = 64, the next rung up.
The tier therefore keeps m = 16, not because m = 32 is worse, but because neither reaches a recall floor and m = 16 is the cheaper way to not reach it.

**The whole-pipeline frontier, which is what decision 3 actually asked for.**
The vector-lane tables above price the lane. This prices the system: `bench-load` at concurrency 1, real drifted query vectors, `recall-sample-rate 1.0`, a full pass over the 4,000 distinct queries per point, every window `valid` (reproduce: `scripts/pipeline-ef-sweep.sh`).
One instrument produces both columns, so the recall and the latency cannot drift apart by having been measured differently.

| `ef_search` | R@10 mix-weighted | R@10 unweighted | R@1 mix | **single-stream p50** | single-stream QPS |
| --- | --- | --- | --- | --- | --- |
| **40** (pinned) | 0.584 | 0.646 | 0.508 | **3.11 ms** | 270 |
| 64 | 0.595 | 0.655 | 0.521 | 3.68 ms | 251 |
| 100 | 0.608 | 0.666 | 0.534 | 4.35 ms | 225 |
| 200 | 0.657 | 0.709 | 0.590 | 7.13 ms | 144 |
| 400 | 0.719 | 0.762 | 0.664 | 12.47 ms | 84 |

**No point reaches 0.90, so decision 3 has no answer to give.**
The curve is also flatter than the vector-lane table alone suggests, and one reason is structural rather than physical: `filteredEfSearch` and `filteredMaxScanTuples` are separate knobs and stay pinned while `efSearch` sweeps, so `date_filter` -- 15% of the mix and the worst family -- sits at its own setting throughout and contributes a fixed floor to every row. The flat portion is that floor, not `ef_search` saturating.

**The latency half of the same table is the good news, and it retires decision 4 before the cut hunt starts.**
The rung-3 arithmetic said 2,400 QPS needs a single-stream p50 at or under **3.28 ms** against the 4.18 ms IVFFlat measured.
At `ef_search` 40 the pipeline now measures **3.11 ms**, so `7.86 x 1000 / 3.11` projects about **2,527 QPS** of peak capacity.
The 22% cut that section was hunting was delivered by the index change itself; **no candidate-count or projection cut was required to get there**, and the honest reading is that the cut hunt was chasing a number that HNSW handed over for free.

The cuts were priced anyway, and neither is worth taking:

- **`rerank.topK` 50 -> 25 is provably free and unnecessary.** Across every frontier run above, over 7,000 to 13,000 probes each, the count of final top-10 rows that came from past fused rank 25 is **0**, and the deepest surviving fused rank is **13** at every single `ef_search`. Truncating at 25 could not have changed an answer. It also could not have saved much: the plan profile puts the whole final join at 0.06-0.10 ms.
- **Narrowing the final projection is worth about 0.1 ms.** The `memories_pkey` scan that serves the join costs 0.077-0.100 ms across families, and the scale path's projection already emits literals for `dup_group`, `rare_token`, `people` and `tags`, so the only live columns are `occurred_at` (which `dateFit` reads at weight 0.5) and the cosine recompute.

**Where the time actually is**, from `EXPLAIN (ANALYZE, BUFFERS)` on the real statement, 8 queries per family at `ef_search` 40 (reproduce: `scripts/explain-scale.mjs`):

| Family | exec ms | of which the HNSW index scan |
| --- | --- | --- |
| rare_token | **0.07** | lane skipped by the vector gate |
| typo_noisy | 1.89 | 1.69 |
| partial_ref | 2.32 | 1.68 |
| near_dup | 2.76 | 1.95 |
| paraphrase_nolex | 3.38 | 2.59 |
| entity_swap | 4.59 | 2.12 |
| date_filter | 6.92 | 4.23 |

The vector lane is the dominant line item in every family that runs it, and 6.7's vector-lane gate is visible as `rare_token` at 0.07 ms -- the whole statement, because the ANN search is skipped and the conjunction already holds the answer.
So the remaining cost is exactly the cost the recall floor forbids cheapening, which is the shape 6.8 predicted and the reason the cut hunt has nowhere else to go.

**This retires 6.8's open question in the sharper direction.**
6.8 asked whether the 15% vector recall was "IVFFlat's fault or the synthetic geometry's" and said the question "should be settled before any 10M build".
It is settled: **the geometry's.**
The repo already holds the control that proves the pathology is synthetic-only -- at 50K with real 768-dim embeddings, HNSW scores naive Recall@10 **0.698** and fixedRrf **0.897** on the same pipeline.
Real embeddings put a query near a *neighbourhood* of related documents. This generator puts it near exactly one point and nothing else.

**What this does and does not invalidate.**

- **Throughput measurements at the synthetic tiers stand.** An ANN probe costs what it costs whether or not it finds anything, and the 6.7 cost work was proved by id-list diffs of the pipeline against itself.
- **Recall cannot be measured at the synthetic tiers at all.** Not "measures low" -- the number is a property of `lib/synth-vectors.mjs`'s jitter and drift constants, not of the retrieval system.
- **Decision 3 has no answer**, because no `ef_search` reaches 0.90 and the reason is not tuning.
- The fix is corpus geometry, not hardware and not the index: fewer and tighter clusters (a jitter small enough that siblings out-rank the noise floor), or a drift small enough that the query lands in the target's neighbourhood rather than beside it. That is a Track 2 change to the generator, and it is the prerequisite for any recall claim at 1M or 10M.

> **SUPERSEDED 2026-08-25 by 7.3 and 7.4.** The diagnosis above is right and the prescribed fix was carried out: jitter 0.10 -> 0.04, drift 0.15 -> 0.08, derived from the real tier's geometry rather than guessed.
> Every measurement in 7.2 stands as a measurement of the corpus it was taken on, and that corpus no longer exists -- `bench_r1m` was re-embedded on 2026-08-25.
> **Decision 3 now has an answer** (`ef_search` 44 clears 0.90, 48 is pinned at 0.916), and whole-pipeline recall went 0.669 -> 0.917 at essentially unchanged throughput.
> Two claims in 7.2 are corrected rather than merely superseded, and 7.3 carries both: 6.8's "cos(stored, rebuilt) = 0.997, so the reconstruction is faithful" was the signature of a loader bug, not a faithfulness check; and `cluster_id` turns out to label nothing in the REAL tier's vector space either, which retires the same-cluster-fraction statistic this section leans on.

### 7.3 THE GEOMETRY FIX (2026-08-25): what the real tier actually looks like, and the constants derived from it

7.2 ends by naming the fix as a Track 2 change to the generator and states the constraint as "a same-cluster sibling must sit above the top-30 noise floor".
This section does that work.
It also corrects two things 7.2 got wrong, and one of the corrections changes what the fix is calibrated against.

#### First, a loader bug that made every earlier reconstruction number meaningless

`load.mjs` carried its own `SYNTH_MEMORY_JITTER = 0.12` while `lib/synth-vectors.mjs`'s `queryVector()` drifts off `memoryVector(..., DEFAULT_MEMORY_JITTER = 0.10)`.
So at every synthetic tier the query was drifted off a vector that was **not the one stored in the database**.

6.8 reports `cos(stored, rebuiltMemory) = 0.997` and reads it as "the reconstruction is faithful to what was loaded".
It is not a faithfulness measurement. It is this bug's signature, and the arithmetic reproduces it exactly: two vectors built from the same gaussian draws at jitter 0.10 and 0.12 have cosine `(1 + 0.10 x 0.12 x 256) / (sqrt(1 + 0.01 x 256) x sqrt(1 + 0.0144 x 256))` = 0.9968.
Verified directly against `bench_r1m`'s stored embeddings: they regenerate at cos **1.000** under jitter 0.12 and **0.9968** under 0.10.

The jitter is a contract between the two modules, not a call-site choice, so it now lives in one place and `tests/recall-bench-synth-geometry.test.mjs` pins the invariant.

#### Second, `cluster_id` does not label the vector space at the REAL tier either

7.2's mechanism paragraph says of the synthetic tier that "the 'topic clusters' do not exist in the vector space at all".
The same sentence is true of the real 768-dim tier, for a completely different reason, and it invalidates the statistic that the fix was going to be calibrated against.

`gen-corpus.mjs` assigns `cluster_id` with `randomClusterId(r, tier)` -- a uniform draw over `tier.clusters`, **independent of the memory's topic, text, people, places and dates**.
It is a random label. Measured on `bench_q50k` with `scripts/geometry-probe.mjs`, 210 dev-split queries, real embeddings, exact top-30 with index scans disabled:

| Measured on the real tier | Cosine |
| --- | --- |
| memory to memory, **same** cluster | 0.728 |
| memory to memory, **different** cluster | **0.729** |

Identical. There is no cluster signal to find.

An earlier pass of this measurement appeared to show one (same-cluster 0.728 against 0.584 "different cluster") and that comparison was wrong: it set a *memory-to-memory* cosine beside a *query-to-memory* one.
A query is about ten words and a body is ~370 characters, and the embedder separates short from long text before it separates topic from topic, so the gap was text length, not topics.
The control that answers the question has to hold text length fixed, and when it does the gap disappears.

**Consequence for the calibration.** "The fraction of the exact top-30 that shares the target's cluster" cannot be the target statistic, because at the real tier it measures a random label: it comes out at **0.7 rows of 29**, against the synthetic corpus's 1.2 of 30. Matching that number would mean deliberately preserving the pathology.

#### What the real tier does have: an unlabelled neighbourhood

The neighbourhood is real, it is just not named by any column.

| Measured on the real tier (210 dev queries, exact top-30) | Cosine |
| --- | --- |
| query to its own target | 0.705 |
| query to rank 2 of the exact top-30 | 0.707 |
| query to rank 10 | 0.687 |
| query to rank 30 | 0.671 |
| **mutual cosine among the exact top-30** | **0.834** |
| **exact top-30 member to the target** | **0.808** |
| memory to memory, unrelated | 0.729 |

Read the last three rows together, because they are the whole mechanism.
The top-30 rows are **more similar to each other (0.834) and to the target (0.808) than the query is to any of them (0.671-0.707)**.
The query sits outside a dense mode looking in.
That is exactly what makes greedy descent work: a search that reaches *any* member of that group finds the target among its immediate neighbours.

Set that against the synthetic corpus at the old constants, same instrument:

| | Real 768-dim (`bench_q50k`) | Synthetic 256-dim, jitter 0.10 / drift 0.15 |
| --- | --- | --- |
| query to its own target | 0.705 | 0.385 |
| query to rank 2 of exact top-30 | 0.707 | 0.267 |
| query to rank 30 of exact top-30 | 0.671 | 0.214 |
| query to a same-cluster sibling | 0.584 | 0.111 |
| sibling to sibling | 0.728 | 0.291 |
| **neighbour to target** | **0.808** | **0.275** |
| **neighbour-to-target / query-to-target** | **1.15** | **0.71** |
| same-cluster rows in the exact top-30 | 0.7 of 29 | 1.8 of 29 |
| target rank 1 under exact cosine | 0.395 | 1.000 |

**The ratio in bold is the pathology, stated as one number.**
At the real tier the target's nearest neighbours are 1.15x closer to it than the query is, so there is a path in.
At the synthetic tier the ratio inverts to 0.71: the target's nearest neighbours are *noise rows*, the query is closer to the target than anything else in the corpus is, and the target is an isolated spike.
7.2 described this in words -- "greedy descent has nothing to descend" -- and this is the number behind the words.

#### The derivation

With a unit centroid, `dims` D, jitter `j` and drift `d` (`scripts/calibrate-synth-geometry.mjs` prints this and checks it against real generator output):

```
sibling <-> sibling, sibling <-> target :  1 / (1 + j^2 D)
query   <-> its own target             :  1 / sqrt(1 + d^2 D)
query   <-> a sibling                  :  the product of the two
k-th best of N unrelated rows          :  z(1 - k/N) / sqrt(D)
```

At D = 256 the noise floor is **0.251 at 1M and 0.283 at 10M**.
The 10M value is the one that binds: a corpus calibrated against the 1M floor fails again at the tier the constants exist to serve, and that would be a second regeneration.

Two conditions fix the pair:

1. **Navigability.** `cos(neighbour, target) / cos(query, target) = 1.15`, taken from the real tier's 0.808 / 0.705.
2. **Margin.** `cos(query, sibling)` at least 1.55x the 10M floor, so the cluster is a mode rather than a coin flip against noise.

Substituting (1) into the closed forms collapses `cos(query, sibling)` to `1 / (1.15 (1 + j^2 D)^2)`, which inverts to

```
j <= 0.0399      d <= 0.0796
```

**Pinned: `DEFAULT_MEMORY_JITTER = 0.04`, `DEFAULT_QUERY_DRIFT = 0.08`.**
That is the derived bound rounded up one notch rather than down, deliberately -- it is the *hardest* geometry that still satisfies both conditions, and a benchmark should not be made easier than its constraints require.
Because the shipped values sit a hair past the solved bound, they are verified at the shipped values rather than the solved ones.

Note that `d ~= 2j` is a *consequence* of the ratio plus the algebra, not a free choice. If either constant moves, both re-derive from the ratio.

#### Verified on 100K generated vectors before anything was regenerated

`scripts/calibrate-synth-geometry.mjs`, 100,000 vectors in memory at the tier's real cluster size, 20 probe queries, exact cosine over the whole sample:

| jitter | drift | q->target | rank 30 | q->sib | q->sib p5 | sib->sib | sib->target | same-cluster of top-30 | rank 1 | sibs over the 10M floor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.10 | 0.15 | 0.384 | 0.214 | 0.111 | 0.006 | 0.291 | 0.275 | 1.8 of 29 | 1.000 | **0.1 of 49** |
| 0.05 | 0.10 | 0.531 | 0.321 | 0.327 | 0.233 | 0.616 | 0.608 | 28.6 of 29 | 1.000 | 38.5 of 49 |
| **0.04** | **0.08** | **0.617** | **0.436** | **0.441** | **0.356** | **0.714** | **0.709** | **29.0 of 29** | **1.000** | **49.0 of 49** |
| 0.035 | 0.07 | 0.667 | 0.507 | 0.511 | 0.434 | 0.765 | 0.761 | 29.0 of 29 | 1.000 | 49.0 of 49 |

The p5 column is there because the gate is a worst case and the table is means: a mean sibling cosine over the floor with a left tail crossing it is a corpus where corners of clusters are still unreachable, and that surfaces later as a family-shaped recall hole that reads like a tuning problem.
At 0.04 / 0.08 the p5 is 0.356 against the 0.283 floor. The absolute minimum over 980 sibling pairs is 0.270, marginally under -- which is fine and expected, because the requirement is that the cluster forms a mode, not that every last member of it is in the top-30.

Re-run at the **10M cluster size of 500** (20,000 clusters at 10M, not the 1M tier's 50), because a 10x larger cluster is 10x more chances for the worst sibling to fall under the floor: **498.8 of 499** siblings clear it, p5 0.351. The margin carries.

Measured navigability ratio at the shipped constants: **0.709 / 0.617 = 1.149**, against the real tier's 1.146.

#### What this deliberately does NOT reproduce, and why that is correct

The synthetic tier is now **easier** than the real tier, and the difference should be read rather than defended:

| | Real 768-dim | Synthetic at 0.04 / 0.08 |
| --- | --- | --- |
| target inside the exact top-30 | 0.857 | 1.000 |
| target at rank 1 under exact cosine | 0.395 | 1.000 |

This is a design choice with a reason.
The synthetic tiers exist to measure **whether the ANN index can route to a neighbourhood that is really there** -- that is what claim B needs, and it is only interpretable if the exact lane holds the answer, because then every miss is unambiguously the index's.
Corpus *difficulty* is rung 2's job, where real embeddings and a real embedder decide what is hard.
A synthetic generator that reproduced real embedding failure modes would be measuring its own imitation of an embedder, which is the error this whole section exists to remove.

**One consequence to note before the frontier is run:** with the exact vector lane at recall 1.0, whole-pipeline recall at 1M is bounded by the lexical families' own ceilings (6.8 measured `entity_swap` 0.35, `date_filter` 0.19 with the broken lane underneath), not by the vector lane. The exact-cosine whole-pipeline ceiling is therefore measured first, before any `ef_search` sweep, so a gate miss can be attributed to corpus composition or to the index rather than argued about afterward.

#### What this invalidates

The existing 1M corpus's `embedding` column, and every recall number measured against it.
That is expected and correct: 7.2 already recorded that recall "cannot be measured at the synthetic tiers at all" under the old constants.
The corpus **text** is untouched -- `gen-corpus.mjs` does not import `lib/synth-vectors.mjs` at all (it certifies the lexical lanes offline and leaves the vector lane to `load.mjs --verify-oracle`), so `queries-dev.jsonl`, `queries-test.jsonl` and every lexical certificate survive the regeneration unchanged.

### 7.4 RESULT (2026-08-25): the vector lane works, decision 3 has an answer, and the throughput gate is now the only one failing

Everything below is measured on the re-embedded 1M corpus, real drifted query vectors rebuilt from `cluster_id`, whole-pipeline recall reported beside every rate because 6.8's rule is that a system which does not retrieve has no throughput claim.

#### The rebuild

Re-embed rather than regenerate, and that choice was forced by a measurement rather than taste.
`load.mjs --stream` would have rebuilt a *different* corpus: `config.corpus` has moved since this tier was loaded, and of 7 sampled ids **0 of 7** now regenerate to the text actually in the table.
The loaded corpus is still internally consistent with its query files (every family except `paraphrase_nolex`, which is 0 by design, has 12 of 12 sampled targets sharing content words with the query naming them), so a `--stream` rebuild would have stranded all 4,000 queries against targets that no longer contain what they ask for -- and reported success while doing it.

Since the vector is a pure function of `(id, cluster_id, dims, jitter)` and both inputs are columns on the row, recomputing from the rows already present makes **geometry the only variable** between 7.2's frontier and the one below.

| Step | Measured |
| --- | --- |
| Stream COPY of 1M re-embedded rows (`scripts/reembed-synthetic.mjs`) | **42.4 s** |
| `gin (fts)` on the stored tsvector column | 2.6 s |
| `btree (person_id, occurred_at)` | 0.3 s |
| HNSW, m = 16, `ef_construction` = 200, 8 processes, `maintenance_work_mem` 1,521 MB | **6 min 04 s** (was 6 min 43 s) |
| Spill NOTICE | **none** -- 7.1 constraint (i) held |
| Heap / HNSW / GIN / pkey / btree | 977 MB / 793 MB / 30 MB / 21 MB / 8.6 MB |
| Schema total | **1,831 MB**, unchanged from 7.2 |

Jitter does not change bytes per tuple, so the footprint reproduces exactly.

#### The geometry, as loaded

`scripts/geometry-probe.mjs` against `bench_r1m`, 100 test queries, exact top-30 with index scans disabled. The predicted column is the closed form, not a fit.

| | Before (jitter 0.10 / drift 0.15) | Predicted at 0.04 / 0.08 | **After, measured in the DB** | Real 768-dim tier |
| --- | --- | --- | --- | --- |
| query to its own target | 0.385 | 0.616 | **0.616** | 0.705 |
| query to rank 2 of exact top-30 | 0.267 | -- | **0.505** | 0.707 |
| query to rank 30 of exact top-30 | 0.214 | -- | **0.435** | 0.671 |
| query to a same-cluster sibling | 0.111 | 0.437 | **0.451** | 0.584 |
| sibling to sibling | 0.291 | 0.709 | **0.709** | 0.728 |
| **neighbour to target** | 0.275 | 0.709 | **0.717** | 0.808 |
| **neighbour-to-target / query-to-target** | **0.71** | 1.15 | **1.164** | **1.146** |
| same-cluster rows in the exact top-30 | 1.8 of 29 | 29 of 29 | **29.0 of 29** | 0.7 of 29 (a random label) |
| target rank 1 under exact cosine | 1.000 | 1.000 | **1.000** | 0.395 |

The ratio that defines navigability lands at **1.164** against the real tier's **1.146**, from an analytic solve rather than a search.

#### The vector lane alone

Depth 30, 200 drifted test queries, `hnsw.iterative_scan = off` (`ARM=unfiltered scripts/hnsw-ef-sweep.mjs`).

| `ef_search` | hit@30 BEFORE (7.2) | **hit@30 AFTER** | median ms |
| --- | --- | --- | --- |
| exact (index disabled) | 0.995 | **1.000** | 327.28 |
| 10 | -- | 0.420 | 1.46 |
| 24 | -- | 0.650 | 1.39 |
| 40 | 0.085 | **0.780** | 1.72 |
| 48 | -- | **0.820** | 1.77 |
| 64 | 0.120 | **0.880** | 2.17 |
| 100 | 0.155 | **0.935** | 3.17 |

At the setting the tier used to pin, the lane went from finding the target **8.5% of the time to 78%**, and the exact lane is now perfect rather than 0.995.
Note also that the lane got *more* expensive at equal `ef_search` (1.72 ms against 7.2's 2.09 ms is faster, but the curve is far flatter): a graph with real structure spends its time traversing, where before it terminated early against noise.

#### The whole-pipeline frontier -- decision 3, answered

`bench-load` at concurrency 1, `recall-sample-rate 1.0`, a full pass over all 4,000 test queries per point, every window valid (`scripts/pipeline-ef-sweep.sh`).
One instrument produces both columns.

| `ef_search` | R@10 mix | R@10 unweighted | R@1 mix | single-stream p50 |
| --- | --- | --- | --- | --- |
| 10 | 0.819 | 0.850 | 0.756 | 3.71 ms |
| 16 | 0.817 | 0.850 | 0.789 | 3.61 ms |
| 24 | 0.860 | 0.884 | 0.839 | 3.79 ms |
| 40 (the old pin) | 0.897 | 0.913 | 0.877 | 3.50 ms |
| **44** | **0.906** | 0.922 | 0.890 | 4.18 ms |
| **48 (pinned)** | **0.916** | 0.929 | 0.900 | 4.01 ms |
| 56 | 0.929 | 0.940 | 0.917 | 4.41 ms |
| 64 | 0.939 | 0.948 | 0.929 | 3.89 ms |
| 100 | 0.965 | 0.969 | 0.960 | 5.60 ms |

**Decision 3 has an answer: 44 is the smallest `ef_search` clearing 0.90, and 48 is pinned.**
7.2's best point anywhere was 0.719 at 12.47 ms; 48 beats it by twenty points at a third of the cost.

The p50 column is **not monotone in `ef_search`**, and that is a finding rather than sloppiness: this machine drifts by more than the effect (see the cut hunt below).
It also says the lane's cost is mostly fixed rather than proportional to `ef`, which the lane-alone table confirms directly -- 1.46 ms at `ef` 10 against 1.77 ms at 48.

**The exact-cosine ceiling, measured first so a gate miss could be attributed rather than argued about.**
Same pipeline with `ef_search` 1000 and `max_scan_tuples` 2,000,000: **R@10 0.990, R@1 0.989** mix-weighted over 2,901 probes.
So 0.90 was known to be reachable before a single sweep point was spent, and the remaining gap at 48 is the index's, not the corpus's.

| Family | exact ceiling R@10 | at `ef_search` 48 |
| --- | --- | --- |
| rare_token | 1.000 | 1.000 |
| near_dup | 1.000 | 0.996 |
| typo_noisy | 1.000 | 0.999 |
| partial_ref | 1.000 | 0.996 |
| date_filter | 0.935 | 0.888 |
| entity_swap | 1.000 | 0.841 |
| paraphrase_nolex | 1.000 | 0.794 |
| **mix-weighted** | **0.990** | **0.917** |

Set this beside 6.8's table on the old geometry (overall 0.669, `paraphrase_nolex` 0.180, `entity_swap` 0.350, `date_filter` 0.190) and the shape of the change is exactly the vector lane's footprint returning.

#### The filtered arm, swept on its own knob

7.2 named its own method as a defect here: with `filteredMaxScanTuples` pinned while `efSearch` swept, `date_filter` contributed a fixed floor to every row.
Swept properly at `ef_search` 48 (`scripts/filtered-arm-sweep.sh`):

| `max_scan_tuples` | date_filter R@10 | R@10 mix | single-stream QPS |
| --- | --- | --- | --- |
| **2,000 (pinned)** | 0.884 | 0.915 | **208** |
| 8,000 | 0.937 | 0.924 | 173 |
| 20,000 | 0.938 | 0.924 | 139 |
| 50,000 | 0.940 | 0.925 | 101 |

It stays at 2,000. The lane saturates at 8,000 and the extra costs **17% of the single-stream rate for 0.009 of mix recall**, which is the wrong trade when the gate is already met.

#### The cut hunt, and why its first run was worthless

The target was p50 <= 3.28 ms, from `2400 / 7.86` single-stream equivalents.

Run as sequential arms, **every candidate reported as a slowdown** -- `topK` 25, lane depth 20 and candidate caps 200 all came out worse than baseline, in run order.
That is not physics. The control that proves it: re-running the **identical baseline configuration** after half an hour of sustained load gave **p50 4.37 ms against 3.86 ms** for the same config earlier.
The machine drifts by **0.51 ms** over the sequence, three times the effect being measured, with 23 GB of 24 GB used, 11 GB held by the compressor and 8.06 GB in swap.

Interleaved A/B pairs share that environment, so the difference survives even when neither absolute number does:

| Cut | Paired delta p50 | Recall | Verdict |
| --- | --- | --- | --- |
| `rerank.topK` 50 -> 25 | **-0.179 ms** (negative in 4 of 4 pairs) | 0.9153 -> 0.9150 | **taken** |
| lane `depth` 30 -> 20 | **not resolvable** (sequential only) | 0.916 -> 0.914 | rejected |
| candidate caps 400 -> 200 | **not resolvable** (sequential only) | 0.916 -> 0.914 | rejected |

The bottom two rows deserve their provenance stated rather than a verdict that looks better than its evidence.
Only `topK` was re-run as interleaved pairs; the other two were measured sequentially, which is the method this section just showed to be invalid.
So their latency effect is **not resolvable above the 0.51 ms drift** -- not "measured as zero".
The recall half *is* valid, because per-query recall is deterministic, and it is a real cost.
They are rejected on that alone: a demonstrated recall cost with no demonstrated win to pay for it.

`topK` 25 is provably free: across **45 measurement windows** the deepest fused rank ever to survive into a final top-10 is **21**, and the count of survivors from past rank 25 is **0**.
7.2 priced this cut at 0.06-0.10 ms and called it "unnecessary"; free it is, unnecessary it is not, and the saving was understated by roughly 2x.

Prepared-statement reuse was verified rather than assumed: the scale path still travels as one named prepared statement over three lanes (pinned by `tests/recall-bench-scale-lanes.test.mjs`), and the `SELECT 1` ceiling probe reports **98,694 QPS at p50 0.31 ms**, so neither the client nor the round trip is the constraint.

**The cut hunt does not close the gap.** Best measured single-stream p50 is 3.86 ms baseline, 3.68 ms with the cut, against a 3.28 ms requirement. The available cuts total under 0.2 ms.

#### Full validation at 1M

`scripts/full-validation.sh`, 60 s warmup + 120 s measured per window, every window clean of tuner contention, `SELECT 1` ceiling 98,694 QPS.

**Sequential per-family cost profile** (`scripts/family-profile.mjs`), one connection, no load generator:

| Family | share | median core-ms |
| --- | --- | --- |
| rare_token | 0.22 | **0.37** (vector lane skipped by the df gate) |
| paraphrase_nolex | 0.23 | 1.61 |
| typo_noisy | 0.07 | 1.88 |
| near_dup | 0.15 | 2.15 |
| partial_ref | 0.07 | 2.16 |
| entity_swap | 0.11 | 3.51 |
| date_filter | 0.15 | 7.62 |
| **mix-weighted median** | | **2.59 core-ms** |

**Closed-loop sweep**, all three windows valid:

| concurrency | QPS | p50 | p95 | p99 | R@10 |
| --- | --- | --- | --- | --- | --- |
| 8 | **1,786** | 3.75 ms | 10.08 ms | 14.42 ms | **0.917** |
| 16 | 1,573 | 6.63 ms | 29.60 ms | 68.14 ms | 0.917 |
| 32 | 1,488 | 8.01 ms | 110.35 ms | 178.96 ms | 0.916 |

Throughput *falls* past concurrency 8, so 1,786 QPS is the saturation ceiling and not a step on the way up.

**Open-loop, climbing:**

| offered | completed | p50 | p95 | p99 | R@10 | in-flight flat | window |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1400 | 1,441.9 | 30,269 ms | 56,197 ms | 65,540 ms | 0.918 | **no** | **INVALID** (overran 37%) |
| 1800 | 1,807.4 | 178 ms | 2,233 ms | 2,421 ms | 0.916 | yes | valid, **gate FAIL** (p50 > 41 ms) |
| 2100 | 2,249.3 | 103,785 ms | 122,548 ms | 124,316 ms | 0.917 | **no** | **INVALID** (overran 69%) |
| 2400 | 2,704.2 | 39,729 ms | 62,300 ms | 62,451 ms | 0.917 | **no** | **INVALID** (overran 35%) |

**Reported as a miss, and the miss stated no wider than the evidence supports.**
An INVALID window supports no conclusion in either direction -- it cannot be read as a capacity limit any more than it could be read as a pass -- so the three invalid rows establish nothing, and the 1400 row in particular must not be turned into a number.
It is also not physically orderable against the 1800 row: at 1,400 offered with ~4.5 ms mean service, expected in-flight is about 6.3, *lighter* than the concurrency-8 window that ran cleanly at p50 3.75 ms. Something happened in that window other than saturation, on a machine at 65 MB of free pages and 8.06 GB of swap.

What the valid windows do establish:

- **Capacity is about 1,786 QPS** (closed-loop, saturating and then declining), and at that point **every percentile is far inside the 41 ms budget** -- p50 3.75, p95 10.08, p99 14.42.
- **1,800 offered was sustained**: offered == completed within 0.4%, in-flight flat, window valid. The *rate* held; the latency did not, at p50 178 ms.
- **The offered rate at which the 41 ms budget still holds was not established.** Three windows that would have bracketed it are invalid, and the honest word for that is "not measured", not "below 1,400".

The rate numbers carry a machine-state caveat. The recall numbers do not: they held at 0.916-0.918 in every window, valid and invalid alike.

**What the whole exercise moved.** Recall is stable at **0.916-0.918 in every single window**, closed and open, at every concurrency and every offered rate, against 0.669 before.

> **The retrieval now works and the cost profile did not materially move.** That is the claim the evidence carries, and it is worth stating carefully because the tempting version is stronger than the data.
> The pre-fix closed-loop ceiling of ~1,805 QPS was measured in the rung-3 era on **IVFFlat at `probes` = 8** with `topK` 50; the 1,786 QPS here is **HNSW at `ef_search` 48** with `topK` 25. The HNSW-with-old-geometry closed-loop ceiling was never measured -- 7.2 reports only single-stream for that arm -- so "1,805 -> 1,786, about 1%" would be putting an index swap and a geometry fix inside one comparison and reporting the difference to three digits.
> What is properly supported is the direction and the mechanism: the mix-weighted sequential cost is 2.59 core-ms, the vector lane alone costs 1.46-1.77 ms across the whole usable `ef` range, and an ANN probe costs what it costs whether or not it finds anything. 6.8 predicted that recall was free to recover in throughput terms; measured from the other side, it was.

#### The 10M rung, re-decided: **still NO-GO, but for a different and smaller reason**

The 2026-08-24 no-go was on **validity**: a 10M run would have produced a throughput figure attached to a recall figure that measured the corpus generator.
**That blocker is gone.** 7.3 fixed the geometry, and 0.917 whole-pipeline recall at 1M with a 0.990 exact ceiling is a measurement of the retrieval system.

The gates were re-checked with measurements rather than projections.

| Gate | Measured / projected to 10M | Verdict |
| --- | --- | --- |
| Validity (the 2026-08-24 blocker) | recall is now a property of the system, not the generator | **PASS -- newly** |
| Disk (<= 30 GB) | 1,831 MB at 1M -> ~18.3 GB, on a volume with **68 GB free** | **pass** |
| Build wall clock (7.1: hours acceptable) | 6 min 04 s at 1M -> ~60 min linear, 2-3 h with superlinearity | **pass** |
| `maintenance_work_mem` must hold the graph | 1,227 B/tuple -> 12.3 GB, **+30% margin = 15.9 GB requested** | **FAIL** |
| Rung 3 throughput ("comfortably above 2,400 QPS") | ceiling **1,786 QPS**, sustainable open-loop below 1,400 | **FAIL** |

**The memory gate, with the numbers rather than an adjective.**
The 1M build requested 1,521 MB and completed without a spill NOTICE. Scaled, 10M needs **15.9 GB**, and that is a *lower bound*: the 1,227 B/tuple constant was measured at `max_parallel_maintenance_workers = 0`, while the real build runs 8 processes sharing a DSM segment.

At the moment of measurement this 24 GB machine had:

- **4,165 free pages -- 65 MB**
- **8,060 MB of 9,216 MB swap already in use**
- 4.54 GB wired, `shared_buffers` 6 GB

Lowering `shared_buffers` to 1 GB via a cluster restart frees 5 GB. That is not the missing 15.9 GB, on a machine already 8 GB into swap.
A build that spills is not a slower build but one whose duration stops extrapolating, which is the entire reason constraint (i) exists -- and a build that thrashes swap fails the same way for a different reason.

**The throughput gate fails independently**, and section 7's rule is that a failed gate stops the ladder rather than getting waived. Rung 3 asks for the 1M bench comfortably above 2,400 QPS; it is at 1,786 QPS saturated, 0.74x the target, with no valid open-loop window at the latency budget.

**So the ladder stops here, and the reason has changed category.**
It is no longer "this measurement would be meaningless" -- it would now be meaningful.
It is "this machine cannot build or serve it", which is a resource statement, answerable by hardware, and one a reader can act on.
The rung that carries a recall claim today is still rung 2 at 50K on real embeddings; what rung 3 now additionally carries is a **working** vector lane at 1M, and the cost profile and rate ceiling that go with it.

#### What the IVFFlat fallback costs in recall, measured at 50K (2026-08-24)

The HNSW build blew the 90-minute gate, so the scale tier runs IVFFlat, and the gate above owes a number for what that costs.
Here it is.
Reproduce with `experiments/recall-bench/scripts/ivf-vs-hnsw.sh`.

Method, because the obvious version of this experiment is confounded.
The 50K table was cloned once into a throwaway schema and **both** arms ran there, so the only difference between the two columns is which vector index exists -- not the schema, not the row order, not the planner's statistics.
`bench_q50k` itself was never touched, because a tuning agent owns it and dropping its index mid-loop would corrupt their measurement and mine.
Only `naive` and `fixedRrf` were run: the tuned profile's weights are fitted against this corpus, and running it here would confound an index comparison with a weighting one.
Test split, 1,000 queries, `hnsw.ef_search` 400 and `ivfflat.probes` 12 as `config.lanes.quality` pins them.

| | HNSW | IVFFlat | Delta |
| --- | --- | --- | --- |
| naive Recall@1 | 0.364 | 0.149 | **-0.215** |
| naive Recall@10 | 0.698 | 0.363 | **-0.335** |
| fixedRrf Recall@1 | 0.619 | 0.599 | -0.020 |
| fixedRrf Recall@10 | 0.897 | 0.823 | **-0.074** |
| Build time at 50K | 18.76 s | 7.89 s | 2.4x faster |

**The vector lane loses about half its standalone recall and the hybrid loses 7 points.**
`naive` is the vector lane by itself, and at `probes = 12` over 224 lists IVFFlat finds barely more than half of what HNSW finds.
The hybrid absorbs most of that because the lexical lanes are looking for the same documents, which is the entire argument for fusion -- but 7.4 points is not nothing, and rung 2's gate is Tuned Recall@10 >= 0.91 with the bootstrap lower bound also >= 0.91.
`fixedRrf` on HNSW already sits at 0.897, so **the quality tier must keep HNSW**, and the scale tier's IVFFlat is a scale-only concession whose recall cost is now on the record rather than assumed small.

This also means the two tiers are no longer measuring the same retrieval system, and any 10M claim inherits the IVFFlat column, not the HNSW one.

> **SUPERSEDED 2026-08-24 by 7.1.** That last sentence was the right conclusion under the 90-minute build gate and is the wrong one now.
> The gate was revised, the scale tier returned to HNSW, and the two tiers measure the same index family again.
> The 50K numbers in the table above still stand as measurements -- they are simply no longer the reason the scale tier runs what it runs.

#### Rung 3 results (2026-08-24): the per-query cost profile, and two measurement bugs found on the way

**Corpus and index, as built.** 1M rows, `bench_r1m`, 1,381 MB total including indexes and toast.
The HNSW build was projected at 186 minutes for 10M against the 90-minute gate, so the gate fired and the design's IVFFlat fallback is what the schema now carries (`memories_embedding_ivfflat`, 533 MB).

**The per-family cost profile.**
One connection, sequential, no load generator, striding the query files so every family is represented in its real proportion.
Measuring this way is deliberate: it isolates per-query service demand from anything the load harness does to it, and it is the only measurement on this machine that a suspend delays rather than corrupts.
Means, taken with nothing else running on the box; the per-lane table below uses medians, and the note after it explains why that distinction changed a headline once.

| Family | Share of mix | Total ms | of which SQL | of which rerank | Lanes returning rows |
| --- | --- | --- | --- | --- | --- |
| paraphrase_nolex | 0.23 | 5.78 | 5.66 | 0.07 | and 30.0, vector 29.7, or 8.4 |
| rare_token | 0.22 | 4.12 | 4.10 | 0.00 | vector 30.0, and 1.0, or 1.0 |
| entity_swap | 0.11 | 8.40 | 8.05 | 0.18 | vector 30.0, and 20.6 |
| near_dup | 0.15 | 5.39 | 5.24 | 0.14 | vector 30.0, or 20.2, and 1.0 |
| date_filter | 0.15 | 15.47 | 15.23 | 0.09 | vector 27.5, and 18.5, or 16.0 |
| partial_ref | 0.07 | 5.62 | 5.57 | 0.00 | vector 30.0, or 5.4 |
| typo_noisy | 0.07 | 3.67 | 3.55 | 0.00 | vector 30.0, and 1.0, or 1.0 |
| **mix-weighted** | | **6.94** | **6.78** | **0.08** | |

Two things fall straight out of this table.

**Node is not the bottleneck, and the design's worry about it was misplaced.**
Rerank costs 0.00-0.18 ms and the whole non-SQL remainder is 0.10-0.35 ms, against 6.78 ms of SQL.
Section 8.1's `SELECT 1` ceiling probe agrees from the other direction: 105,324 QPS, p50 0.29 ms, against a 9,600 QPS floor.
Multiple client processes would buy nothing; the work is in Postgres.

**The target is above the machine's measured ceiling, and by a knowable amount.**
2,400 QPS on 12 cores allows roughly 5 core-ms per query (section 6.6's own arithmetic).
The workload costs 6.94.
That is a 39% overshoot: 12 cores / 6.94 ms is 1,729 QPS of pure service capacity, and the corrected closed-loop sweep below measures 1,300.
**Clearing 2,400 QPS at 1M requires cutting roughly 2 core-ms per query, not tuning the pool.**
`date_filter` is where that cut has to come from: 15% of the mix carrying 33% of the total cost.

**Where the cost actually sits, per lane.**
Same queries run under lane subsets, medians so a suspend inflates one sample instead of the result, all connections carrying the pinned GUCs.

| Family | and+or+vector | and+vector | vector only | and only | marginal OR | marginal AND |
| --- | --- | --- | --- | --- | --- | --- |
| date_filter | 11.61 ms | 9.60 ms | 3.24 ms | 8.70 ms | 2.01 ms | 6.36 ms |
| entity_swap | 7.42 ms | 6.98 ms | 3.01 ms | 6.87 ms | 0.44 ms | 3.97 ms |
| paraphrase_nolex | 4.96 ms | 3.40 ms | 3.04 ms | 3.37 ms | 1.56 ms | 0.36 ms |

Re-measured after `perf(recall-bench): stem the OR fragment bar once per query` landed mid-session, same method:

| Family | and+or+vector | and+vector | vector only | and only | marginal OR | marginal AND |
| --- | --- | --- | --- | --- | --- | --- |
| date_filter | 10.30 ms | 9.78 ms | 3.26 ms | 8.96 ms | 0.52 ms | 6.52 ms |
| paraphrase_nolex | 5.46 ms | 3.38 ms | 3.12 ms | 3.58 ms | 2.08 ms | 0.26 ms |

The OR lane got cheaper on `date_filter` (2.01 -> 0.52 ms) and the two numbers this section rests on did not move: the vector lane holds at ~3.26 ms and the date-constrained AND lane at 6.52 ms marginal.

**A note on method, because it changed a headline once.**
These are medians over per-query timings, not means.
Anything else sharing the machine lands as a handful of large samples, and a mean turns that into a wrong number: the same per-family profile measured 7.23 ms mean on an idle box and 16.11 ms with the corpus tests running alongside, while the medians barely moved.
Every timing in this section was taken sequentially on one connection for the same reason.

**This overturns the assumption section 6.6 left standing.**
`date_filter` was expensive because of its filtered vector lane, and the fix for that was iterative scan.
It is not: the filtered vector lane costs 3.24 ms, in line with every other family's vector lane, while **the AND lane costs 6.36 ms marginal on this family** -- a date-constrained conjunction paying for a `BitmapAnd` of the `occurred_at` btree against the FTS GIN.
The date filter made the *conjunction* expensive, not the ANN search.

**What the section-6.6 gating policy is worth, priced against this table.**
Skipping the OR lane where the AND lane already fills its cap saves 2.01 ms on 15% of the mix; skipping both lexical lanes for a no-rare-term paraphrase saves 1.92 ms on 23%.
Together that is about 0.74 ms off the 6.94 ms weighted mean, landing near 6.20 ms, or roughly 1,935 QPS of service capacity.
**Real, and not enough.** 2,400 QPS needs 5.0 ms, so a further 1.2 ms would have to come out of the vector lane, which costs ~3.0 ms uniformly across every family and is the one lane whose depth and probe count are already priced against recall.
The honest reading is that 2,400 QPS at 1M is out of reach on this 12-core machine at the recall the config pins, and section 9's rule for that case is to report the ceiling found.

**Bug 1: the vector GUCs reached one connection out of the pool, not all of them.**
`engine.applyVectorGucs` caches on a `WeakMap` keyed by the `client` it is handed, and both benches hand it the `Pool`.
So the cache went per-pool while the `SET` landed on whichever single physical connection served the first query.

Measured against `bench_r1m` -- one awaited query, then a concurrent burst -- **1 of 8 backends carried the pinned `ivfflat.probes = 8`; the other 7 ran pgvector's defaults, `probes = 1` with `hnsw.iterative_scan = off`.**
A vector lane searching one IVFFlat list instead of eight is quietly faster and much less accurate, and a filtered lane with iterative scan off returns 0-5 rows of 30 by section 6.6's own table.
The race corrupts latency and recall together, in the flattering direction.

It only looked correct in an earlier check because a concurrent startup burst has every request see an empty cache at once, so they all issue the `SET` and between them cover the pool.
That is luck, and a pool that grows after warmup loses it.

**Every open-loop number recorded before this fix is optimistic and was measured at an unknown vector recall**, including the 700 and 900 QPS passes.
The fix applies the settings as Postgres startup `options` on the connection string, so the server has them before the connection is handed out: no round trip, no window in which a query can run without them, and nothing to race. Re-measured: 8 of 8 backends.

**The corrected closed-loop ceiling.**
Re-measured after the GUC fix, on an idle machine, with every window's suspend detector reading clean (max ticker stall 0.01-0.07 s):

| Concurrency | Completed QPS | p50 | p99 | server sqlMs | window |
| --- | --- | --- | --- | --- | --- |
| 8 | 1,012 | 6.92 ms | 19.58 ms | 7.70 ms | valid |
| 16 | 1,249 | 10.20 ms | 49.12 ms | 12.58 ms | valid |
| 32 | 1,300 | 17.93 ms | 106.76 ms | 24.49 ms | valid |

Throughput is flat by concurrency 32 while latency is still climbing, which is the saturation knee.
**The ceiling is ~1,300 QPS, not the ~1,850 recorded before.**
The earlier figure was measured while most pooled connections were running `ivfflat.probes = 1` instead of 8 -- the bug below -- so it was reading a cheaper and less accurate vector lane and reporting it as the system.
1,300 QPS also brackets the 1,729 that 12 cores / 6.94 core-ms predicts, the gap being per-query overhead the profile does not charge to any single lane.

**Claim B's target is 1.85x the measured ceiling at 1M.**
That is the finding, and no pool size reaches it: at concurrency 8 the pool is nowhere near saturated and the machine is already at 1,012 QPS.

**Bug 2: a measurement window that spans a machine suspend still reports a number.**
This machine runs on battery, and its battery power profile carries `sleep 1` against AC's `sleep 0`.
`pmset` logged repeated `Maintenance Sleep` entries during measurement, including one of **659 seconds** that landed inside a closed-loop sweep.
A window spanning one reports `offered == completed` and a plausible QPS with a p50 in the hundreds of seconds -- it passes every validity condition section 8.2 lists.

Comparing the wall clock against Node's monotonic clock does not detect this, because Darwin's clock keeps advancing across a suspend and the two agree.
The dispatch ticker does: it is scheduled every 10 ms, so a multi-second gap between consecutive ticks can only mean the machine stopped running us.
`assessWindow` now reports every window's verdict and a suspended or overrunning window fails the gate on its own.

**This is a hard blocker on the remaining rate-based measurements, and it needs AC power, not code.**
`caffeinate -s` asserts `PreventSystemSleep`, but the system-wide assertion still reads 0 while on battery -- macOS documents `-s` as valid only on AC power, and it is not honoring it.
Until the machine is plugged in, no open-loop or closed-loop window on this box is trustworthy, so the knee sweep, the 2,400 QPS run, and the 10M rung are all gated on that.

#### Re-measured after section 6.7's cost work (2026-08-24, on AC power)

Reproduce with `experiments/recall-bench/scripts/full-validation.sh`, which enforces all three validity conditions this machine can violate: AC power, the suspend verdict, and a contention sampler that watches for the tuning agent's `bench_q50k` bursts every 5 seconds across the whole window.

**The closed-loop ceiling sweep.**
Every window 60 s warmup plus 120 s measured, every window `valid`, and the sweep as a whole recorded zero contended samples.

| Concurrency | Completed QPS | p50 | p95 | p99 | server sqlMs | window |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | 1,509 | 5.12 ms | 9.88 ms | 11.25 ms | 5.15 ms | valid |
| 16 | 1,778 | 7.87 ms | 17.57 ms | 35.82 ms | 8.80 ms | valid |
| 32 | **1,805** | 15.52 ms | 35.98 ms | 83.04 ms | 17.58 ms | valid |
| 64 | 1,710 | 35.45 ms | 80.68 ms | 143.23 ms | 37.23 ms | valid |

**The closed-loop ceiling moved from ~1,300 QPS to ~1,800**, a 39% gain.
The knee is at concurrency 16 to 32, and 64 is past it: throughput falls while latency doubles, which is the shape of a saturated machine being asked for more.

**The open-loop runs, which are the ones that decide the gate.**
Closed-loop reports what a saturated machine completes; open-loop asks whether a fixed arrival rate is sustainable, and the gate additionally fails a window whose in-flight count is growing.

| Offered | Completed | p50 | p95 | in-flight growing | window | gate |
| --- | --- | --- | --- | --- | --- | --- |
| 1,200 | 1,200.1 | 12.99 ms | 412 ms | no | valid | **PASS** |
| 1,800 | 1,944.8 | 34,680 ms | 53,536 ms | yes | INVALID, overran 31% | FAIL |
| 2,400 | 2,808.5 | 91,082 ms | 151,162 ms | yes | INVALID, overran 88% | FAIL |

The 1,800 and 2,400 windows were both clean of contention, so those are real results rather than artefacts.
The 1,200 window passed *while* contended, which makes it a conservative pass.
An earlier short-window pass at 1,200 read p50 12.24 ms and p90 37.99 ms, and a 1,400 QPS window failed on in-flight growth despite a healthy-looking p50 of 14.60 ms, so **the sustainable open-loop rate sits between 1,200 and 1,400 QPS**.

**2,400 QPS is not reachable at 1M on this machine.**
Offering it produces a p50 of 91 seconds and a window that overruns its own schedule by 88%, which is a queue, not a service rate.

**The service-demand profile overpredicts throughput, and by more than it used to.**
12 cores divided by 3.64 core-ms predicts 3,297 QPS; the machine delivers 1,805 closed-loop and 1,200 to 1,400 sustainable.
That is a 45% overprediction against the 33% the 6.94 profile showed, so the per-query overhead the lane profile charges to no lane did not shrink when the SQL did -- it is now the larger half of the story.
Quoting the profile's projected QPS as a throughput result would repeat exactly the error the retracted 1,850 figure made, so it is not quoted as one here.

#### What the machine is actually short of (2026-08-24)

The gap between 3.64 core-ms of sequential service demand and 1,805 QPS measured is not a Postgres contention problem, and it is not memory bandwidth.
It is core count, and the count is not 12.

**There is no contended Postgres resource.**
`pg_stat_activity` sampled at 15 Hz for 45 s across the bench's own backends during a concurrency-32 window, 20,724 backend-observations (reproduce with `experiments/recall-bench/scripts/wait-sample.mjs`):

| Wait state | Share |
| --- | --- |
| ON CPU, no wait event | 53.0% |
| `Client` / `ClientRead` (idle between queries) | 47.0% |
| Locks, LWLocks, IO, buffer pins, everything else | **0.0%** |

Not one observation of a lock, a latch, or an IO wait.
Every backend is either running on a core or waiting for the client to speak.
There is nothing inside Postgres to tune here.

**It is not memory bandwidth either, and a low-concurrency sweep is what separates the two.**
A saturating shared resource inflates latency from the very first added stream.
This does not:

| Concurrency | Completed QPS | p50 | Throughput vs single-stream |
| --- | --- | --- | --- |
| 1 | 228.3 | 4.18 ms | 1.00x |
| 2 | 450.8 | 4.29 ms | 1.97x |
| 4 | 867.9 | 4.32 ms | 3.80x |
| 8 | 1,517.0 | 5.04 ms | 6.64x |
| 12 | 1,794.8 | 6.46 ms | 7.86x |

p50 is flat from 1 to 4 streams -- 4.18 ms to 4.32 ms, 3% -- and scaling is near-linear at 3.80x of 4.
Degradation begins only as the machine runs out of fast cores.

**The hardware fact the 2,400 QPS arithmetic missed.**
This is an Apple M4 Pro: `hw.perflevel0.logicalcpu` is **8 performance cores** and `hw.perflevel1.logicalcpu` is **4 efficiency cores**.
Section 6.6's budget of "roughly 5 core-ms per query, 2,400 QPS on 12 cores" treats all twelve as equal.
They are not, and the measurement agrees: twelve concurrent streams deliver 7.86 single-stream equivalents, not 12.

**What that implies for claim B, stated as arithmetic rather than as a verdict.**
Usable parallelism is about 7.9x, so peak throughput is roughly `7.86 x 1000 / p50_single_stream`.
Hitting 2,400 QPS needs a single-stream p50 at or under **3.28 ms**, against the 4.18 ms measured now.
That is a 22% cut, not the 2x the raw core arithmetic implied -- so the target is closer than the ceiling suggests.

**But the cheap 22% is not available, and 6.8 is why.**
The obvious levers are all vector-lane levers: fewer probes, shallower lanes, a smaller final candidate set.
The vector lane already returns the target 15% of the time at `probes = 8`, so spending its recall to buy latency is spending something the tier does not have.
The honest options are the ones that cost no recall -- narrowing the final projection to the columns rerank actually reads, and anything else provably neutral by the id-list diff method 6.7 used -- and whether those add up to 22% is an open measurement, not a prediction.

**A note on contention, because it invalidated two windows before it was caught.**
A tuning agent runs `bench-recall` against `bench_q50k` on this same cluster in bursts.
Checking `pgrep` once before a window is not enough: a burst that starts ten seconds in steals one of twelve cores for most of the measurement, and the window still reports a plausible number.
One 1,200 QPS window read p50 12.24 ms with p90 37.99 ms clean, and p50 13.01 ms with p90 1,073 ms while contended -- same rate, same code, same machine, and only the tail gives it away.
The first 8/16/32/64 sweep attempt overlapped the tuner in 133 of its 5-second samples and was discarded and re-run rather than reported.

### Rung 4: 10M full run -- **claim B**

The claim run.
`bench-load.mjs --tier full10m --profile tunedScale --mode open --offered-qps 2400 --duration 120 --warmup 60`.

Gate: sustained 2,400 QPS with offered == completed, p50 <= 41 ms.

**Status (2026-08-24, updated after section 6.7's cost work): still not started, and rung 3's gate is still not met -- but by a much smaller margin.**

Rung 3's third gate is "1M load bench comfortably above 2,400 QPS".
The closed-loop ceiling is now ~1,805 QPS, up from 1,300, and the sustainable open-loop rate is between 1,200 and 1,400.
Against the 2,400 QPS target that is 1.33x on the saturation ceiling and about 1.9x on the sustainable rate.
Offering 2,400 directly produces a p50 of 91 seconds, so this is not a marginal miss.
Section 7's rule is that a failed gate stops the ladder rather than getting waived, so the 10M build still does not start.

What changed is that the gap is no longer obviously structural.
The earlier reading was that 2,400 QPS was out of reach "at the recall the config pins", on the grounds that the remaining cost was the vector lane and the vector lane is already priced against recall.
That reasoning held only while ~4.3 ms per query was being spent recomputing a tsvector, which cost recall nothing at all.
With that gone, the honest position is narrower: the workload now costs 3.56 core-ms of service demand and the machine still only delivers 1,900 QPS, so **the binding constraint has moved out of the SQL and into per-query overhead the lane profile does not account for**.
Section 8.1's `SELECT 1` probe still reports 92,000-110,000 QPS, so it is not the client and it is not the round trip.
Finding it is the next question, and it is a different question from the one this section has been answering.

The footprint half of the go/no-go still projects cleanly, with the stored tsvector column included: 1,608 MB at 1M extrapolates to about 16 GB at 10M, inside the 30 GB budget, with 56 GB free on the volume.
Footprint was never the binding constraint and still is not.

---

#### The 10M go/no-go, decided 2026-08-24 after the HNSW rebuild: **NO-GO, on validity rather than on resources**

> **RE-DECIDED 2026-08-25 in 7.4: still NO-GO, but on resources rather than on validity -- the exact inverse of this section's title.**
> The validity blocker below was removed by the geometry fix (7.3): whole-pipeline recall at 1M is now 0.917 against a 0.990 exact ceiling, so a 10M run would measure the retrieval system rather than the generator.
> What blocks it now is measurable and answerable by hardware: the build needs 15.9 GB of `maintenance_work_mem` on a 24 GB machine sitting at 65 MB of free pages with 8.06 GB already in swap, and rung 3's throughput gate fails independently at 1,786 QPS against 2,400.
> The constraint this section states at the end -- "a same-cluster sibling must sit above the top-30 noise floor" -- was implemented, with one correction: the floor to calibrate against is the **10M** one (0.283), not the 1M one (0.251), or the corpus fails again at the tier the constants exist to serve.

The three resource gates were the reason this decision kept getting deferred, so they are answered first, with measurements rather than projections.
All three pass, or pass with one caveat.

| Gate | Projection to 10M | Verdict |
| --- | --- | --- |
| Disk footprint (<= 30 GB) | 1,831 MB at 1M on HNSW -> **~18.3 GB**, on a volume with 56 GB free | **pass** |
| Build wall clock (7.1: several hours acceptable) | 6 min 43 s at 1M with 8 processes -> **~70 min linear, call it 2-3 hours with HNSW's superlinearity** | **pass** |
| `maintenance_work_mem` must hold the graph (7.1 constraint (i)) | 1,227 bytes/tuple measured -> **~12.3 GB at 10M** | **tight, see below** |

The memory gate is the only uncomfortable one and it deserves its number stated honestly rather than rounded into comfort.
1,227 bytes/tuple was measured with `max_parallel_maintenance_workers = 0`, while the real build runs 8 processes sharing a DSM segment, so **12.3 GB is a lower bound on the requirement, not the requirement**; a 10M build should request nearer 16 GB.
This machine has 24 GB total and was sitting at **79 MB unused with 10.8 GB held by the compressor** while the 1M build ran.
`shared_buffers` is 6 GB and would have to come down for the build session, which needs a cluster restart rather than a `SET`.
It is probably doable. It is not comfortable, and a build that spills is not a slower build but one whose duration stops extrapolating -- which is exactly what constraint (i) exists to prevent.

**None of that is why the run does not proceed.**

The 10M rung exists to produce claim B: a sustained rate at 10M for a *hybrid retrieval* system.
7.2 establishes that at the synthetic tiers the vector lane's recall is not a property of the retrieval system at all.
It is a property of `lib/synth-vectors.mjs`'s `jitter` and `drift` constants: the generator places every query beside exactly one point and leaves the other 999,999 as an undifferentiated noise floor, so no ANN index can route to the target and both IVFFlat and HNSW fail at it for different reasons.
A 10M claim-B run would therefore produce a throughput figure attached to a recall figure that measures the corpus generator.
Reporting that pair as evidence for hybrid retrieval at 10M would repeat, at ten times the cost, exactly the error deviation 2 already made once.

**This is a stronger reason to stop than a resource gate, because it cannot be answered by buying hardware.**
More cores raise the rate. They do not make the vector lane find anything.

**What would make the 10M rung meaningful**, stated as a constraint rather than a tuned value, because the value has not been measured:

> The generator's cluster structure has to exist in the vector space. Concretely, a same-cluster sibling must sit **above** the top-30 noise floor from the query's point of view. Today it sits below: sibling-to-query cosine is 0.185 against a rank-30 floor of 0.248. That means a materially smaller `DEFAULT_MEMORY_JITTER` -- the perturbation norm is `jitter * sqrt(dims)`, so 0.10 at 256 dims perturbs by 1.6 against a unit centroid, and the direction of the fix is toward roughly 0.03-0.05 -- and/or a smaller `DEFAULT_QUERY_DRIFT` so a query lands inside its target's neighbourhood rather than beside it.

That is a Track 2 change to `gen-corpus.mjs` and `lib/synth-vectors.mjs`, it invalidates the existing 1M and 10M corpora, and it is the prerequisite for any recall claim at either synthetic tier.
Until it lands, the rungs that can carry a recall claim are the real-embedding ones: rung 2 at 50K measures the same pipeline against real 768-dim vectors and reports fixedRrf Recall@10 of 0.897 on HNSW, which is the number that describes this retrieval system.

**What the 1M rung does still establish**, and what a reader should take from it, is in the tables above and in section 8: the per-query cost profile, the closed-loop ceiling, the sustainable open-loop rate, and the recall each of those was produced at.
Those are real measurements of a real system under a real query load.
They are simply not a recall claim.

---

## 8. Measuring claim B honestly

### 8.1 The client must not be the bottleneck

On macOS, Docker's published-port path crosses the VM's network stack, and at 2,400 QPS that forwarding can become the thing being measured.

**Step 0 of every load run is a `SELECT 1` ceiling probe** (`--mode select1`) in both modes.
If the trivial-query ceiling is not at least 4x the target -- roughly 10,000 QPS -- the harness is measuring Docker's network and the run is invalid.

The primary mode is a **sidecar client**: a `node:22-alpine` container started with `--network container:fuzzy-bench-pg`, which puts it in the database container's network namespace so traffic never crosses the VM boundary.

Two details implementers get wrong, so they are spelled out:

- Inside that namespace the database is at **`127.0.0.1:5432`**, not 55433. Port 55433 is the *host*-side publication and does not exist in the namespace. `assertBenchTarget` accepts `127.0.0.1:5432/recallbench` **only** when `BENCH_IN_CONTAINER=1` is set, which `bench-load.mjs --in-container` sets and nothing else does.
- The sidecar has no published port of its own, so results cannot be scraped over HTTP. It writes JSON to a bind-mounted `.out/` directory and the host reads the file after it exits.

The host-forwarded number is measured too and reported as a secondary, with the gap between the two stated. If the sidecar hits 2,400 QPS and the forwarded path does not, that is a Docker networking fact about this machine, and the report says exactly that rather than picking whichever number is nicer.

### 8.2 Open-loop, because closed-loop hides the median

The headline number is **open-loop**: a fixed 2,400 requests/sec arrival schedule for at least 120 seconds after a 60-second warmup, with each request timestamped at its *scheduled* time, not its dispatch time.

Closed-loop at ~98 in flight can report 2,400 QPS while coordinated omission quietly hides the real median: when the server stalls, the client stops offering work, so the slow period never gets sampled.
The open-loop run cannot do that.

Validity conditions, all reported, and any of them failing invalidates the run:

- `offered == completed` (within 0.5%), and in-flight count is flat across the measurement window rather than growing. A growing queue means the system is not sustaining the rate, whatever the completed count says.
- Warmup is separate and excluded. Page cache state is reported (`pg_statio_user_tables` hit ratio) so "hot index" is a measured claim.
- Latency is wall-clock at the client, scheduled-time to last-byte, including the rerank in Node. Nothing is subtracted.

The **closed-loop concurrency sweep** (8 -> 192) is reported as the secondary curve, showing where throughput saturates and where latency knees. It is useful context, not the claim.

### 8.3 Query realism

- 200,000 distinct generated queries, drawn in a shuffled cycle with no immediate repetition, so the result is not a measurement of Postgres's caches serving the same 100 queries.
- Query vectors are pre-generated deterministically by `synth-vectors.mjs` (no model in the hot loop) and held in a preallocated `Float32Array` buffer.
- The family mix matches the quality tier, so the same range of lane weights and filter paths is exercised -- a load test that only fires easy queries is not testing the system that claim A describes. The one difference: `typo_noisy` queries still run, they just have no trigram lane to fall into at this tier, so they cost less than they would at the quality tier. That is stated in the report rather than hidden by dropping the family.
- Prepared statements, named, one per profile, reused across a pooled connection (96 connections). Parse and plan cost is paid once per connection, which is what any real deployment does.

### 8.4 What gets reported

QPS offered, QPS completed, p50, p90, p95, p99, p99.9, max; server-side `sqlMs` versus client-side total so the Node overhead is visible; `rerankMs` separately; buffer hit ratio; rows examined per lane; and the `SELECT 1` ceiling from step 0.

---

## 9. Risks, and what happens instead

| Risk | Detection | Fallback |
| --- | --- | --- |
| Docker VM under-provisioned | `pg-up.sh` prerequisite check | Abort with instructions; do not run a memory-starved benchmark and report the number |
| `halfvec` unavailable | Smoke-tier gate | `vector(256)`; re-run the disk budget (10M total goes ~17.7 GB -> ~23 GB) |
| HNSW build spills out of `maintenance_work_mem` | pgvector's build log line, watched at 1M | IVFFlat, `lists = 3162`, `probes = 12`; re-measure quality at 50K to price the recall cost |
| Filtered vector lane starves | 1M rehearsal: filtered lane returns < 30 rows more than 1% of the time | `hnsw.iterative_scan = relaxed_order`, measured not assumed |
| Docker port forwarding caps QPS | `--mode select1` ceiling probe | Sidecar client in the database's network namespace; report both numbers |
| Best-lane-rank@10 too low for 0.91 | `gen-corpus --verify` gate at 1K and 50K | Loosen the mix **before** the freeze point; never after |
| Naive baseline outside 60-80% | Calibration step 3, watching naive only | Adjust the family mix, re-run from step 1; the tuned number is never consulted during calibration |
| Tuned lands below 0.91 | Test-split run | **Report the number that was measured.** The ablation table and the failure taxonomy say which family is short, and the honest output is "0.88, and here is why" |

That last row is the one that matters.
The harness exists to find out whether the claims are true, and a design that can only produce a passing number is not measuring anything.

---

## 10. Parallel work split

Five tracks, disjoint file sets, all gated on the contract landing first.

| Track | Files | Depends on |
| --- | --- | --- |
| **0. Contract** | `config.mjs`, `schemas.mjs`, `lib/safety.mjs`, `tests/contract.test.mjs`, `tests/safety.test.mjs` | nothing; **lands first** |
| **1. Infra** | `infra/*` | contract |
| **2. Corpus** | `gen-corpus.mjs`, `lib/rng.mjs`, `lib/lexicon.mjs`, `lib/synth-vectors.mjs`, `lib/jsonl.mjs`, `tests/rng.test.mjs`, `tests/gen-corpus.test.mjs` | contract |
| **3. Engine** | `engine.mjs`, `rerank.mjs`, `tests/engine.test.mjs`, `tests/rerank.test.mjs` | contract |
| **4. Benches** | `load.mjs`, `bench-recall.mjs`, `bench-load.mjs`, `lib/stats.mjs`, `lib/report.mjs`, `tests/smoke.test.mjs`, `README.md` | contract, plus tracks 1-3 for the smoke test |

Commits follow the repo convention: one step per commit, Conventional Commits, e.g. `feat(recall-bench): freeze corpus and config contracts`, then `feat(recall-bench): add seeded corpus generator`, then `test(recall-bench): certify query solvability`.
The changelog entry and version bump land when the harness itself ships, not with this design note.

---

## 11. Summary of measured numbers

- Embedding throughput, memory-length bodies (367 chars): **50.4 texts/sec** at batch 64, 48.0 at batch 32, 43.5 at batch 16.
- Embedding throughput, short lines (~80 chars): 105 texts/sec.
- Single query embed: 12.8 ms.
- Model load plus first inference (weights cached): 414 ms.
- Multi-process sharding: 3 workers aggregate 54.9 texts/sec, 6 workers 50.5 texts/sec, versus ~50 single-process. onnxruntime already saturates the cores; a worker pool is not worth building.
- **51,000 embeddings ~= 17 minutes single-process, batch 64.** The full quality-tier sweep of 52,000 texts ~= 17.3 minutes.

---

## 12. ADDENDUM (2026-08-23, supersedes every Docker reference above): native Postgres, not Docker

Docker Desktop crashes on startup on this machine (backend exit status 150, socket never appears), so the container path is dead.
The verified replacement is strictly better for claim B because there is no VM boundary and the full 24 GB of host RAM serves as page cache:

- Server: Homebrew PostgreSQL 17.11 at `/opt/homebrew/opt/postgresql@17/bin` with pgvector 0.8.6 linked in. Verified working: `create extension vector`, `create extension pg_trgm`, `halfvec` literals. Note the share/lib dirs were merged by symlink into `/opt/homebrew/share/postgresql@17` and `/opt/homebrew/lib/postgresql@17`; this is already done, scripts must not redo it.
- Cluster: a throwaway data directory at `experiments/recall-bench/.data/pgdata`, created by `initdb -U bench --no-locale -E UTF8`, started with `pg_ctl -o "-p 55433 -c unix_socket_directories=/tmp -c listen_addresses=127.0.0.1"`. `pg-down.sh` stops it and deletes the data directory. Connect over TCP only; socket paths under the repo exceed the 103-byte macOS limit.
- The connection allowlist in `lib/safety.mjs` is unchanged: `127.0.0.1:55433/recallbench`. Drop the `BENCH_IN_CONTAINER` special case entirely.
- Rung 0 gates change: no Docker checks, no VM memory check. Keep the free-disk gate, the extension gates, and apply `infra/postgresql.bench.conf` via `-c config_file` or by appending to `postgresql.conf` (values in section 7 stand, but `shared_buffers = 6GB` is enough now that the host page cache is not split with a VM).
- Section 8.1 collapses: no sidecar container. The load client is plain local Node over loopback TCP. Keep the `SELECT 1` ceiling probe as the client-bottleneck check; loopback should clear 10K QPS easily, and if it does not, the client itself is the bottleneck and the run is invalid.
- `psql.sh` wraps `/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench`, not docker exec.
