// load.mjs -- bulk COPY ingest, the real-embedding sweep (quality tier), the
// synthetic-vector fill (scale tier), and index build, with timing logs.
// Implements DESIGN.md's "load.mjs" row in section 2 and the function
// signatures + CLI in section 3.6/3.7.
//
// Usage (section 3.7):
//   node load.mjs --tier <name> [--stream] [--skip-embed] [--verify-oracle]
//     [--vector-index hnsw|ivfflat] [--resume]
//
// Deviations from the literal DESIGN.md text, and why, collected here rather
// than scattered, matching the convention already used by bench-recall.mjs
// and bench-load.mjs on this branch:
//
// 1. createSchema/buildIndexes reimplement the DDL directly in JS (matching
//    infra/schema.sql's table definitions column for column) instead of
//    shelling out to that file. schema.sql always `drop table if exists`s
//    before recreating and always builds an HNSW vector index inline with
//    the table, with no ivfflat path -- both are incompatible with this
//    module's own contract: --resume must never drop existing data, and
//    buildIndexes is a separately timed step that takes an explicit
//    vectorIndex choice. Table columns are kept identical to schema.sql's
//    so the two DDL sources cannot drift apart in shape, only in policy
//    (if-not-exists vs. drop-and-recreate, indexes-after vs. indexes-inline).
// 2. kind_id/person_id/place_id (the synthetic-tier columns) are not on the
//    frozen MemoryRecord shape (section 3.1), which is the one record shape
//    documented across all four tiers. copyMemories derives them
//    deterministically from kind/people[0]/places[0] via lib/rng.mjs's
//    hashString (a frozen signature, section 3.6) whenever a record does not
//    already carry those fields directly, so this stays correct regardless
//    of which shape gen-corpus.mjs's synthetic-tier generator ends up using.
// 3. memoryVector()'s `jitter` parameter has no config.mjs field (the frozen
//    3.4 listing does not add one, and config.mjs's own header says it is
//    additive-only for genuinely missing tunables -- this is a call-site
//    constant, not a tunable other modules share). SYNTH_MEMORY_JITTER below
//    is a load.mjs-local default. queryVector() is not called from this
//    file: bench-load.mjs's own header states it fetches each query target's
//    stored `embedding` straight from the database instead, so there is no
//    load.mjs call site that needs a drift constant.
// 4. lib/jsonl.mjs's exact read/write signature is not frozen in section 3.6
//    (only its responsibility is named in section 2), and the two sibling
//    bench-*.mjs files already disagree about depending on it (bench-recall
//    imports readJsonl/writeJsonl; bench-load inlines its own reader for
//    exactly this reason). This file follows bench-load.mjs's precedent and
//    inlines a small streaming JSONL reader rather than betting on a shape
//    nobody has pinned down yet.
// 5. The query-vector cache file format is pinned by bench-recall.mjs's own
//    header comment (already committed on this branch): a flat
//    little-endian Float32Array, dev queries in queries-dev.jsonl file order
//    then test queries in queries-test.jsonl file order, tier.dims floats
//    per query, no sidecar file. cacheQueryVectors matches that exactly,
//    since it is the one binary contract a sibling module already committed
//    to reading.
// 6. scripts/lib/embeddings.mjs (the real embedding module, outside this
//    experiment's file set) exports a batched embedDocuments but only a
//    single-text embedQuery -- no batched query variant. embedMemories uses
//    embedDocuments in batches of batchSize (64, the measured optimum,
//    section 1.2). cacheQueryVectors calls embedQuery per query with modest
//    concurrency (opts.batchSize as a concurrency cap, not a true model
//    batch): adding a batched query function to embeddings.mjs is out of
//    this file's assigned scope, and at 12.8 ms/query this still comfortably
//    fits the time budget (section 1.3).
// 7. createSchema also runs `create extension if not exists vector/pg_trgm`,
//    matching what pg-up.sh's gate and infra/schema.sql both already do
//    independently. Redundant but idempotent, kept so this file also works
//    standalone without depending on pg-up.sh having run first.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { config, resolveTier } from './config.mjs';
import { assertBenchTarget, benchClient } from './lib/safety.mjs';
import { hashString } from './lib/rng.mjs';
import { memoryVector, toHalfvecLiteral } from './lib/synth-vectors.mjs';
import { writeJsonl } from './lib/jsonl.mjs';
import { parseQueryFeatures, lexicalQueryParams } from './engine.mjs';
import { buildMemoryIndex, reverbalizeQuery } from './gen-corpus.mjs';
import { embedDocuments, embedQuery } from '../../scripts/lib/embeddings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The 7-kind vocabulary from DESIGN.md section 3.1's MemoryRecord comment
// ("event|person|preference|quote|place|project|note"); fixed order gives a
// stable kind_id for the synthetic-tier columns (deviation 2 above).
const KIND_ORDER = ['event', 'person', 'preference', 'quote', 'place', 'project', 'note'];

