// scripts/build-arm.mjs -- price one index-build strategy at a given corpus size.
//
//   node scripts/build-arm.mjs --arm bulk --rows 1000000 --schema bench_bs_bulk
//   node scripts/build-arm.mjs --arm incremental --streams 4 --rows 1000000 --schema bench_bs_inc4
//
// Why this exists. DESIGN.md 7.4 blocked the 10M rung on one number: a BULK
// HNSW build has to hold the whole graph in maintenance_work_mem, which is
// ~15.9 GB at 10M on a 24 GB machine already 7 GB into swap. That ceiling is a
// property of the bulk build alone. If the index exists BEFORE the rows land,
// every row is an ordinary index insert into an on-disk graph and the memory
// per insert does not scale with corpus size at all. 7.1 already accepts a
// multi-hour one-time offline build, so trading wall clock for memory is a
// trade the design permits -- but only if the trade is measured rather than
// assumed, and only if the resulting graph retrieves as well as a bulk one.
//
// So each arm reports three things, and all three are needed to choose:
//   1. wall clock, split per phase, with a per-chunk rate curve. The curve is
//      the point: per-row insert cost into an HNSW graph grows with the graph,
//      so a single 1M number cannot be extrapolated to 10M but a growth curve
//      can.
//   2. memory behaviour sampled from the OS (free pages, swap used) rather
//      than inferred from maintenance_work_mem, because the wall that killed
//      the bulk build can come back as page thrash during incremental inserts.
//   3. the schema it leaves behind, so the recall-equivalence check runs
//      against the actual graph this arm produced.
//
// Rows are copied server-side from an already-loaded tier rather than
// regenerated, deliberately: the arms differ only in when the index is built,
// and a client-side generator would put its own CPU cost inside a wall-clock
// comparison.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.mjs';
import { assertBenchTarget, benchClient } from '../lib/safety.mjs';

// Every arm writes into a throwaway schema and drops it first. The prefix is a
// hard gate rather than a convention: this script issues `drop schema cascade`,
// and the loaded tiers (bench_r1m, bench_q50k) must never be reachable by it.
const SCRATCH_PREFIX = 'bench_bs_';

// Measured by scripts/hnsw-mem-probe.sh; see scripts/hnsw-build.sh for the
// derivation. Only the bulk arm uses it -- an incremental insert never asks
// for a graph-sized budget, which is the whole point of the comparison.
const BYTES_PER_TUPLE = 1227;
const MWM_MARGIN_PCT = 30;

function memorySample() {
  const vm = execFileSync('vm_stat', { encoding: 'utf8' });
  const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16384);
  const free = Number(/Pages free:\s+(\d+)/.exec(vm)?.[1] ?? 0);
  const pageins = Number(/Pageins:\s+(\d+)/.exec(vm)?.[1] ?? 0);
  const pageouts = Number(/Pageouts:\s+(\d+)/.exec(vm)?.[1] ?? 0);
  const swap = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  const swapUsedMb = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0);
  return {
    freeMb: Math.round((free * pageSize) / 1048576),
    swapUsedMb,
    pageins,
    pageouts,
  };
}

function freeDiskGb() {
  const out = execFileSync('df', ['-g', '/System/Volumes/Data'], { encoding: 'utf8' });
  return Number(out.trim().split('\n')[1].split(/\s+/)[3]);
}

const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

const TABLE_DDL = (schema, dims) => `create unlogged table ${schema}.memories (
  id          bigint primary key,
  body        text not null,
  kind_id     smallint not null,
  person_id   smallint not null,
  place_id    smallint not null,
  occurred_at date not null,
  cluster_id  int not null,
  embedding   halfvec(${dims}),
  fts         tsvector generated always as (to_tsvector('english', body)) stored
)`;

// Exactly load.mjs's synthetic branch, including the deliberate ABSENCE of a
// bare occurred_at btree (DESIGN.md 6.7: the date is applied as a heap recheck
// over the FTS bitmap, which measured strictly cheaper at this shape).
const INDEX_SQL = (schema) => [
  { name: 'gin_fts', sql: `create index memories_fts_gin on ${schema}.memories using gin (fts)` },
  {
    name: 'hnsw',
    sql: `create index memories_embedding_hnsw on ${schema}.memories using hnsw (embedding halfvec_cosine_ops) with (m = 16, ef_construction = 200)`,
    hnsw: true,
  },
  {
    name: 'btree_person_occurred_at',
    sql: `create index memories_person_occurred_at_btree on ${schema}.memories (person_id, occurred_at)`,
  },
];

