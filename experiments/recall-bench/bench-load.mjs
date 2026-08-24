// bench-load.mjs -- open-loop / closed-loop throughput and latency bench.
// Implements DESIGN.md sections 7 (rung 3/4 gates), 8 (measuring claim B honestly),
// and the CLI in section 3.7 (minus the docker --in-container flag, dropped by the
// section 12 addendum: this machine runs native Postgres, no sidecar container).
//
// Usage (section 3.7):
//   node bench-load.mjs --tier <name> --profile <name>
//     [--mode open|closed|select1] [--offered-qps 2400] [--duration 120] [--warmup 60]
//     [--connections 96] [--sweep 8,16,32,64,96,128,192] [--out .out/load-10m.json]
//
// Deviations from the literal DESIGN.md text, and why, are collected at the bottom
// of this file's header comment rather than scattered, so a reviewer can find them
// in one place:
//
// 1. Query pool sourcing (section 8.3 wants 200,000 distinct generated queries).
//    gen-corpus.mjs's generateQueries() is sized by tier.queriesPerSplit (100 to
//    5,000), not by config.load.distinctQueries, and reaching 200k would mean
//    calling it with an overridden count against a fully materialized in-memory
//    index -- at the 10M tier that means holding 10M MemoryRecords in the load
//    client just to mint query text, which is a Track 2 concern this file has no
//    contract to drive. Instead this file loads whatever queries-dev.jsonl and
//    queries-test.jsonl already contain for the tier (the frozen QueryRecord shape,
//    section 3.2) and reports the actual distinct count used alongside the
//    config target, rather than fabricating 200k. This is the "report the number
//    that was measured, never a fudge" rule from section 9 applied to the query
//    pool itself.
// 2. Query vectors for the load workload. QueryRecord carries no cluster_id, so a
//    synthetic-tier query vector cannot be reconstructed from the query file alone
//    via synth-vectors.mjs. Instead this file fetches each query's target's stored
//    `embedding` directly from the database in one batched SELECT during setup
//    (not the hot loop) -- exact, self-contained, and correct for both real and
//    synthetic vector tiers without depending on any unwritten Track 2 internals.
// 3. Vocab for engine.mjs's EngineContext.vocab is not a frozen shape anywhere in
//    DESIGN.md. This file builds one itself from Postgres's built-in ts_stat() over
//    the already-ingested fts/to_tsvector(body) expression: { totalDocs, df } where
//    df maps a stemmed term to an (optionally sampled-and-scaled) document count,
//    matching the idf = ln(N/df) comment already in config.mjs's weighting block.
//    Above 200k rows this samples via TABLESAMPLE SYSTEM to bound setup cost at the
//    10M tier; the estimate is approximate by construction, which is fine since it
//    only gates a query-dependent weighting heuristic, not a correctness check.
// 4. lib/stats.mjs, lib/report.mjs, and lib/jsonl.mjs are named in DESIGN.md's
//    directory layout but none of their function signatures are frozen the way
//    lib/safety.mjs, lib/rng.mjs, engine.mjs, and rerank.mjs are (section 3.6).
//    Rather than guess a shape those files may not end up matching, this file
//    inlines the small amount of percentile math, JSONL reading, and console table
//    printing it needs. It still writes the load report as its own JSON file, which
//    is this module's stated job per the assignment.
// 5. A few additive, non-breaking CLI flags beyond section 3.7's list:
//    --sweep-duration and --sweep-warmup (per-step duration for --mode closed,
//    since the design does not pin one) and --skip-select1-probe (bypass the
//    section 8.1 ceiling probe that otherwise runs automatically before every
//    open/closed run). Every flag in section 3.7 still works unmodified.

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { config, resolveTier } from './config.mjs';
import { assertBenchTarget, benchPool } from './lib/safety.mjs';
import { loadTermStats } from './lib/term-stats.mjs';
import { makeRng } from './lib/rng.mjs';
import * as engine from './engine.mjs';
import { rerank as rerankFn } from './rerank.mjs';

const OUT_DIR = '.out';
const DISK_BUDGET_GB = 30; // section 3.5

