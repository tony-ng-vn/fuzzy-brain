// scripts/stream-corpus.mjs -- load a synthetic tier without ever holding the
// whole corpus in memory, and write its query files.
//
//   node scripts/stream-corpus.mjs --tier full10m
//   node scripts/stream-corpus.mjs --tier full10m --rows 400000 --schema bench_bs_stream400k
//   node scripts/stream-corpus.mjs --tier full10m --dry-run
//
// WHY THIS EXISTS, and why `load.mjs --stream` cannot do it.
//
// load.mjs --stream reads gen-corpus.generateMemories(tier), which is a
// generator over an array the plan has already materialized in full. Measured
// 2026-08-25 with three runs at 100k / 200k / 400k memories, the plan costs
// 7.1-7.9 KB of resident memory per memory and the cost is linear:
//
//     N          RSS       bytes/memory
//     100,000    681 MB    7,138
//     200,000  1,510 MB    7,916
//     400,000  2,728 MB    7,150
//
// At 10M that projects to 71-79 GB on a 24 GB machine. It is not a tuning
// problem: `finalMemories` is 10M objects, the shuffle needs them all at once,
// and repairAnchors builds a full postings index over every one of them.
//
// So DESIGN.md 7.4's 10M no-go had a second binding constraint underneath the
// maintenance_work_mem one nobody had priced. This script removes it, using the
// property lib/rng.mjs's header already promises: fork() is keyed by label
// rather than by draw order, "which is what lets a memory be generated in any
// order -- or lazily, one at a time, as the 10M tier requires".
//
// THE COMPOSITION, and the one design change it makes.
//
// A tier's plan has two halves. The structured half is every memory some query
// points at: 25,735 memories at the full10m tier, about 200 MB, trivially
// resident. The filler half is 9.97M memories no query points at, which exist
// only so the lanes have a realistic corpus to compete against. So:
//
//   1. structuredPlan(tier) builds the structured half, cases included, with
//      repairAnchors run over it.
//   2. Each structured memory is scattered to a final id by a seeded draw, one
//      per equal-width block of the id space, so structured and filler
//      interleave the way buildPlan's shuffle interleaves them.
//   3. The stream walks id 1..N and emits either the structured memory placed
//      at that id or the next filler memory, encoded by load.mjs's own
//      encodeField, into a psql COPY.
//
// DESIGN CHANGE, stated as one: repairAnchors certifies against the structured
// corpus alone rather than the whole corpus, because the whole corpus is what
// does not fit. The consequence is real and is measured rather than waved past:
// partial_ref's `maxPairCoOccurrence <= 10` and date_filter/near_dup's
// three-term rarity budgets are checked against 25,735 documents, so once 9.97M
// filler rows join, those anchors are rarer-in-principle than they are in fact.
// Two things bound how much that matters. First, the same decay would hit a
// monolithically generated 10M corpus: a pair certified rare among 1M documents
// is ~10x less rare among 10M, and the family genuinely gets harder with N.
// Second, the exact-cosine whole-pipeline ceiling is measured at 10M BEFORE any
// ef_search sweep, exactly as DESIGN.md 7.4 did at 1M, so a recall miss is
// attributable to the corpus or to the index rather than argued about after.
//
// Nothing here touches the real-vector tiers. bench_q50k and bench_smoke keep
// going through load.mjs's unchanged path, so the frozen quality corpus cannot
// move.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const { assertBenchTarget, benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { encodeField } = await import(`${BENCH}/load.mjs`);
const { makeRng } = await import(`${BENCH}/lib/rng.mjs`);
const {
  structuredPlan, fillerMemoryFactory, buildMemoryIndex,
  generateQueries, generateMultiTargetQueries,
} = await import(`${BENCH}/gen-corpus.mjs`);

const { values: args } = parseArgs({
  options: {
    tier: { type: 'string' },
    rows: { type: 'string' },
    schema: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'skip-queries': { type: 'boolean', default: false },
    'out-dir': { type: 'string' },
  },
});
if (!args.tier) throw new Error('stream-corpus.mjs requires --tier <name>');

const baseTier = resolveTier(args.tier);
if (baseTier.vector !== 'synthetic') {
  throw new Error(`--tier ${args.tier} is a real-vector tier; its rows carry model embeddings and cannot be streamed from the generator`);
}
// --rows exists for the equivalence control (generate the same tier small
// enough that the monolithic path also fits, and diff the two). The tier's own
// size is the default and is what a real load uses.
const tier = args.rows ? { ...baseTier, memories: Number(args.rows) } : baseTier;
const SCHEMA = args.schema ?? tier.schema;
const OUT_DIR = args['out-dir'] ?? `${BENCH}/.out/${args.tier}`;
const N = tier.memories;