async function createIndexes(client, schema, { mwmMb, notices, only = null }) {
  const timings = [];
  for (const step of INDEX_SQL(schema)) {
    if (only && !only.includes(step.name)) continue;
    if (step.hnsw && mwmMb) await client.query(`set maintenance_work_mem = '${mwmMb}MB'`);
    const t0 = Date.now();
    await client.query(step.sql);
    const ms = Date.now() - t0;
    timings.push({ name: step.name, ms });
    log(`  index ${step.name}: ${(ms / 1000).toFixed(1)}s`);
  }
  if (notices.length) for (const n of notices) log(`  NOTICE: ${n}`);
  return timings;
}

// One chunk of the id space, inserted as a single statement. Chunk size is the
// resolution of the rate curve, so it is small enough to show the graph's cost
// growing and large enough that per-statement overhead is not what is measured.
async function insertChunks({ clients, schema, source, chunks, onChunk }) {
  let next = 0;
  const perChunk = [];
  async function worker(client) {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      const { lo, hi } = chunks[i];
      const t0 = Date.now();
      const res = await client.query(
        `insert into ${schema}.memories (id, body, kind_id, person_id, place_id, occurred_at, cluster_id, embedding)
         select id, body, kind_id, person_id, place_id, occurred_at, cluster_id, embedding
         from ${source} where id >= $1 and id < $2`,
        [lo, hi],
      );
      const ms = Date.now() - t0;
      perChunk.push({ index: i, lo, hi, rows: res.rowCount, ms });
      onChunk(perChunk.length, chunks.length, res.rowCount, ms);
    }
  }
  await Promise.all(clients.map(worker));
  return perChunk.sort((a, b) => a.index - b.index);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      arm: { type: 'string' },
      streams: { type: 'string', default: '1' },
      rows: { type: 'string', default: '1000000' },
      schema: { type: 'string' },
      source: { type: 'string', default: 'bench_r1m.memories' },
      // Which indexes exist BEFORE the rows land, for the incremental arm.
      // "hnsw" isolates the ANN graph's per-insert cost from GIN's, because a
      // combined number cannot say which index the wall clock belongs to.
      'pre-index': { type: 'string', default: 'all' },
      'chunk-rows': { type: 'string', default: '50000' },
      // Overrides the sized budget so a bulk build can be run under the memory
      // pressure a LARGER tier would put it under. Setting it to
      // (available GB / target rows) x rows-here rehearses a deliberate spill
      // at a size that fits, which is the only way to price the 10M bulk build
      // without having 15.9 GB to give it.
      'mwm-mb': { type: 'string' },
      out: { type: 'string' },
    },
  });

  const arm = args.arm;
  if (arm !== 'bulk' && arm !== 'incremental') {
    throw new Error(`--arm must be bulk or incremental (got "${arm}")`);
  }
  const schema = args.schema;
  if (!schema || !schema.startsWith(SCRATCH_PREFIX)) {
    throw new Error(`--schema must start with "${SCRATCH_PREFIX}" -- this script drops the schema it is given`);
  }
  const streams = Number(args.streams);
  const rows = Number(args.rows);
  const chunkRows = Number(args['chunk-rows']);
  const outPath = args.out ?? `.out/build-strategy/${schema}.json`;

  const mwmMb = args['mwm-mb']
    ? Number(args['mwm-mb'])
    : Math.max(512, Math.round((rows * BYTES_PER_TUPLE * (100 + MWM_MARGIN_PCT)) / 100 / 1048576));

  // Section 3.7: resolved target and schema on line one, before anything runs.
  log(`target=${config.db.url} arm=${arm} streams=${streams} rows=${rows} schema=${schema} source=${args.source}`);
  assertBenchTarget(config.db.url);
  log(`mwm for the bulk HNSW phase: ${mwmMb} MB (${BYTES_PER_TUPLE} B/tuple + ${MWM_MARGIN_PCT}%)`);
  const memBefore = memorySample();
  const diskBefore = freeDiskGb();
  log(`before: free ${memBefore.freeMb} MB, swap ${memBefore.swapUsedMb} MB, disk ${diskBefore} GB`);

  const admin = benchClient();
  await admin.connect();
  await admin.query('set statement_timeout = 0');
  const notices = [];
  admin.on('notice', (msg) => {
    const text = msg?.message ?? String(msg);
    if (/maintenance_work_mem/i.test(text)) notices.push(text);
  });

  const report = {
    arm, streams, rows, schema, source: args.source, chunkRows, mwmMb,
    generatedAt: new Date().toISOString(),
    memory: { before: memBefore },
    disk: { beforeGb: diskBefore },
  };

  try {
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.query(`create schema ${schema}`);
    await admin.query(TABLE_DDL(schema, 256));

    const chunks = [];
    for (let lo = 1; lo <= rows; lo += chunkRows) chunks.push({ lo, hi: Math.min(lo + chunkRows, rows + 1) });

    const preIndex = args['pre-index'] === 'all' ? null : args['pre-index'].split(',');
    const wall0 = Date.now();
    if (arm === 'incremental') {
      log(`creating ${preIndex ? preIndex.join('+') : 'all'} indexes on the EMPTY table, so every row below is an ordinary index insert`);
      report.indexTimings = await createIndexes(admin, schema, { mwmMb: null, notices, only: preIndex });
    }

    const clients = [admin];
    for (let i = 1; i < streams; i++) {
      const c = benchClient();
      await c.connect();
      await c.query('set statement_timeout = 0');
      clients.push(c);
    }

    const samples = [];
    const insert0 = Date.now();
    let done = 0;
    const perChunk = await insertChunks({
      clients, schema, source: args.source, chunks,
      onChunk: (n, total, chunkRowsDone, ms) => {
        done += chunkRowsDone;
        const elapsed = (Date.now() - insert0) / 1000;
        const rate = done / elapsed;
        const eta = (rows - done) / rate;
        const m = memorySample();
        samples.push({ rowsDone: done, elapsedSec: +elapsed.toFixed(1), ...m });
        log(
          `  ${n}/${total} chunks  rows=${done}  ${rate.toFixed(0)} rows/s  ` +
            `chunk ${(ms / 1000).toFixed(1)}s  ETA ${(eta / 60).toFixed(1)}m  ` +
            `free ${m.freeMb} MB  swap ${m.swapUsedMb} MB`,
        );
      },
    });
    const insertMs = Date.now() - insert0;
    log(`insert phase: ${(insertMs / 1000).toFixed(1)}s for ${done} rows (${(done / (insertMs / 1000)).toFixed(0)} rows/s)`);

    for (const c of clients.slice(1)) await c.end();

    if (arm === 'bulk') {
      log('building indexes AFTER the rows, the known baseline');
      report.indexTimings = await createIndexes(admin, schema, { mwmMb, notices });
    } else if (preIndex) {
      // Whatever was held back so its cost stayed out of the insert number
      // still has to exist before the schema can serve a query.
      const rest = INDEX_SQL(schema).map((s) => s.name).filter((n) => !preIndex.includes(n));
      log(`building the held-back indexes after the rows: ${rest.join(', ')}`);
      report.postIndexTimings = await createIndexes(admin, schema, { mwmMb, notices, only: rest });
    }
    const totalMs = Date.now() - wall0;

    await admin.query(`analyze ${schema}.memories`);

    const { rows: sizeRows } = await admin.query(
      `select c.relname, pg_relation_size(c.oid) as bytes
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r','i') order by bytes desc`,
      [schema],
    );
    const memAfter = memorySample();

    report.insertMs = insertMs;
    report.totalMs = totalMs;
    report.perChunk = perChunk;
    report.memorySamples = samples;
    report.memory.after = memAfter;
    report.memory.swapDeltaMb = memAfter.swapUsedMb - memBefore.swapUsedMb;
    report.memory.pageinsDelta = memAfter.pageins - memBefore.pageins;
    report.disk.afterGb = freeDiskGb();
    report.spillNotices = notices;
    report.sizes = Object.fromEntries(sizeRows.map((r) => [r.relname, Number(r.bytes)]));

    log(`TOTAL ${(totalMs / 1000).toFixed(1)}s (insert ${(insertMs / 1000).toFixed(1)}s)`);
    log(`spill NOTICEs: ${notices.length === 0 ? 'none' : notices.length}`);
    log(`swap delta ${report.memory.swapDeltaMb} MB, pageins delta ${report.memory.pageinsDelta}`);
    for (const [name, bytes] of Object.entries(report.sizes)) {
      log(`  ${name.padEnd(34)} ${(bytes / 1048576).toFixed(0)} MB`);
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    log(`report written -> ${outPath}`);
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