// Call-site default for lib/synth-vectors.mjs's memoryVector jitter param
// (deviation 3 above): enough spread that memories sharing a cluster are not
// bit-identical, small enough that the cluster centroid still dominates.
const SYNTH_MEMORY_JITTER = 0.12;

// smallint ceiling for the deterministic person_id/place_id fallback
// (deviation 2): keeps the hashed id inside a 2-byte column with headroom.
const SLUG_ID_MODULUS = 32000;

// ---------------------------------------------------------------------------
// Small local helpers (JSONL read, CSV/array encoding, psql COPY plumbing).
// ---------------------------------------------------------------------------

// Minimal streaming JSONL reader (deviation 4): one parsed record per line,
// backed by node:readline so a 10M-line file is never held in memory at once.
async function* readJsonlFile(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed);
  }
}

async function collectJsonl(filePath) {
  const out = [];
  for await (const record of readJsonlFile(filePath)) out.push(record);
  return out;
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// Postgres text-array literal, e.g. ["doan","minh"] -> {doan,minh}. Lexicon
// slugs are plain lowercase-kebab strings; the quoting branch is a defensive
// fallback, not the expected path.
function pgTextArrayLiteral(values) {
  if (!values || values.length === 0) return '{}';
  const items = values.map((v) => {
    const s = String(v);
    return /[,"{}\\\s]/.test(s) ? `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : s;
  });
  return `{${items.join(',')}}`;
}

function kindIdFor(kind) {
  const idx = KIND_ORDER.indexOf(kind);
  if (idx < 0) {
    throw new Error(`unknown memory kind "${kind}" -- not in the 7-kind vocabulary from DESIGN.md 3.1`);
  }
  return idx;
}

// Deterministic smallint id for a lexicon slug (deviation 2): keeps this
// file decoupled from lib/lexicon.mjs's internal id assignment, if any.
function slugId(slug) {
  return Math.abs(hashString(slug ?? '')) % SLUG_ID_MODULUS;
}

// [0.1,-0.2,...] -> "[0.1,-0.2,...]", the real-vector `vector` column format
// (mirrors scripts/embed-sweep.mjs's vectorLiteral).
function vectorLiteral(vec) {
  return `[${Array.from(vec).join(',')}]`;
}

function resolvePsqlBin() {
  if (process.env.BENCH_PSQL_BIN) return process.env.BENCH_PSQL_BIN;
  // Matches infra/pg-up.sh's PGBIN convention (section 12 addendum: Homebrew
  // Postgres 17, not Docker); fall back to PATH if that keg layout ever moves.
  const homebrewPath = '/opt/homebrew/opt/postgresql@17/bin/psql';
  return existsSync(homebrewPath) ? homebrewPath : 'psql';
}

// Streams CSV-encoded rows into `COPY table (cols) FROM STDIN` via a psql
// child process. node-postgres has no COPY support without the separate
// pg-copy-streams package (not a project dependency), so this uses the psql
// binary directly -- the same technique infra/pg-up.sh already relies on for
// DDL, and it gives true COPY performance without adding a dependency.
async function copyRowsViaPsql({ connectionString, table, columns, rows }) {
  assertBenchTarget(connectionString);
  const psqlBin = resolvePsqlBin();
  const copySql = `COPY ${table} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv)`;
  const child = spawn(psqlBin, [connectionString, '-v', 'ON_ERROR_STOP=1', '-q', '-c', copySql], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.resume(); // discard the "COPY N" ack; row count is tracked locally below

  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  let count = 0;
  try {
    for await (const fields of rows) {
      count++;
      if (!child.stdin.write(fields.join(',') + '\n')) {
        await once(child.stdin, 'drain');
      }
    }
  } finally {
    child.stdin.end();
  }

  const code = await exited;
  if (code !== 0) {
    throw new Error(`psql COPY into ${table} failed (exit ${code}): ${stderr.trim()}`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Row encoding (per-tier column mapping, section 3.5).
// ---------------------------------------------------------------------------

const REAL_COLUMNS = ['id', 'kind', 'title', 'body', 'raw', 'people', 'places', 'tags', 'occurred_at', 'cluster_id', 'dup_group', 'rare_token'];
const SYNTHETIC_COLUMNS = ['id', 'body', 'kind_id', 'person_id', 'place_id', 'occurred_at', 'cluster_id', 'embedding'];

function columnsFor(tier) {
  return tier.vector === 'synthetic' ? SYNTHETIC_COLUMNS : REAL_COLUMNS;
}

function encodeField(col, record, tier) {
  switch (col) {
    case 'id': return record.id;
    case 'kind': return record.kind;
    case 'title': return record.title;
    case 'body': return record.body;
    case 'raw': return record.raw;
    case 'people': return pgTextArrayLiteral(record.people);
    case 'places': return pgTextArrayLiteral(record.places);
    case 'tags': return pgTextArrayLiteral(record.tags);
    case 'occurred_at': return record.occurred_at;
    case 'cluster_id': return record.cluster_id;
    case 'dup_group': return record.dup_group ?? null;
    case 'rare_token': return record.rare_token ?? null;
    case 'kind_id': return record.kind_id ?? kindIdFor(record.kind);
    case 'person_id': return record.person_id ?? slugId(record.people?.[0]);
    case 'place_id': return record.place_id ?? slugId(record.places?.[0]);
    case 'embedding': {
      // Scale tiers carry no model: the vector is a pure deterministic
      // function of (id, cluster_id), computed inline during COPY so there
      // is no separate embedding pass for synthetic tiers (section 1, 7).
      if (record.embedding) {
        return typeof record.embedding === 'string' ? record.embedding : toHalfvecLiteral(record.embedding);
      }
      return toHalfvecLiteral(memoryVector(record.id, record.cluster_id, tier.dims, SYNTH_MEMORY_JITTER));
    }
    default:
      throw new Error(`load.mjs: unknown memories column "${col}"`);
  }
}

// ---------------------------------------------------------------------------
// Exported pipeline steps (DESIGN.md section 3.6).
// ---------------------------------------------------------------------------

export async function createSchema(client, tier) {
  await client.query('create extension if not exists vector');
  await client.query('create extension if not exists pg_trgm');
  await client.query(`create schema if not exists ${tier.schema}`);

  const ddl = tier.vector === 'synthetic'
    ? `create unlogged table if not exists ${tier.schema}.memories (
         id          bigint primary key,
         body        text not null,
         kind_id     smallint not null,
         person_id   smallint not null,
         place_id    smallint not null,
         occurred_at date not null,
         cluster_id  int not null,
         embedding   halfvec(${tier.dims})
       )`
    : `create table if not exists ${tier.schema}.memories (
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
         embedding     vector(${tier.dims}),
         fts tsvector generated always as (
             setweight(to_tsvector('english', title), 'A')
          || setweight(to_tsvector('english', raw),   'B')
          || setweight(to_tsvector('english', body),  'C')
         ) stored
       )`;

  await client.query(ddl);
}

export async function copyMemories(client, tier, source) {
  const started = Date.now();
  const table = `${tier.schema}.memories`;
  const columns = columnsFor(tier);

  async function* rowsFrom(src) {
    for await (const record of src) {
      yield columns.map((col) => csvField(encodeField(col, record, tier)));
    }
  }

  const rows = await copyRowsViaPsql({
    connectionString: config.db.url,
    table,
    columns,
    rows: rowsFrom(source),
  });
  return { rows, ms: Date.now() - started };
}

export async function embedMemories(client, tier, opts = {}) {
  if (tier.vector !== 'real') {
    // Running the model against a synthetic tier would try to write a
    // 768-dim vector into a halfvec(256) column -- fail fast with a clear
    // reason instead of a confusing type-mismatch error from Postgres.
    throw new Error(`embedMemories only applies to real-vector tiers; tier.vector="${tier.vector}" gets its embedding from copyMemories instead`);
  }

  const batchSize = opts.batchSize ?? 64; // measured optimum, DESIGN.md 1.2
  const checkpointEvery = opts.checkpointEvery ?? 5000; // DESIGN.md section 7 rung 2
  const onProgress = opts.onProgress ?? (() => {});
  const table = `${tier.schema}.memories`;
  const started = Date.now();
  let embedded = 0;

  for (;;) {
    const { rows } = await client.query(
      `select id, body from ${table} where embedding is null order by id limit $1`,
      [checkpointEvery],
    );
    if (rows.length === 0) break;

    // Shortest first: less padding wasted per model batch (mirrors scripts/embed-sweep.mjs).
    rows.sort((a, b) => a.body.length - b.body.length);

    const vectors = new Array(rows.length);
    for (let i = 0; i < rows.length; i += batchSize) {
      const slice = rows.slice(i, i + batchSize);
      const embeddedSlice = await embedDocuments(slice.map((r) => r.body));
      for (let j = 0; j < slice.length; j++) vectors[i + j] = embeddedSlice[j];
    }

    // One UPDATE per checkpoint page: the "embedding is null" guard is what
    // makes a kill-and-restart resume correctly, since only the current
    // page (at most checkpointEvery rows) is ever at risk of being redone.
    await client.query(
      `update ${table} t set embedding = v.vec::vector
       from (select unnest($1::bigint[]) as id, unnest($2::text[]) as vec) v
       where t.id = v.id and t.embedding is null`,
      [rows.map((r) => r.id), vectors.map(vectorLiteral)],
    );

    embedded += rows.length;
    onProgress({ embedded, elapsedMs: Date.now() - started });
  }

  return { embedded, ms: Date.now() - started };
}

export async function cacheQueryVectors(queries, cachePath, opts = {}) {
  const started = Date.now();
  const concurrency = Math.max(1, opts.batchSize ?? 8);

  // No batched query-embed function exists to call (deviation 6): this runs
  // embedQuery with a small worker pool instead of true model batching.
  const vectors = new Array(queries.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= queries.length) return;
      vectors[i] = await embedQuery(queries[i].text);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length || 1) }, worker));

  const dims = vectors[0]?.length ?? 0;
  const buffer = Buffer.alloc(vectors.length * dims * 4);
  for (let i = 0; i < vectors.length; i++) {
    for (let d = 0; d < dims; d++) {
      buffer.writeFloatLE(vectors[i][d], (i * dims + d) * 4);
    }
  }

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, buffer);

  return { cached: queries.length, ms: Date.now() - started };
}

export async function buildIndexes(client, tier, opts = {}) {
  const vectorIndexType = opts.vectorIndex ?? 'hnsw';
  if (vectorIndexType !== 'hnsw' && vectorIndexType !== 'ivfflat') {
    throw new Error(`buildIndexes: vectorIndex must be "hnsw" or "ivfflat", got "${vectorIndexType}"`);
  }
  const table = `${tier.schema}.memories`;
  // sqrt(N), the rule of thumb DESIGN.md section 7 gives for the IVFFlat fallback.
  const lists = Math.max(1, Math.round(Math.sqrt(tier.memories)));
  const vectorOps = tier.vector === 'real' ? 'vector_cosine_ops' : 'halfvec_cosine_ops';
  const vectorIndexSql = vectorIndexType === 'ivfflat'
    ? `create index if not exists memories_embedding_ivfflat on ${table} using ivfflat (embedding ${vectorOps}) with (lists = ${lists})`
    : `create index if not exists memories_embedding_hnsw on ${table} using hnsw (embedding ${vectorOps}) with (m = 16, ef_construction = ${tier.vector === 'real' ? 200 : 128})`;

  const steps = tier.vector === 'real'
    ? [
        { name: 'gin_fts', sql: `create index if not exists memories_fts_gin on ${table} using gin (fts)` },
        { name: `vector_${vectorIndexType}`, sql: vectorIndexSql, watchNotices: true },
        { name: 'gin_people', sql: `create index if not exists memories_people_gin on ${table} using gin (people array_ops)` },
        { name: 'gin_tags', sql: `create index if not exists memories_tags_gin on ${table} using gin (tags array_ops)` },
        { name: 'btree_occurred_at', sql: `create index if not exists memories_occurred_at_btree on ${table} (occurred_at)` },
        { name: 'gin_trgm', sql: `create index if not exists memories_trgm_gin on ${table} using gin ((title || ' ' || body) gin_trgm_ops)` },
      ]
    : [
        { name: 'gin_fts_expr', sql: `create index if not exists memories_fts_gin on ${table} using gin (to_tsvector('english', body))` },
        { name: `vector_${vectorIndexType}`, sql: vectorIndexSql, watchNotices: true },
        { name: 'btree_occurred_at', sql: `create index if not exists memories_occurred_at_btree on ${table} (occurred_at)` },
        { name: 'btree_person_occurred_at', sql: `create index if not exists memories_person_occurred_at_btree on ${table} (person_id, occurred_at)` },
      ];

  // pgvector's "graph no longer fits into maintenance_work_mem" spill
  // warning is exactly what DESIGN.md section 7 rung 3 exists to catch;
  // matched loosely since the precise wording is a pgvector implementation
  // detail this file cannot pin down offline.
  const notices = [];
  const noticeListener = (msg) => {
    const text = msg?.message ?? String(msg);
    if (/maintenance_work_mem/i.test(text)) notices.push(text);
  };

  await client.query('set statement_timeout = 0');
  const timings = [];
  const totalStarted = Date.now();
  for (const step of steps) {
    if (step.watchNotices) client.on('notice', noticeListener);
    const stepStarted = Date.now();
    await client.query(step.sql);
    timings.push({ name: step.name, ms: Date.now() - stepStarted });
    if (step.watchNotices) client.off('notice', noticeListener);
  }
  const totalMs = Date.now() - totalStarted;

  const { rows: indexRows } = await client.query(
    `select indexname, pg_relation_size((schemaname || '.' || indexname)::regclass) as bytes
     from pg_indexes where schemaname = $1 and tablename = 'memories'`,
    [tier.schema],
  );
  const { rows: tableRows } = await client.query(
    `select pg_relation_size($1::regclass) as heap_bytes, pg_total_relation_size($1::regclass) as total_bytes`,
    [table],
  );

  const sizes = {
    heapBytes: Number(tableRows[0].heap_bytes),
    totalBytes: Number(tableRows[0].total_bytes),
    indexBytes: Object.fromEntries(indexRows.map((r) => [r.indexname, Number(r.bytes)])),
  };

  return { schema: tier.schema, vectorIndex: vectorIndexType, timings, totalMs, sizes, notices };
}

// ---------------------------------------------------------------------------
// Post-load oracle verification (DESIGN.md section 4, post-load note)
//
// The corpus generator cannot certify the vector lane: at the real-vector
// tiers the embeddings do not exist until this file has run. It used to try
// anyway, with lib/synth-vectors.mjs as a proxy, and the proxy was wrong in
// the direction that mattered -- it certified paraphrase_nolex at rank 1
// while the real embedder ranked those targets ~500th. So the authoritative
// oracle is measured here, against the corpus that was actually loaded and
// actually embedded, with exact cosine in SQL.
//
// Why its own statement rather than engine.retrieve(): retrieve() assembles
// its `lanes` map from the fused top-50, so a target sitting at lane rank 80
// never appears in it. The oracle needs each lane's rank at full depth. The
// AND/OR bind parameters come from engine.lexicalQueryParams so the two
// cannot drift apart in how they build the disjunction or the fragment bar.
//
// Why exact cosine rather than the HNSW lane's rank: DESIGN.md 4.2 rule 2
// asks for "a true statement about the lane rather than a guess about the
// index". A count over a distance comparison cannot use the HNSW index, so
// it is exact by construction.
// ---------------------------------------------------------------------------

function buildOracleSql(tier, depth, trigramThreshold) {
  const table = `${tier.schema}.memories`;
  const withTrigram = tier.vector === 'real';
  const simExpr = `word_similarity(q.raw, m.title || ' ' || m.body)`;
  const trigramCte = withTrigram
    ? `,
trg_lane as (
  select m.id, row_number() over (order by ${simExpr} desc, m.id) as rnk
  from ${table} m, q
  where ${simExpr} >= ${trigramThreshold}
  order by ${simExpr} desc, m.id limit ${depth}
)`
    : '';
  const trigramSelect = withTrigram ? `(select rnk from trg_lane where id = $4) as trg_rank` : `null::bigint as trg_rank`;
  return `with q as (
  select $1::text as raw,
         websearch_to_tsquery('english', $1) as andq,
         to_tsquery('english', $2) as orq,
         $5::vector as vec
),
and_lane as (
  select m.id, row_number() over (order by ts_rank_cd(m.fts, q.andq) desc, m.id) as rnk
  from ${table} m, q
  where m.fts @@ q.andq
  order by ts_rank_cd(m.fts, q.andq) desc, m.id limit ${depth}
),
or_lane as (
  select m.id, row_number() over (order by ts_rank_cd(m.fts, q.orq) desc, m.id) as rnk
  from ${table} m, q
  where m.fts @@ q.orq
    and (select count(*) from unnest($3::text[]) ql where m.fts @@ to_tsquery('english', ql)) >= $6
  order by ts_rank_cd(m.fts, q.orq) desc, m.id limit ${depth}
)${trigramCte},
tgt as (select embedding as vec from ${table} where id = $4)
select
  (select rnk from and_lane where id = $4) as and_rank,
  (select rnk from or_lane  where id = $4) as or_rank,
  ${trigramSelect},
  (select count(*) + 1 from ${table} m, q, tgt
     where m.embedding is not null and (m.embedding <=> q.vec) < (tgt.vec <=> q.vec)) as vector_rank`;
}

const laneRankNumber = (v) => (v === null || v === undefined ? null : Number(v));

export async function measureLaneRanks(client, tier, query, queryVector, cfg = config) {
  const qf = parseQueryFeatures(query.text, EMPTY_ORACLE_VOCAB, cfg);
  const { raw, contentTerms, orQuery, fragmentBar } = lexicalQueryParams(qf);
  // An all-stopword query has no OR disjunction to build; to_tsquery('') is a
  // syntax error, so bind a lexeme nothing matches rather than crash.
  const orParam = orQuery ?? 'zzzznomatchzzzz';
  const { rows } = await client.query(
    buildOracleSql(tier, tier.laneDepth, cfg.lanes.trigramThreshold),
    [raw, orParam, contentTerms, query.targets[0], vectorLiteral(queryVector), fragmentBar],
  );
  const r = rows[0];
  return {
    and: laneRankNumber(r.and_rank),
    or: laneRankNumber(r.or_rank),
    trigram: laneRankNumber(r.trg_rank),
    vector: laneRankNumber(r.vector_rank),
  };
}

// parseQueryFeatures only reads the vocab for idf/entity features, none of
// which affect the lane SQL above -- the oracle measures lanes, not weights.
const EMPTY_ORACLE_VOCAB = { totalDocs: 1, df: new Map(), people: new Map(), places: new Map() };

function summarizeOracle(records, tier, cfg) {
  const k = cfg.oracle.bestLaneRankAt;
  const depth = tier.laneDepth;
  const perFamily = {};
  let bestLaneHits = 0;
  let depthHits = 0;
  for (const rec of records) {
    const ranks = Object.values(rec.laneRanks).filter((v) => v != null);
    const best = ranks.length ? Math.min(...ranks) : null;
    const hit = best != null && best <= k;
    const reached = best != null && best <= depth;
    perFamily[rec.family] ??= { n: 0, bestLaneHits: 0, depthHits: 0, byLane: {} };
    perFamily[rec.family].n++;
    if (hit) { perFamily[rec.family].bestLaneHits++; bestLaneHits++; }
    if (reached) { perFamily[rec.family].depthHits++; depthHits++; }
    for (const [lane, rnk] of Object.entries(rec.laneRanks)) {
      if (rnk != null && rnk <= k) perFamily[rec.family].byLane[lane] = (perFamily[rec.family].byLane[lane] ?? 0) + 1;
    }
  }
  const n = records.length;
  return {
    overall: { n, bestLaneRankAt10: n ? bestLaneHits / n : 0, depth100ReachabilityAt: n ? depthHits / n : 0 },
    perFamily: Object.fromEntries(Object.entries(perFamily).map(([f, v]) => [f, {
      n: v.n,
      bestLaneRankAt10: v.n ? v.bestLaneHits / v.n : 0,
      depth100Reachability: v.n ? v.depthHits / v.n : 0,
      solvedByLane: v.byLane,
    }])),
  };
}

// Bounded on purpose (config.oracle.repairRounds). A family that will not
// converge is a finding to report, not something to loop on: repairing forever
// would just be searching for a corpus that flatters the harness.
export async function verifyOracle(client, tier, opts) {
  const cfg = opts.cfg ?? config;
  const { dev, test, vectors, dims, onLog = () => {} } = opts;
  const all = [...dev.map((q, i) => ({ q, block: 'dev', i })), ...test.map((q, i) => ({ q, block: 'test', i }))];
  const offsetOf = (entry) => (entry.block === 'dev' ? entry.i : dev.length + entry.i) * dims;
  const vectorOf = (entry) => vectors.subarray(offsetOf(entry), offsetOf(entry) + dims);

  const records = new Map();
  for (const entry of all) {
    records.set(entry.q.qid, {
      qid: entry.q.qid, family: entry.q.family, entry,
      laneRanks: await measureLaneRanks(client, tier, entry.q, vectorOf(entry), cfg),
    });
  }

  const k = cfg.oracle.bestLaneRankAt;
  const bestOf = (rec) => {
    const ranks = Object.values(rec.laneRanks).filter((v) => v != null);
    return ranks.length ? Math.min(...ranks) : null;
  };

  const rounds = [];
  const nonConverging = [];
  for (let round = 1; round <= (opts.repairRounds ?? cfg.oracle.repairRounds); round++) {
    const failing = [...records.values()].filter((rec) => { const b = bestOf(rec); return b == null || b > k; });
    if (failing.length === 0) break;

    const rewritten = [];
    for (const rec of failing) {
      const text = reverbalizeQuery(rec.entry.q, opts.index, tier, round);
      if (!text) { continue; }
      rec.entry.q.text = text;
      rec.entry.q.diagnostics.repair_round = round;
      rewritten.push(rec);
    }
    if (rewritten.length === 0) break;

    // Re-embed only what changed, straight into the cache buffer, so the
    // dev-block-then-test-block offsets bench-recall.mjs reads stay valid.
    // Repair is text-only for exactly this reason: adding or removing a query
    // would shift every offset after it.
    for (const rec of rewritten) {
      const vec = await embedQuery(rec.entry.q.text);
      const base = offsetOf(rec.entry);
      for (let d = 0; d < dims; d++) vectors[base + d] = vec[d];
      rec.laneRanks = await measureLaneRanks(client, tier, rec.entry.q, vectorOf(rec.entry), cfg);
    }

    const stillFailing = rewritten.filter((rec) => { const b = bestOf(rec); return b == null || b > k; });
    rounds.push({ round, attempted: failing.length, rewritten: rewritten.length, stillFailing: stillFailing.length });
    onLog(`  repair round ${round}: ${failing.length} failing, ${rewritten.length} re-verbalized, ${stillFailing.length} still failing`);
  }

  const leftover = [...records.values()].filter((rec) => { const b = bestOf(rec); return b == null || b > k; });
  const byFamily = {};
  for (const rec of leftover) byFamily[rec.family] = (byFamily[rec.family] ?? 0) + 1;
  for (const [family, count] of Object.entries(byFamily)) nonConverging.push({ family, count });

  // Fold the measurement back into each query's certificate, so a query file
  // on disk carries a verified certificate rather than the provisional one.
  for (const rec of records.values()) {
    const q = rec.entry.q;
    q.certificate.lane_ranks_measured = rec.laneRanks;
    q.certificate.signals = Object.entries(rec.laneRanks).filter(([, r]) => r != null && r <= k).map(([lane]) => lane);
    q.certificate.pending_lanes = [];
    q.certificate.vector_verified = true;
    q.certificate.solvable = q.certificate.signals.length > 0;
  }

  const records0 = [...records.values()];
  return {
    summary: summarizeOracle(records0, tier, cfg),
    rounds,
    nonConverging,
    repairedQids: records0.filter((r) => r.entry.q.diagnostics.repair_round > 0).map((r) => r.qid),
  };
}

async function runVerifyOracle(tier, args) {
  const outDir = join(HERE, '.out', tier.name);
  const cachePath = join(outDir, 'query-vectors.f32');
  if (!existsSync(cachePath)) {
    throw new Error(`--verify-oracle needs the query-vector cache at ${cachePath}; run the embedding sweep first`);
  }

  const memories = await collectJsonl(join(outDir, 'memories.jsonl'));
  const index = buildMemoryIndex(memories);
  const devPath = join(outDir, 'queries-dev.jsonl');
  const testPath = join(outDir, 'queries-test.jsonl');
  const dev = await collectJsonl(devPath);
  const test = await collectJsonl(testPath);

  const buf = await readFile(cachePath);
  const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const expected = (dev.length + test.length) * tier.dims;
  if (vectors.length < expected) {
    throw new Error(`query-vector cache has ${vectors.length} floats, need ${expected} (dev ${dev.length} + test ${test.length} at dims=${tier.dims})`);
  }

  const client = benchClient();
  await client.connect();
  const started = Date.now();
  try {
    const result = await verifyOracle(client, tier, {
      dev, test, vectors, dims: tier.dims, index, cfg: config,
      repairRounds: args['repair-rounds'] ? Number.parseInt(args['repair-rounds'], 10) : config.oracle.repairRounds,
      onLog: (line) => console.log(line),
    });

    // Repair changed query TEXT only, so the file's line count and therefore
    // every query-vector offset is unchanged (see verifyOracle's comment).
    if (dev.length + test.length !== expected / tier.dims) throw new Error('verify-oracle: query count changed during repair');
    await writeJsonl(devPath, dev);
    await writeJsonl(testPath, test);
    await writeFile(cachePath, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));

    // Repair changed query text, so any CORPUS.lock written before this run
    // now pins query hashes that no longer match. Say so loudly rather than
    // leaving bench-recall to fail a hash check with no explanation: the fix
    // is to re-run gen-corpus --verify, which is the freeze step, and DESIGN.md
    // 4.4 puts repair before the freeze for exactly this reason.
    if (result.repairedQids.length > 0 && existsSync(join(outDir, 'CORPUS.lock'))) {
      console.log(`  note: ${result.repairedQids.length} queries were repaired, so CORPUS.lock's query hashes are stale -- re-run gen-corpus.mjs --verify to re-freeze`);
    }

    const oraclePath = join(outDir, 'oracle.json');
    const provisional = existsSync(oraclePath) ? JSON.parse(await readFile(oraclePath, 'utf8')) : null;
    const oracle = {
      tier: tier.name,
      generatedAt: new Date().toISOString(),
      vector: { verified: true, method: 'exact cosine rank in SQL over the loaded corpus', embedder: 'nomic-embed-text-v1.5' },
      overall: result.summary.overall,
      perFamily: result.summary.perFamily,
      gate: { threshold: config.oracle.gate, passed: result.summary.overall.bestLaneRankAt10 >= config.oracle.gate, provisional: false },
      repair: { rounds: result.rounds, repaired: result.repairedQids.length, nonConverging: result.nonConverging },
      // Kept alongside so the two numbers can be compared rather than one
      // silently replacing the other.
      provisionalOffline: provisional ? { overall: provisional.overall, perFamily: provisional.perFamily } : null,
    };
    await writeFile(oraclePath, JSON.stringify(oracle, null, 2));

    console.log(`verified oracle best-lane-rank@${config.oracle.bestLaneRankAt}: ${oracle.overall.bestLaneRankAt10.toFixed(4)} (gate ${config.oracle.gate}, ${oracle.gate.passed ? 'PASSED' : 'FAILED'})`);
    console.log(`depth-${tier.laneDepth} reachability: ${oracle.overall.depth100ReachabilityAt.toFixed(4)}`);
    for (const [family, v] of Object.entries(oracle.perFamily)) {
      console.log(`  ${family.padEnd(18)} n=${String(v.n).padStart(3)} best-lane@10=${v.bestLaneRankAt10.toFixed(3)} lanes=${JSON.stringify(v.solvedByLane)}`);
    }
    if (result.nonConverging.length > 0) {
      console.log(`families that did not converge after ${config.oracle.repairRounds} repair rounds: ${JSON.stringify(result.nonConverging)}`);
    }
    console.log(`oracle written -> ${oraclePath} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    if (!oracle.gate.passed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const { values: args } = parseArgs({
    options: {
      tier: { type: 'string' },
      stream: { type: 'boolean', default: false },
      'skip-embed': { type: 'boolean', default: false },
      'vector-index': { type: 'string', default: 'hnsw' },
      resume: { type: 'boolean', default: false },
      'verify-oracle': { type: 'boolean', default: false },
      'repair-rounds': { type: 'string' },
    },
  });

  if (!args.tier) throw new Error('load.mjs requires --tier <name>');
  // --stream feeds this tier straight into gen-corpus.generateMemories, which
  // seeds off the corpus knobs resolveTier composes in. A hand-merged tier
  // would generate a different corpus than the one on disk.
  const tier = resolveTier(args.tier);

  // Section 3.7: every script prints its resolved target and tier schema on
  // line one, before anything else runs.
  console.log(`load.mjs: target=${config.db.url} tier=${args.tier} schema=${tier.schema}`);
  assertBenchTarget(config.db.url);

  if (args['verify-oracle']) {
    await runVerifyOracle(tier, args);
    return;
  }

  // 51K embeddings is a long CPU job (DESIGN.md 1.3); lowest priority so the
  // sweep does not starve the rest of the machine, mirroring scripts/embed-sweep.mjs.
  try { os.setPriority(19); } catch { /* not permitted on some platforms; the sweep still runs */ }

  const outDir = join(HERE, '.out', args.tier);
  const client = benchClient();
  await client.connect();
  const wallStarted = Date.now();

  try {
    await createSchema(client, tier);
    console.log(`  schema ready: ${tier.schema}.memories`);

    if (!args.resume) {
      const source = args.stream
        ? (await import('./gen-corpus.mjs')).generateMemories(tier)
        : readJsonlFile(join(outDir, 'memories.jsonl'));
      const { rows, ms } = await copyMemories(client, tier, source);
      console.log(`  copied ${rows} memories in ${(ms / 1000).toFixed(1)}s`);
    } else {
      console.log('  --resume: skipping copyMemories, assuming memories are already loaded');
    }

    if (tier.vector === 'real' && !args['skip-embed']) {
      const { embedded, ms } = await embedMemories(client, tier, {
        batchSize: 64,
        checkpointEvery: 5000,
        onProgress: ({ embedded: n, elapsedMs }) => {
          console.log(`  embedded ${n} (${(elapsedMs / 1000).toFixed(1)}s elapsed)`);
        },
      });
      console.log(`  embedding sweep: ${embedded} rows in ${(ms / 1000).toFixed(1)}s`);

      try {
        const queries = [
          ...(await collectJsonl(join(outDir, 'queries-dev.jsonl'))),
          ...(await collectJsonl(join(outDir, 'queries-test.jsonl'))),
        ];
        if (queries.length > 0) {
          const cachePath = join(outDir, 'query-vectors.f32');
          const { cached, ms: cacheMs } = await cacheQueryVectors(queries, cachePath, { batchSize: 8 });
          console.log(`  cached ${cached} query vectors in ${(cacheMs / 1000).toFixed(1)}s -> ${cachePath}`);
        }
      } catch (err) {
        console.log(`  query-vector cache skipped: ${err.message}`);
      }
    } else if (tier.vector === 'real') {
      console.log('  --skip-embed: leaving embedding column null');
    } else {
      console.log('  synthetic-vector tier: embeddings were written inline during copyMemories');
    }

    const report = await buildIndexes(client, tier, { vectorIndex: args['vector-index'] });
    for (const t of report.timings) console.log(`  index ${t.name}: ${(t.ms / 1000).toFixed(1)}s`);
    for (const n of report.notices) console.log(`  notice: ${n}`);
    console.log(`  total relation size: ${(report.sizes.totalBytes / 1e9).toFixed(2)} GB`);

    console.log(`load.mjs done in ${((Date.now() - wallStarted) / 1000).toFixed(1)}s`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  });
}
