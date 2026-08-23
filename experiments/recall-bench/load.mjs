// load.mjs -- bulk COPY ingest, the real-embedding sweep (quality tier), the
// synthetic-vector fill (scale tier), and index build, with timing logs.
// Implements DESIGN.md's "load.mjs" row in section 2 and the function
// signatures + CLI in section 3.6/3.7.
//
// Usage (section 3.7):
//   node load.mjs --tier <name> [--stream] [--skip-embed]
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
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { config, resolveTier } from './config.mjs';
import { assertBenchTarget, benchClient } from './lib/safety.mjs';
import { hashString } from './lib/rng.mjs';
import { memoryVector, toHalfvecLiteral } from './lib/synth-vectors.mjs';
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
  return `[${vec.join(',')}]`;
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
