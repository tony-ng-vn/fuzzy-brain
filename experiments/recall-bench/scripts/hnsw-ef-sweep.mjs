// The scale tier's vector lane on HNSW, measured on its own, against the real
// drifted query vectors (DESIGN.md 6.8's correction and 7.1's index change).
// Sibling of probe-recall.mjs, which measures the same thing on IVFFlat and is
// kept so 6.8's table still reproduces.
//
//   node scripts/hnsw-ef-sweep.mjs            # both arms
//   ARM=filtered N=120 node scripts/hnsw-ef-sweep.mjs
//
// Two arms, because the tier runs two different vector lanes and only one of
// them has ever been measured against a query it did not already know.
//
//   unfiltered  sweeps hnsw.ef_search and reports how often the target is in
//               the lane's top `depth`.
//   filtered    the date-constrained lane. config.lanes.scale's
//               filteredEfSearch / filteredIterativeScan / filteredMaxScanTuples
//               were tuned in 6.6 against ROWS RETURNED, with the target's own
//               embedding standing in for the query -- so "returns the full 30"
//               was never evidence that the 30 contain the target. This arm
//               asks the question that was skipped, and sweeps max_scan_tuples
//               as its own axis because that bound, not ef_search, is what caps
//               how far an iterative scan will walk.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { queryVector, DEFAULT_QUERY_DRIFT } = await import(`${BENCH}/lib/synth-vectors.mjs`);

// TIER is overridable so the same lane probe runs at 10M; default unchanged.
const TIER_NAME = process.env.TIER ?? 'rehearsal1m';
const tier = resolveTier(TIER_NAME);
const DEPTH = config.lanes.scale.depth;
const N = Number(process.env.N ?? 200);
const ARM = process.env.ARM ?? 'both';
const EFS = (process.env.EFS ?? '40,64,100,200,400').split(',').map(Number);

const client = benchClient();
await client.connect();

const all = readFileSync(`${BENCH}/.out/${TIER_NAME}/queries-test.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The drifted query vector, rebuilt exactly as gen-corpus made it. cluster_id
// lives on the corpus row, which is the fact that made deviation 2 removable.
async function withVectors(queries) {
  const ids = queries.map((q) => Number(q.targets[0]));
  const { rows } = await client.query(
    `select id, cluster_id from ${tier.schema}.memories where id = any($1::bigint[])`, [ids]);
  const clusterOf = new Map(rows.map((r) => [Number(r.id), r.cluster_id]));
  return queries.map((q) => {
    const t = Number(q.targets[0]);
    const v = queryVector(t, clusterOf.get(t), tier.dims, DEFAULT_QUERY_DRIFT);
    const df = q.declared_filters ?? {};
    // Same daterange literal engine.mjs's rangeLiteral builds, dates only.
    const span = df.date_from
      ? `[${df.date_from.slice(0, 10)}T00:00:00Z,${(df.date_to ?? '').slice(0, 10)}${df.date_to ? 'T00:00:00Z' : ''})`
      : null;
    return { q, target: t, span, lit: `[${Array.from(v).join(',')}]` };
  });
}

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function unfilteredArm() {
  const probes = await withVectors(all.slice(0, N));
  console.log(`\n=== unfiltered vector lane, HNSW, depth ${DEPTH}, ${probes.length} drifted queries ===`);
  console.log('setting            hit@1   hit@30   median ms');
  for (const setting of ['exact', ...EFS]) {
    if (setting === 'exact') await client.query('set enable_indexscan = off');
    else {
      await client.query('set enable_indexscan = on');
      await client.query(`set hnsw.ef_search = ${setting}`);
      await client.query('set hnsw.iterative_scan = off');
    }
    let h1 = 0; let h30 = 0; const ms = [];
    for (const p of probes) {
      const t0 = performance.now();
      const { rows } = await client.query(
        `select id from ${tier.schema}.memories order by embedding <=> $1::halfvec limit ${DEPTH}`, [p.lit]);
      ms.push(performance.now() - t0);
      const ids = rows.map((r) => Number(r.id));
      if (ids[0] === p.target) h1 += 1;
      if (ids.includes(p.target)) h30 += 1;
    }
    const label = setting === 'exact' ? 'exact (seq scan)' : `ef_search = ${setting}`;
    console.log(`${label.padEnd(18)} ${(h1 / probes.length).toFixed(3)}   ${(h30 / probes.length).toFixed(3)}    ${median(ms).toFixed(2)}`);
  }
}

async function filteredArm() {
  const dated = all.filter((q) => q.family === 'date_filter' && q.declared_filters?.date_from).slice(0, N);
  const probes = await withVectors(dated);
  console.log(`\n=== date-filtered vector lane, HNSW, depth ${DEPTH}, ${probes.length} drifted date_filter queries ===`);
  console.log('ef_search  iterative       max_scan  rows/30  hit@30   median ms');
  const grid = [];
  for (const ef of EFS) {
    // iterative_scan off is in the grid because the tier's target is INSIDE its
    // own date range by construction. That makes "return 30 rows past the
    // filter" and "return the target" different goals, and 6.6 tuned for the
    // first one. A plain filtered search returns fewer rows and may still hold
    // the target far more cheaply than walking the graph until 30 survive.
    grid.push({ ef, iter: 'off', scan: 20_000 });
    grid.push({ ef, iter: 'relaxed_order', scan: 2_000 });
    grid.push({ ef, iter: 'relaxed_order', scan: 20_000 });
    grid.push({ ef, iter: 'relaxed_order', scan: 100_000 });
  }
  await client.query('set enable_indexscan = on');
  for (const g of grid) {
    await client.query(`set hnsw.ef_search = ${g.ef}`);
    await client.query(`set hnsw.iterative_scan = ${g.iter}`);
    await client.query(`set hnsw.max_scan_tuples = ${g.scan}`);
    let hit = 0; let rowsSum = 0; const ms = [];
    for (const p of probes) {
      const t0 = performance.now();
      // The daterange containment the scale statement's vec_lane really uses
      // (engine.mjs's spanClause), not a >= / < variant: a different predicate
      // is a different plan, and this arm exists to price the real lane.
      const { rows } = await client.query(
        `select id from ${tier.schema}.memories
         where embedding is not null and occurred_at <@ $2::daterange
         order by embedding <=> $1::halfvec limit ${DEPTH}`,
        [p.lit, p.span]);
      ms.push(performance.now() - t0);
      rowsSum += rows.length;
      if (rows.some((r) => Number(r.id) === p.target)) hit += 1;
    }
    console.log(
      `${String(g.ef).padEnd(10)} ${g.iter.padEnd(15)} ${String(g.scan).padEnd(9)} ` +
      `${(rowsSum / probes.length).toFixed(1).padStart(6)}  ${(hit / probes.length).toFixed(3)}    ${median(ms).toFixed(2)}`);
  }
}

if (ARM === 'both' || ARM === 'unfiltered') await unfilteredArm();
if (ARM === 'both' || ARM === 'filtered') await filteredArm();
await client.end();