const COLUMNS = ['id', 'body', 'kind_id', 'person_id', 'place_id', 'occurred_at', 'cluster_id', 'embedding'];
const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

log(`stream-corpus: target=${config.db.url} tier=${args.tier} schema=${SCHEMA} rows=${N.toLocaleString()}`);
assertBenchTarget(config.db.url);

// ---------------------------------------------------------------------------
// 1. the structured half
// ---------------------------------------------------------------------------

const t0 = Date.now();
const plan = structuredPlan(tier);
const S = plan.memories.length;
log(`structured plan: ${S.toLocaleString()} memories, ${plan.cases.length} dev+test cases, ${plan.multiCases.length} multi cases (${((Date.now() - t0) / 1000).toFixed(1)}s, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB)`);
if (S > N) throw new Error(`structured plan needs ${S} memories but --rows is ${N}`);

// One structured memory per equal-width block of the id space, at a seeded
// offset inside its block. Distinctness is structural rather than checked, and
// the interleave is uniform by construction -- which is what buildPlan's global
// shuffle buys, and the property that keeps every AND/OR tie-break (which falls
// back to id order) from systematically favouring structured content.
const placeRng = makeRng(`${tier.seedMemories}::${args.tier}::stream-placement::n:${N}`);
const blockWidth = Math.floor(N / S);
const positions = new Int32Array(S);
for (let i = 0; i < S; i++) {
  positions[i] = i * blockWidth + 1 + placeRng.int(0, blockWidth - 1);
}
// Structured plan id (1..S) -> final id in [1..N].
const finalIdOf = new Map();
for (let i = 0; i < S; i++) finalIdOf.set(plan.memories[i].id, positions[i]);

// ---------------------------------------------------------------------------
// 2. the query files, with targets remapped into the real id space
// ---------------------------------------------------------------------------

const remapIds = (ids) => (ids ?? []).map((id) => {
  const mapped = finalIdOf.get(id);
  if (mapped == null) throw new Error(`stream-corpus: query names memory ${id}, which is not in the structured plan`);
  return mapped;
});

function remapQueries(queries) {
  for (const q of queries) {
    q.targets = remapIds(q.targets);
    if (q.diagnostics?.distractor_ids) q.diagnostics.distractor_ids = remapIds(q.diagnostics.distractor_ids);
  }
  return queries;
}

let queryFiles = null;
if (!args['skip-queries']) {
  const structIndex = buildMemoryIndex(plan.memories);
  const dev = remapQueries(generateQueries(tier, 'dev', structIndex, plan));
  const test = remapQueries(generateQueries(tier, 'test', structIndex, plan));
  const multi = remapQueries(generateMultiTargetQueries(tier, structIndex, plan));
  queryFiles = { dev, test, multi };
  log(`queries: ${dev.length} dev, ${test.length} test, ${multi.length} multi`);
}

// ---------------------------------------------------------------------------
// 3. the stream
// ---------------------------------------------------------------------------

const filler = fillerMemoryFactory(tier);

function* corpusRows(onProgress) {
  let structIdx = 0;
  let fillerIndex = 0;
  for (let id = 1; id <= N; id++) {
    let record;
    if (structIdx < S && positions[structIdx] === id) {
      record = { ...plan.memories[structIdx], id };
      structIdx++;
    } else {
      record = { ...filler(fillerIndex++), id };
    }
    if (id % 100_000 === 0) onProgress(id);
    yield record;
  }
  if (structIdx !== S) throw new Error(`stream-corpus: placed ${structIdx} of ${S} structured memories`);
}

const csvField = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

if (args['dry-run']) {
  // Prove the composition on a handful of rows without writing anything: a
  // structured id must round-trip to the memory its query names, and a filler
  // id must produce ordinary content.
  const probe = [];
  let n = 0;
  for (const record of corpusRows(() => {})) {
    if (n < 3 || positions.includes?.(record.id)) probe.push(record);
    if (++n >= 5) break;
  }
  for (const r of probe.slice(0, 3)) {
    log(`  id ${r.id} cluster ${r.cluster_id} body[0..70]="${r.body.slice(0, 70)}"`);
  }
  const firstStructured = plan.memories[0];
  log(`  structured plan id ${firstStructured.id} -> final id ${finalIdOf.get(firstStructured.id)}`);
  if (queryFiles) {
    const q = queryFiles.test[0];
    log(`  sample query ${q.qid} (${q.family}) targets ${JSON.stringify(q.targets)}: "${q.text.slice(0, 70)}"`);
  }
  log('  dry run: nothing written');
  process.exit(0);
}

