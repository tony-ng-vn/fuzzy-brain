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
// 2. WITHDRAWN 2026-08-24 (DESIGN.md 6.8). This file used to hand the engine each
//    query's target's own stored `embedding` as the query vector, on the grounds
//    that QueryRecord carries no cluster_id. Handing the retrieval engine the
//    answer is not a query: it makes the vector lane trivially exact and turns
//    every recall number measured that way into an upper bound. cluster_id is a
//    column on the corpus row, so the drifted query vector CAN be rebuilt --
//    synthetic tiers now join it out of the table and regenerate the vector with
//    lib/synth-vectors.mjs, exactly as the corpus generator made it. Real-vector
//    tiers read load.mjs's query-vectors.f32 cache, which holds the real
//    embedding of the query TEXT. The stored-embedding path survives only as a
//    last-resort fallback for a real tier with no cache, and when it is taken the
//    report stamps queryVectorSource so no number sourced that way can be read as
//    a measurement of retrieval.
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
import { queryVector, DEFAULT_QUERY_DRIFT } from './lib/synth-vectors.mjs';
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

// Which splits a load window draws from. Both, historically and by default, so
// every number in DESIGN.md 7.4 and 7.6 still reproduces with no flag set. The
// filter exists so a tuning sweep can stay off the test split: bench-load never
// writes TEST-RUNS.log, but a setting chosen on the same queries it is later
// reported against is chosen on the test split all the same.
export function splitsToLoad(value) {
  if (value === undefined || value === 'both') return ['dev', 'test'];
  if (value === 'dev' || value === 'test') return [value];
  throw new Error(`--split must be one of dev, test, both (got "${value}")`);
}

function loadQueryPool(tierName, split) {
  const dir = `${OUT_DIR}/${tierName}`;
  const splits = splitsToLoad(split);
  const pool = [];
  let found = 0;
  for (const split of splits) {
    const f = `${dir}/queries-${split}.jsonl`;
    if (!existsSync(f)) continue;
    found += 1;
    // The real-vector query-vector cache is POSITIONAL over the unfiltered
    // split, so the row's original index has to travel with it or a subsetted
    // pool would pair each query with another query's embedding. Same contract
    // bench-recall.mjs reads (its loadQueryVectorCache comment owns the layout).
    let i = 0;
    for (const rec of readJsonlSync(f)) {
      const vecIndex = i++;
      if (rec.text && Array.isArray(rec.targets) && rec.targets.length > 0) {
        pool.push({ ...rec, split, vecIndex });
      }
    }
  }
  if (found === 0) {
    throw new Error(
      `no query files found under ${dir}/ for split(s) ${splits.join(', ')} -- run gen-corpus.mjs --tier ${tierName} first`,
    );
  }
  return pool;
}

// The query vector each pooled query is issued with, keyed by qid.
//
// This is the deviation-2 reversal (header note 2, DESIGN.md 6.8). What a load
// run must hand the engine is a vector standing in for what a user typed, never
// the target's own stored embedding.
export async function buildQueryVectors(queryPool, pgPool, tier, tierName) {
  if (tier.vector === 'synthetic') {
    const ids = [...new Set(queryPool.map((q) => q.targets[0]))];
    const clusterOf = new Map();
    const CHUNK = 5000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { rows } = await pgPool.query(
        `select id, cluster_id from ${tier.schema}.memories where id = any($1::bigint[])`,
        [ids.slice(i, i + CHUNK)],
      );
      // memories.id is bigint, so node-postgres hands back a string here (same
      // reason engine.mjs's retrieve() casts row.id). Pool targets are plain
      // numbers, so without the cast every lookup below would miss.
      for (const row of rows) clusterOf.set(Number(row.id), row.cluster_id);
    }
    const vectors = new Map();
    const missing = [];
    for (const q of queryPool) {
      const target = q.targets[0];
      const cluster = clusterOf.get(target);
      if (cluster == null) {
        missing.push(target);
        continue;
      }
      vectors.set(q.qid, queryVector(target, cluster, tier.dims, DEFAULT_QUERY_DRIFT));
    }
    if (missing.length) {
      throw new Error(
        `${missing.length} query targets are absent from ${tier.schema}.memories ` +
          `(first: ${missing.slice(0, 5).join(', ')}) -- the corpus and the query files disagree`,
      );
    }
    return { vectors, source: 'synth-vectors drifted query vector (rebuilt from cluster_id)' };
  }

  const cachePath = `${OUT_DIR}/${tierName}/query-vectors.f32`;
  if (existsSync(cachePath)) {
    const counts = { dev: 0, test: 0 };
    for (const split of ['dev', 'test']) {
      const f = `${OUT_DIR}/${tierName}/queries-${split}.jsonl`;
      if (existsSync(f)) counts[split] = readJsonlSync(f).length;
    }
    const buf = readFileSync(cachePath);
    const flat = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const dims = tier.dims;
    const needed = (counts.dev + counts.test) * dims;
    if (flat.length < needed) {
      throw new Error(
        `query-vectors cache too short: have ${flat.length} floats, need ${needed} ` +
          `(dev ${counts.dev} + test ${counts.test} at dims=${dims})`,
      );
    }
    const base = { dev: 0, test: counts.dev * dims };
    const vectors = new Map();
    for (const q of queryPool) {
      const off = base[q.split] + q.vecIndex * dims;
      vectors.set(q.qid, flat.subarray(off, off + dims));
    }
    return { vectors, source: 'real embedding of the query text (load.mjs query-vectors.f32)' };
  }

  // Last resort, and the report says so. A run sourced this way measures an
  // upper bound on retrieval, not retrieval (DESIGN.md 6.8).
  console.warn(
    `WARNING: ${cachePath} is missing, so this run falls back to the TARGET'S OWN stored embedding ` +
      `as the query vector. Recall measured this way is an upper bound, not a measurement. ` +
      `Build the cache with: node load.mjs --tier ${tierName}`,
  );
  const ids = [...new Set(queryPool.map((q) => q.targets[0]))];
  const byId = new Map();
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { rows } = await pgPool.query(
      `select id, embedding from ${tier.schema}.memories where id = any($1::bigint[])`,
      [ids.slice(i, i + CHUNK)],
    );
    for (const row of rows) {
      if (row.embedding != null) byId.set(Number(row.id), parseVectorLiteral(row.embedding));
    }
  }
  const vectors = new Map();
  for (const q of queryPool) {
    const v = byId.get(q.targets[0]);
    if (v) vectors.set(q.qid, v);
  }
  return { vectors, source: 'stored-embedding (UPPER BOUND, not a retrieval measurement)' };
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

