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
| `paraphrase_nolex` | 20% | Query drawn from the topic's **paraphrase vocabulary**, which shares no stems with the memory vocabulary. Jaccard overlap is asserted to be 0. | FTS AND returns nothing; OR returns noise | Vector lane, up-weighted when `looksParaphrase` |
| `rare_token` | 15% | A globally unique token (`kbz-4417`, an odd surname, a one-off product name) present in exactly one memory | Vector lane: a rare token barely moves a 768-dim sentence embedding, so cosine ranks topical neighbors above the exact match | AND lane up-weighted on high `maxIdf`, plus the `rareHit` rerank feature |
| `entity_swap` | 15% | 2-4 memories identical in topic and phrasing, differing only in the person or place | Vector lane: near-identical sentences, cosine cannot separate them | Entity extraction + `entity` rerank feature + AND-lane boost |
| `near_dup` | 15% | A `dup_group` of 3-8 near-identical memories; only one carries the `distinguisher` the query mentions | Both lexical and vector: the siblings crowd the top 10 | `dupPenalty` rerank feature (demote later members of an already-represented group) + the distinguisher term |
| `date_filter` | 15% | The same recurring event across 4-6 years; the query names one year or month | Every lane without metadata: all years look identical | Closed-world date parsing -> `occurred_at` range filter + `dateFit` rerank feature |
| `partial_ref` | 10% | A half-remembered reference: one true detail plus vague framing ("the thing I said about the kitchen after we moved") | AND lane (too few matching terms) | OR lane with a fragment bar, fused with vector |
| `typo_noisy` | 10% | 1-2 character-level corruptions on the discriminating term | AND lane returns nothing; OR lane returns noise | Trigram lane, activated when `oovRatio` crosses the floor |

The projected naive score, family by family (vector-only top-10 over the full corpus): 0.20 x 0.95 + 0.15 x 0.35 + 0.15 x 0.50 + 0.15 x 0.55 + 0.15 x 0.45 + 0.10 x 0.80 + 0.10 x 0.60 = **~0.61**.
That is a projection, not a result.
The calibration procedure in 4.4 is what turns it into a number, and the mix is allowed to move only inside that procedure.

**Measured at the 1K smoke tier (2026-08-23), the projection is optimistic about how badly a modern embedder does.**
Naive came in at 0.880, with the per-family vector-only numbers landing well above their projections for the families whose lane the vector was supposed to break -- `rare_token` 1.000 against 0.35, `entity_swap` 1.000 against 0.50.
The `entity_swap` result was checked rather than assumed: its group members now render byte-identical prose apart from the swapped entity, and cosine still ranks the queried name first, so a name token dominates 350 characters of otherwise identical text.
There is also an arithmetic floor under naive that no dial reaches.
`paraphrase_nolex` is 20% of the mix and the vector lane is its only lane, so the 0.97 ceiling gate forces its vector recall to ~0.97 and it contributes ~0.194 to naive unconditionally; naive <= 0.85 therefore requires the other 80% to average <= 0.82, and measured they average 0.89.
Two resolutions exist and both change a frozen contract, so neither is taken here: shift the mix away from `paraphrase_nolex` toward the families a non-vector lane solves (4.4's own prescription, but it invalidates the projections above), or accept that the smoke band was set against a projection the real embedder disproves and re-check the band at 50K, where competitor density is 50x higher.

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
- Projected HNSW build <= 90 minutes. Over that, **switch to IVFFlat** (`lists = 3162`, about `sqrt(10M)`, `ivfflat.probes = 12`), which builds in a fraction of the time at some recall cost, and record the recall cost by re-running rung 2's quality bench against an IVFFlat index at 50K.
- 1M load bench comfortably above 2,400 QPS. If 1M cannot clear it, 10M certainly cannot, and the honest move is to report the ceiling found rather than proceed.

### Rung 4: 10M full run -- **claim B**

The claim run.
`bench-load.mjs --tier full10m --profile tunedScale --mode open --offered-qps 2400 --duration 120 --warmup 60`.

Gate: sustained 2,400 QPS with offered == completed, p50 <= 41 ms.

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