// ---------------------------------------------------------------------------
// small self-contained utilities (see header note 4 for why these are inline)
// ---------------------------------------------------------------------------

function readJsonlSync(path) {
  const text = readFileSync(path, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) out.push(JSON.parse(trimmed));
  }
  return out;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Window validity (section 8.2's "any of them failing invalidates the run").
//
// Added 2026-08-24 after an overnight knee sweep and a closed-loop sweep both had
// to be thrown away. This machine suspends while running on battery -- the battery
// power profile carries `sleep 1` against AC's `sleep 0`, and the running
// caffeinate holds only PreventUserIdleSystemSleep, which does not stop macOS's
// Maintenance Sleep. pmset logged a 659-second sleep straight through a sweep. A
// window spanning one reports a healthy-looking completed count with a p50 in the
// hundreds of seconds.
//
// Comparing the wall clock against Node's monotonic clock does NOT detect this:
// Darwin's clock keeps advancing across a suspend, so the two agree. What cannot
// be faked is the dispatch ticker -- it is scheduled every 10ms, so a multi-second
// gap between consecutive ticks means the machine stopped running us. That is the
// suspend signal; wall time far past the schedule with no such gap is a genuine
// throughput collapse. Either way the number is not a measurement of the server,
// and the report has to say so itself rather than leave it to be inferred.
const SUSPEND_STALL_SEC = 5;
const OVERRUN_TOLERANCE = 0.25;

export function assessWindow({ expectedSec, wallSec, perfSec, maxStallSec = 0 }) {
  const overranBy = (wallSec - expectedSec) / expectedSec;
  const clockSkewSec = wallSec - perfSec;
  let reason = null;
  if (maxStallSec > SUSPEND_STALL_SEC) {
    reason =
      `machine suspend during the window: the dispatch ticker stalled for ` +
      `${maxStallSec.toFixed(1)}s (scheduled every 10ms)`;
  } else if (overranBy > OVERRUN_TOLERANCE) {
    reason =
      `window overran its schedule: ${wallSec.toFixed(1)}s wall against ${expectedSec}s scheduled ` +
      `(${(overranBy * 100).toFixed(0)}% over)`;
  }
  return { valid: reason === null, reason, wallSec, perfSec, clockSkewSec, overranBy, maxStallSec };
}

function parseVectorLiteral(text) {
  // pg returns vector/halfvec as a bracketed csv string absent a custom type parser;
  // this is the inverse of that literal, back into what engine.mjs's ctx.queryVector expects.
  return Float32Array.from(text.slice(1, -1).split(',').map(Number));
}

// ---------------------------------------------------------------------------
// setup: query pool, target vectors, vocab, disk budget, cache stats
// ---------------------------------------------------------------------------

function loadQueryPool(tierName) {
  const dir = `${OUT_DIR}/${tierName}`;
  const files = ['queries-dev.jsonl', 'queries-test.jsonl']
    .map((f) => `${dir}/${f}`)
    .filter(existsSync);
  if (files.length === 0) {
    throw new Error(
      `no query files found under ${dir}/ -- run gen-corpus.mjs --tier ${tierName} first`,
    );
  }
  const pool = [];
  for (const f of files) {
    for (const rec of readJsonlSync(f)) {
      if (rec.text && Array.isArray(rec.targets) && rec.targets.length > 0) pool.push(rec);
    }
  }
  return pool;
}

async function fetchTargetVectors(queryPool, pgPool, schema) {
  const ids = [...new Set(queryPool.map((q) => q.targets[0]))];
  const vectors = new Map();
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { rows } = await pgPool.query(
      `select id, embedding from ${schema}.memories where id = any($1::bigint[])`,
      [chunk],
    );
    for (const row of rows) {
      // memories.id is bigint, so node-postgres hands back a string here (same
      // reason engine.mjs's retrieve() casts row.id -- see its comment on the
      // `id: Number(row.id)` line). queryPool targets are plain JS numbers, so
      // without this cast every Map.get(q.targets[0]) below misses and every
      // query silently runs with queryVector === undefined.
      if (row.embedding != null) vectors.set(Number(row.id), parseVectorLiteral(row.embedding));
    }
  }
  return vectors;
}