// Whole-pipeline recall, reduced AFTER the window closes (DESIGN.md 6.8's
// binding decision: the claim is hybrid retrieval, so a throughput number
// unaccompanied by a recall number is not evidence for it).
//
// The hot loop only records `{ family, target, topIds, fusedRanks }` for the
// sampled fraction; everything below is arithmetic on that, so nothing here is
// charged to a latency sample. `topIds` is the POST-rerank order, which is what
// a caller of retrieve() would actually see.
export function summarizeRecall(probes, mixShares = null) {
  const byFamily = new Map();
  let deepSurvivors = 0;
  let survivorRankMax = 0;
  for (const p of probes) {
    const f = byFamily.get(p.family) ?? { n: 0, at1: 0, at10: 0 };
    f.n += 1;
    if (p.topIds[0] === p.target) f.at1 += 1;
    const hitIdx = p.topIds.indexOf(p.target);
    if (hitIdx >= 0 && hitIdx < 10) f.at10 += 1;
    byFamily.set(p.family, f);
    // How deep into the fused candidate set the surviving top-10 reached. This
    // is what prices cfg.rerank.topK without re-running a throughput window.
    for (let i = 0; i < Math.min(10, p.fusedRanks.length); i++) {
      survivorRankMax = Math.max(survivorRankMax, p.fusedRanks[i]);
      if (p.fusedRanks[i] > 25) deepSurvivors += 1;
    }
  }
  if (byFamily.size === 0) return null;

  const families = {};
  for (const [name, f] of [...byFamily].sort()) {
    families[name] = { n: f.n, recallAt1: f.at1 / f.n, recallAt10: f.at10 / f.n };
  }
  const names = Object.keys(families);
  // Two aggregates on purpose. The unweighted family mean is what DESIGN.md 6.8
  // reported (0.669), so it is the comparable number; the mix-weighted one is
  // what this query pool actually produces and is the honest headline.
  const unweightedAt10 = names.reduce((a, n) => a + families[n].recallAt10, 0) / names.length;
  const unweightedAt1 = names.reduce((a, n) => a + families[n].recallAt1, 0) / names.length;
  const total = names.reduce((a, n) => a + families[n].n, 0);
  const weight = (n) => (mixShares && mixShares[n] != null ? mixShares[n] : families[n].n / total);
  const weightSum = names.reduce((a, n) => a + weight(n), 0);
  const mixWeightedAt10 = names.reduce((a, n) => a + weight(n) * families[n].recallAt10, 0) / weightSum;
  const mixWeightedAt1 = names.reduce((a, n) => a + weight(n) * families[n].recallAt1, 0) / weightSum;

  return {
    probes: total,
    families,
    unweighted: { recallAt1: unweightedAt1, recallAt10: unweightedAt10 },
    mixWeighted: { recallAt1: mixWeightedAt1, recallAt10: mixWeightedAt10 },
    // Provable-cut evidence, not a tuning knob: zero deep survivors means
    // truncating the candidate set at 25 could not have changed any answer.
    topKPressure: { survivorsPastFusedRank25: deepSurvivors, deepestSurvivingFusedRank: survivorRankMax },
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

function printRecall(recall) {
  if (!recall) return;
  console.log(
    `whole-pipeline recall (${recall.probes} probes @ sample rate ${recall.sampleRate}): ` +
      `R@1 ${recall.mixWeighted.recallAt1.toFixed(3)} / R@10 ${recall.mixWeighted.recallAt10.toFixed(3)} mix-weighted, ` +
      `${recall.unweighted.recallAt10.toFixed(3)} R@10 unweighted family mean`,
  );
  for (const [family, f] of Object.entries(recall.families)) {
    console.log(
      `  ${family.padEnd(18)} n=${String(f.n).padStart(6)}  R@1 ${f.recallAt1.toFixed(3)}  R@10 ${f.recallAt10.toFixed(3)}`,
    );
  }
  const p = recall.topKPressure;
  console.log(
    `  final top-10 survivors past fused rank 25: ${p.survivorsPastFusedRank25} ` +
      `(deepest surviving fused rank ${p.deepestSurvivingFusedRank})`,
  );
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
    printRecall(o.recall);
  }
  if (report.closedSweep) {
    console.log('concurrency  completed_qps  p50ms   p95ms   p99ms   R@10(mix)');
    for (const row of report.closedSweep) {
      const r = row.recall ? row.recall.mixWeighted.recallAt10.toFixed(3) : 'n/a';
      console.log(
        `${String(row.concurrency).padEnd(11)}  ${row.qpsCompleted.toFixed(1).padEnd(13)}  ` +
          `${fmt(row.latencyMs.p50).padEnd(6)}  ${fmt(row.latencyMs.p95).padEnd(6)}  ` +
          `${fmt(row.latencyMs.p99).padEnd(6)}  ${r}`,
      );
    }
    printRecall(report.closedSweep[report.closedSweep.length - 1]?.recall);
  }
  if (report.queryVectorSource) console.log(`query vectors: ${report.queryVectorSource}`);
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
      'recall-sample-rate': { type: 'string' },
      split: { type: 'string' },
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

    const queryPool = loadQueryPool(tierName, values.split);
    const cappedPool =
      queryPool.length > config.load.distinctQueries
        ? makeRng(values.seed).sample(queryPool, config.load.distinctQueries)
        : queryPool;
    console.log(
      `query pool: ${cappedPool.length} distinct queries loaded (config target: ${config.load.distinctQueries})`,
    );
    report.queryPoolSize = cappedPool.length;
    report.queryPoolTarget = config.load.distinctQueries;

    const { vectors, source: queryVectorSource } = await buildQueryVectors(
      cappedPool, pgPool, tier, tierName,
    );
    console.log(`query vectors: ${queryVectorSource}`);
    report.queryVectorSource = queryVectorSource;
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

    // Recall is sampled rather than computed on every query so the hot path
    // stays a retrieval call and an object literal. The probes are reduced
    // after the window closes (summarizeRecall), so the rate bounds memory and
    // the error bar, never correctness. Deterministic stride over an already
    // shuffled cycle, so it reproduces and stays unbiased across families.
    const recallSampleRate = Number(values['recall-sample-rate'] ?? config.load.recallSampleRate);
    const recallStride = recallSampleRate > 0 ? Math.max(1, Math.round(1 / recallSampleRate)) : 0;
    const recallProbes = [];
    let issued = 0;

    const queryFn = async () => {
      const q = cycle();
      const queryVector = vectors.get(q.qid);
      const probe = recallStride > 0 && issued++ % recallStride === 0;
      const result = await engine.retrieve(pgPool, { text: q.text }, { ...engineCtx, queryVector });
      if (probe) {
        const top = result.hits.slice(0, 10);
        recallProbes.push({
          family: q.family ?? 'unknown',
          target: q.targets[0],
          topIds: top.map((h) => h.id),
          fusedRanks: top.map((h) => h.fusedRank ?? 0),
        });
      }
      return {
        sqlMs: result.timings?.sqlMs ?? null,
        rerankMs: result.timings?.rerankMs ?? null,
        totalMs: result.timings?.totalMs ?? null,
        lanes: result.lanes,
      };
    };
    const takeRecall = () => {
      const summary = summarizeRecall(recallProbes);
      recallProbes.length = 0;
      return summary ? { sampleRate: recallSampleRate, ...summary } : null;
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
        // Recall does not depend on offered rate, so warmup probes count too.
        recall: takeRecall(),
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
          recall: takeRecall(),
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