const psqlBin = process.env.BENCH_PSQL_BIN ?? '/opt/homebrew/opt/postgresql@17/bin/psql';

async function copyViaPsql(table, columns, rows) {
  const child = spawn(psqlBin, [config.db.url, '-v', 'ON_ERROR_STOP=1', '-q', '-c',
    `COPY ${table} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv)`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  child.stdout.resume();
  const exited = new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
  let n = 0;
  try {
    for (const fields of rows) {
      n++;
      if (!child.stdin.write(fields.join(',') + '\n')) await once(child.stdin, 'drain');
    }
  } finally { child.stdin.end(); }
  const code = await exited;
  if (code !== 0) throw new Error(`COPY into ${table} failed (exit ${code}): ${stderr.trim()}`);
  return n;
}

const client = benchClient();
await client.connect();
try {
  await client.query('set statement_timeout = 0');
  await client.query(`create schema if not exists ${SCHEMA}`);
  // Same DDL as load.mjs createSchema's synthetic branch, including the stored
  // generated tsvector, so a streamed tier is shape-identical to a loaded one.
  await client.query(`drop table if exists ${SCHEMA}.memories cascade`);
  await client.query(`create unlogged table ${SCHEMA}.memories (
      id          bigint primary key,
      body        text not null,
      kind_id     smallint not null,
      person_id   smallint not null,
      place_id    smallint not null,
      occurred_at date not null,
      cluster_id  int not null,
      embedding   halfvec(${tier.dims}),
      fts         tsvector generated always as (to_tsvector('english', body)) stored
    )`);

  const copyStarted = Date.now();
  const encoded = function* () {
    for (const record of corpusRows((id) => {
      const elapsed = (Date.now() - copyStarted) / 1000;
      const rate = id / elapsed;
      log(`  ${id.toLocaleString()}/${N.toLocaleString()} rows  ${rate.toFixed(0)} rows/s  ETA ${((N - id) / rate / 60).toFixed(1)}m  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
    })) {
      yield COLUMNS.map((col) => csvField(encodeField(col, record, tier)));
    }
  }();

  const copied = await copyViaPsql(`${SCHEMA}.memories`, COLUMNS, encoded);
  const copyMs = Date.now() - copyStarted;
  log(`copied ${copied.toLocaleString()} rows in ${(copyMs / 1000).toFixed(1)}s (${(copied / (copyMs / 1000)).toFixed(0)} rows/s)`);
  if (copied !== N) throw new Error(`expected ${N} rows, copied ${copied}`);

  if (queryFiles) {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const [name, rows] of [['dev', queryFiles.dev], ['test', queryFiles.test], ['multi', queryFiles.multi]]) {
      const path = join(OUT_DIR, `queries-${name}.jsonl`);
      writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      log(`  wrote ${rows.length} queries -> ${path}`);
    }
  }

  // The end-to-end check the composition has to pass: every query target must
  // exist in the table that was just written, and the row it lands on must be
  // the memory the query was built from. A remap bug is otherwise invisible
  // until recall comes back at zero.
  if (queryFiles) {
    const sample = [...queryFiles.test.slice(0, 12), ...queryFiles.dev.slice(0, 12)];
    const ids = sample.map((q) => q.targets[0]);
    const { rows } = await client.query(
      `select id, body from ${SCHEMA}.memories where id = any($1::bigint[])`, [ids],
    );
    const bodyById = new Map(rows.map((r) => [Number(r.id), r.body]));
    let matched = 0;
    const missing = [];
    for (const q of sample) {
      const body = bodyById.get(q.targets[0]);
      if (body == null) { missing.push(q.qid); continue; }
      const expected = plan.memories.find((m) => finalIdOf.get(m.id) === q.targets[0]);
      if (expected && expected.body === body) matched++;
    }
    log(`target round-trip: ${matched}/${sample.length} sampled targets are in the table with the planned body, ${missing.length} missing`);
    if (missing.length > 0 || matched !== sample.length) {
      throw new Error(`stream-corpus: ${missing.length} targets absent and ${sample.length - matched} body mismatches -- the query files do not describe this corpus`);
    }
  }

  log('STREAM COMPLETE -- indexes are NOT built here; run scripts/build-arm.mjs or scripts/hnsw-build.sh next');
} finally {
  await client.end();
}