async function buildVocab(pgPool, schema, tier) {
  // Preferred path (DESIGN.md 6.6): read the exact per-schema term statistics
  // load.mjs precomputed. This is not just cheaper setup -- the scale tier's
  // rare-term anchoring needs an exact surface-word -> document-frequency
  // lookup, and the sampled fallback below cannot provide one.
  const precomputed = await loadTermStats(pgPool, tier);
  if (precomputed) return precomputed;

  if (tier.vector === 'synthetic') {
    throw new Error(
      `${schema}.term_stats is missing: the scale path's rare-term anchoring and spell correction ` +
        `both read it. Build it with: node load.mjs --tier ${tier.name} --term-stats`,
    );
  }

  // ts_stat() scans whatever query it is given; TABLESAMPLE bounds the cost at the
  // 10M tier so vocab setup does not itself become the thing being measured. idf
  // only needs to be roughly right to gate the rareTermBoost heuristic, not exact.
  const isSynthetic = tier.vector === 'synthetic';
  const expr = isSynthetic ? "to_tsvector('english', body)" : 'fts';
  const samplePct = tier.memories > 200_000 ? 5 : 100;
  const scale = 100 / samplePct;

  const { rows: countRows } = await pgPool.query(
    `select count(*)::bigint as n from ${schema}.memories tablesample system (${samplePct})`,
  );
  const totalDocs = Math.round(Number(countRows[0].n) * scale);

  const { rows } = await pgPool.query(
    `select word, ndoc from ts_stat($$select ${expr} from ${schema}.memories tablesample system (${samplePct})$$)`,
  );
  const df = new Map();
  for (const r of rows) df.set(r.word, Math.max(1, Math.round(Number(r.ndoc) * scale)));

  return { totalDocs, df, sampled: samplePct < 100, samplePct };
}

async function bufferHitRatio(pgPool, schema) {
  const { rows } = await pgPool.query(
    `select heap_blks_read, heap_blks_hit, idx_blks_read, idx_blks_hit
     from pg_statio_user_tables where schemaname = $1 and relname = 'memories'`,
    [schema],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const heapRead = Number(r.heap_blks_read) || 0;
  const heapHit = Number(r.heap_blks_hit) || 0;
  const idxRead = Number(r.idx_blks_read) || 0;
  const idxHit = Number(r.idx_blks_hit) || 0;
  const heapTotal = heapRead + heapHit;
  const idxTotal = idxRead + idxHit;
  return {
    heap: heapTotal ? heapHit / heapTotal : null,
    index: idxTotal ? idxHit / idxTotal : null,
  };
}

async function assertDiskBudget(pgPool, schema) {
  const { rows } = await pgPool.query('select to_regclass($1) as reg', [`${schema}.memories`]);
  if (!rows[0].reg) {
    console.log(`schema ${schema}.memories does not exist yet -- skipping disk-budget check`);
    return;
  }
  const { rows: sizeRows } = await pgPool.query('select pg_total_relation_size($1) as bytes', [
    `${schema}.memories`,
  ]);
  const gb = Number(sizeRows[0].bytes) / 1024 ** 3;
  console.log(`schema size: ${gb.toFixed(2)} GB`);
  if (gb > DISK_BUDGET_GB) {
    throw new Error(
      `refusing to start: ${schema} totals ${gb.toFixed(1)} GB, over the ${DISK_BUDGET_GB} GB budget (DESIGN.md 3.5)`,
    );
  }
}

function makeQueryCycler(queryPool, rng) {
  // Shuffle-then-consume guarantees no immediate repeat within a pass (section 8.3);
  // guard the pass boundary too, since a naive reshuffle can put the same query on
  // both sides of the seam.
  let order = rng.shuffle(queryPool.map((_, i) => i));
  let i = 0;
  return function next() {
    if (i >= order.length) {
      const prevLast = order[order.length - 1];
      order = rng.shuffle(queryPool.map((_, idx) => idx));
      if (order.length > 1 && order[0] === prevLast) [order[0], order[1]] = [order[1], order[0]];
      i = 0;
    }
    return queryPool[order[i++]];
  };
}

// ---------------------------------------------------------------------------
// load generators
// ---------------------------------------------------------------------------

async function runClosedLoop({ concurrency, durationSec, warmupSec, queryFn }) {
  const totalSec = warmupSec + durationSec;
  const startTime = performance.now();
  const startWall = Date.now();
  const samples = [];
  let dispatched = 0;
  let completed = 0;

  async function worker() {
    while ((performance.now() - startTime) / 1000 < totalSec) {
      const t0 = performance.now();
      dispatched++;
      try {
        const res = await queryFn();
        const now = performance.now();
        completed++;
        if ((now - startTime) / 1000 >= warmupSec) {
          samples.push({ latencyMs: now - t0, error: null, ...res });
        }
      } catch (err) {
        const now = performance.now();
        completed++;
        if ((now - startTime) / 1000 >= warmupSec) {
          samples.push({ latencyMs: now - t0, error: String(err && err.message ? err.message : err) });
        }
      }
    }
  }

  // The closed loop has no dispatch ticker of its own, so it carries a bare timer
  // purely as the suspend detector (see assessWindow).
  let maxStallSec = 0;
  let lastTick = performance.now();
  const watchdog = setInterval(() => {
    const tickNow = performance.now();
    maxStallSec = Math.max(maxStallSec, (tickNow - lastTick) / 1000);
    lastTick = tickNow;
  }, 10);

  await Promise.all(Array.from({ length: concurrency }, worker));
  clearInterval(watchdog);
  const window = assessWindow({
    expectedSec: totalSec,
    wallSec: (Date.now() - startWall) / 1000,
    perfSec: (performance.now() - startTime) / 1000,
    maxStallSec,
  });
  return { samples, dispatched, completed, window };
}

async function runOpenLoop({ offeredQps, durationSec, warmupSec, queryFn }) {
  // A single ticker computes how many requests are "due" by elapsed wall time and
  // fires them without waiting on completion -- that is what makes this open-loop:
  // the offered rate never slows down because the server is slow (section 8.2).
  const intervalMs = 1000 / offeredQps;
  const totalSec = warmupSec + durationSec;
  const totalRequests = Math.round(totalSec * offeredQps);
  const startTime = performance.now();
  const startWall = Date.now();
  const samples = [];
  const inFlightSnapshots = [];
  let dispatched = 0;
  let completed = 0;
  let inFlight = 0;

  function dispatchOne(n) {
    const scheduledAt = startTime + n * intervalMs;
    inFlight++;
    dispatched++;
    queryFn()
      .then((res) => {
        const now = performance.now();
        inFlight--;
        completed++;
        if ((now - startTime) / 1000 >= warmupSec) {
          samples.push({ latencyMs: now - scheduledAt, error: null, ...res });
        }
      })
      .catch((err) => {
        const now = performance.now();
        inFlight--;
        completed++;
        if ((now - startTime) / 1000 >= warmupSec) {
          samples.push({
            latencyMs: now - scheduledAt,
            error: String(err && err.message ? err.message : err),
          });
        }
      });
  }

  let maxStallSec = 0;
  let lastTick = performance.now();
  await new Promise((resolve) => {
    const ticker = setInterval(() => {
      const tickNow = performance.now();
      maxStallSec = Math.max(maxStallSec, (tickNow - lastTick) / 1000);
      lastTick = tickNow;
      const elapsedMs = performance.now() - startTime;
      const due = Math.min(totalRequests, Math.floor(elapsedMs / intervalMs) + 1);
      while (dispatched < due) dispatchOne(dispatched);
      inFlightSnapshots.push({ tSec: elapsedMs / 1000, inFlight });
      if (dispatched >= totalRequests && inFlight === 0) {
        clearInterval(ticker);
        resolve();
      }
    }, 10);
  });

  const window = assessWindow({
    expectedSec: totalSec,
    wallSec: (Date.now() - startWall) / 1000,
    perfSec: (performance.now() - startTime) / 1000,
    maxStallSec,
  });
  return { samples, dispatched, completed, inFlightSnapshots, window };
}

async function selectOneCeiling(pgPool, { durationSec = 5, concurrency = 32 } = {}) {
  const { samples } = await runClosedLoop({
    concurrency,
    durationSec,
    warmupSec: 0,
    queryFn: async () => {
      await pgPool.query('select 1');
      return {};
    },
  });
  const lat = samples.filter((s) => !s.error).map((s) => s.latencyMs).sort((a, b) => a - b);
  return { qps: samples.length / durationSec, p50: percentile(lat, 50) };
}

// ---------------------------------------------------------------------------
// stats and reporting
// ---------------------------------------------------------------------------

function summarizeSamples(samples, durationSec) {
  const ok = samples.filter((s) => !s.error && typeof s.latencyMs === 'number');
  const lat = ok.map((s) => s.latencyMs).sort((a, b) => a - b);
  const sqlMsSorted = ok.map((s) => s.sqlMs).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const rerankMsSorted = ok
    .map((s) => s.rerankMs)
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);

  return {
    count: samples.length,
    errors: samples.length - ok.length,
    qpsCompleted: samples.length / durationSec,
    latencyMs: {
      p50: percentile(lat, 50),
      p90: percentile(lat, 90),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      p999: percentile(lat, 99.9),
      max: lat.length ? lat[lat.length - 1] : null,
      mean: mean(lat),
    },
    sqlMs: sqlMsSorted.length
      ? { mean: mean(sqlMsSorted), p95: percentile(sqlMsSorted, 95) }
      : null,
    rerankMs: rerankMsSorted.length
      ? { mean: mean(rerankMsSorted), p95: percentile(rerankMsSorted, 95) }
      : null,
  };
}

function summarizeLanes(samples) {
  const laneCounts = {};
  for (const s of samples) {
    if (!s.lanes) continue;
    for (const [lane, ids] of Object.entries(s.lanes)) {
      (laneCounts[lane] ??= []).push(Array.isArray(ids) ? ids.length : 0);
    }
  }
  const out = {};
  for (const [lane, counts] of Object.entries(laneCounts)) out[lane] = mean(counts);
  return out;
}

function printSummary(report) {
  console.log('--- summary ---');
  if (report.selectOneCeiling) {
    const c = report.selectOneCeiling;
    console.log(
      `select1 ceiling: ${c.qps.toFixed(0)} qps, p50 ${c.p50 == null ? 'n/a' : c.p50.toFixed(2)} ms ` +
        `(floor ${c.floor}, ${c.pass ? 'pass' : 'FAIL'})`,
    );
  }
  if (report.open) {
    const o = report.open;
    if (o.window && !o.window.valid) {
      console.log(`WINDOW INVALID -- ${o.window.reason}. Rerun; this number measures nothing.`);
    }
    console.log(
      `open-loop: offered ${o.offeredQps} qps, completed ${o.qpsCompleted.toFixed(1)} qps ` +
        `(${o.completed}/${o.dispatched}, ${o.errors} errors)`,
    );
    const l = o.latencyMs;
    console.log(
      `latency ms: p50=${fmt(l.p50)} p90=${fmt(l.p90)} p95=${fmt(l.p95)} p99=${fmt(l.p99)} ` +
        `p999=${fmt(l.p999)} max=${fmt(l.max)}`,
    );
    console.log(
      `gate: ${report.gate.pass ? 'PASS' : 'FAIL'} (target ${report.gate.qpsTarget} qps @ p50 <= ${report.gate.p50TargetMs} ms)`,
    );
  }
  if (report.closedSweep) {
    console.log('concurrency  completed_qps  p50ms   p95ms   p99ms');
    for (const row of report.closedSweep) {
      console.log(
        `${String(row.concurrency).padEnd(11)}  ${row.qpsCompleted.toFixed(1).padEnd(13)}  ` +
          `${fmt(row.latencyMs.p50).padEnd(6)}  ${fmt(row.latencyMs.p95).padEnd(6)}  ${fmt(row.latencyMs.p99)}`,
      );
    }
  }
}

function fmt(v) {
  return v == null ? 'n/a' : v.toFixed(2);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      tier: { type: 'string' },
      profile: { type: 'string' },
      mode: { type: 'string' },
      'offered-qps': { type: 'string' },
      duration: { type: 'string' },
      warmup: { type: 'string' },
      connections: { type: 'string' },
      sweep: { type: 'string' },
      'sweep-duration': { type: 'string', default: '20' },
      'sweep-warmup': { type: 'string', default: '5' },
      out: { type: 'string' },
      'skip-select1-probe': { type: 'boolean', default: false },
      seed: { type: 'string', default: 'recall-bench-load-v1' },
    },
  });

  const tierName = values.tier;
  if (!tierName || !config.tiers[tierName]) {
    throw new Error(`--tier is required and must be one of: ${Object.keys(config.tiers).join(', ')}`);
  }
  const tier = resolveTier(tierName);
  const mode = values.mode ?? config.load.mode;
  if (!['open', 'closed', 'select1'].includes(mode)) {
    throw new Error(`--mode must be one of open, closed, select1 (got "${mode}")`);
  }

  const profileName = values.profile;
  if (mode !== 'select1' && (!profileName || !config.profiles[profileName])) {
    throw new Error(
      `--profile is required for mode "${mode}" and must be one of: ${Object.keys(config.profiles).join(', ')}`,
    );
  }
  const profile = profileName ? config.profiles[profileName] : null;

  const connectionString = config.db.url;
  // Print the resolved target before validating it, so a wrong target is visible
  // even when assertBenchTarget is about to reject it (section 3.7's closing rule).
  console.log(
    `target: ${connectionString} | tier: ${tierName} (schema ${tier.schema}) | mode: ${mode}` +
      (profileName ? ` | profile: ${profileName}` : ''),
  );
  assertBenchTarget(connectionString);

  const connections = Number(values.connections ?? config.db.poolSize);
  // Pin the vector GUCs at connection creation rather than leaving them to
  // engine.retrieve's per-pool cache, which only ever reached one connection.
  const pgPool = benchPool(connections, config.db.url,
    profile ? engine.vectorSessionSettings(tier, config, false) : null);

  try {
    await assertDiskBudget(pgPool, tier.schema);

    const outPath = values.out ?? `${OUT_DIR}/${tierName}/load-${mode}.json`;
    mkdirSync(dirname(outPath), { recursive: true });

    const report = {
      tier: tierName,
      schema: tier.schema,
      mode,
      profile: profileName ?? null,
      connections,
      generatedAt: new Date().toISOString(),
    };

    // Step 0 (section 8.1): the trivial-query ceiling must clear ~4x the offered
    // rate or this run is measuring the client/network, not the server.
    if (!values['skip-select1-probe']) {
      const ceiling = await selectOneCeiling(pgPool);
      const offeredQps = Number(values['offered-qps'] ?? config.load.offeredQps);
      const floor = mode === 'closed' ? 10_000 : offeredQps * 4;
      report.selectOneCeiling = { ...ceiling, floor, pass: ceiling.qps >= floor };
      if (!report.selectOneCeiling.pass) {
        console.warn(
          `WARNING: select1 ceiling ${ceiling.qps.toFixed(0)} qps is below ${floor} qps -- ` +
            `this run may be measuring the client, not the server (DESIGN.md 8.1)`,
        );
      }
    }

    if (mode === 'select1') {
      writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`report written: ${outPath}`);
      printSummary(report);
      return;
    }

    const queryPool = loadQueryPool(tierName);
    const cappedPool =
      queryPool.length > config.load.distinctQueries
        ? makeRng(values.seed).sample(queryPool, config.load.distinctQueries)
        : queryPool;
    console.log(
      `query pool: ${cappedPool.length} distinct queries loaded (config target: ${config.load.distinctQueries})`,
    );
    report.queryPoolSize = cappedPool.length;
    report.queryPoolTarget = config.load.distinctQueries;

    const vectors = await fetchTargetVectors(cappedPool, pgPool, tier.schema);
    const vocab = await buildVocab(pgPool, tier.schema, tier);
    report.vocab = {
      totalDocs: vocab.totalDocs,
      lexemes: vocab.df.size,
      terms: vocab.terms ? vocab.terms.size : 0,
      sampled: vocab.sampled,
      samplePct: vocab.samplePct,
    };

    const bufferBefore = await bufferHitRatio(pgPool, tier.schema);

    const engineCtx = {
      tier,
      profile,
      vocab,
      cfg: config,
      rerank: profile.rerank ? rerankFn : undefined,
    };
    const rng = makeRng(values.seed);
    const cycle = makeQueryCycler(cappedPool, rng);

    const queryFn = async () => {
      const q = cycle();
      const queryVector = vectors.get(q.targets[0]);
      const result = await engine.retrieve(pgPool, { text: q.text }, { ...engineCtx, queryVector });
      return {
        sqlMs: result.timings?.sqlMs ?? null,
        rerankMs: result.timings?.rerankMs ?? null,
        totalMs: result.timings?.totalMs ?? null,
        lanes: result.lanes,
      };
    };

    if (mode === 'open') {
      const offeredQps = Number(values['offered-qps'] ?? config.load.offeredQps);
      const durationSec = Number(values.duration ?? config.load.durationSec);
      const warmupSec = Number(values.warmup ?? config.load.warmupSec);

      const { samples, dispatched, completed, inFlightSnapshots, window } = await runOpenLoop({
        offeredQps,
        durationSec,
        warmupSec,
        queryFn,
      });
      const summary = summarizeSamples(samples, durationSec);

      // A queue that grows across the window means the system is not keeping up,
      // whatever the completed count claims (section 8.2's validity condition).
      const quarter = Math.max(1, Math.floor(inFlightSnapshots.length / 4));
      const early = mean(inFlightSnapshots.slice(0, quarter).map((s) => s.inFlight));
      const late = mean(inFlightSnapshots.slice(-quarter).map((s) => s.inFlight));
      const inFlightGrowing = inFlightSnapshots.length > 4 && late > early * 1.5;

      const offeredMatchesCompleted =
        dispatched > 0 && Math.abs(dispatched - completed) / dispatched <= 0.005;

      report.open = {
        offeredQps,
        durationSec,
        warmupSec,
        dispatched,
        completed,
        offeredMatchesCompleted,
        inFlightGrowing,
        window,
        ...summary,
        laneRowsExamined: summarizeLanes(samples),
      };
      report.bufferHitRatio = { before: bufferBefore, after: await bufferHitRatio(pgPool, tier.schema) };
      report.gate = {
        qpsTarget: offeredQps,
        qpsAchieved: summary.qpsCompleted,
        p50TargetMs: config.load.latencyBudgetMs.p50,
        p50ActualMs: summary.latencyMs.p50,
        pass:
          window.valid &&
          offeredMatchesCompleted &&
          !inFlightGrowing &&
          summary.qpsCompleted >= offeredQps * 0.995 &&
          summary.latencyMs.p50 != null &&
          summary.latencyMs.p50 <= config.load.latencyBudgetMs.p50,
      };
    } else if (mode === 'closed') {
      const sweep = (values.sweep ? values.sweep.split(',') : config.load.closedLoopSweep.map(String)).map(
        Number,
      );
      const sweepDuration = Number(values['sweep-duration']);
      const sweepWarmup = Number(values['sweep-warmup']);

      report.closedSweep = [];
      for (const concurrency of sweep) {
        const { samples, dispatched, completed, window } = await runClosedLoop({
          concurrency,
          durationSec: sweepDuration,
          warmupSec: sweepWarmup,
          queryFn,
        });
        const summary = summarizeSamples(samples, sweepDuration);
        if (!window.valid) console.log(`  concurrency ${concurrency}: WINDOW INVALID -- ${window.reason}`);
        report.closedSweep.push({
          concurrency,
          dispatched,
          completed,
          window,
          ...summary,
          laneRowsExamined: summarizeLanes(samples),
        });
      }
      report.bufferHitRatio = { before: bufferBefore, after: await bufferHitRatio(pgPool, tier.schema) };
    }

    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`report written: ${outPath}`);
    printSummary(report);
  } finally {
    await pgPool.end();
  }
}

// Only run the CLI when this file IS the entry point. Without the guard,
// importing this module for a test or a REPL fires a full bench run --
// including a database connection -- as a side effect of the import.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  });
}
