// The scale tier's vector lane, measured on its own: how often does the IVFFlat
// index put the target in the lane's top 30, as a function of ivfflat.probes,
// and what does each setting cost. Drifted query vectors, which the exact
// (index-disabled) column proves rank the target #1 every time.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Bench root, resolved from this file rather than the caller's cwd.
const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { queryVector, DEFAULT_QUERY_DRIFT } = await import(`${BENCH}/lib/synth-vectors.mjs`);
const tier = resolveTier('rehearsal1m');
const DEPTH = config.lanes.scale.depth;
const N = Number(process.env.N ?? 120);
const c = benchClient(); await c.connect();

const qs = readFileSync(`${BENCH}/.out/rehearsal1m/queries-test.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, N);
const { rows: cl } = await c.query(
  `select id, cluster_id from ${tier.schema}.memories where id = any($1::bigint[])`,
  [qs.map((q) => Number(q.targets[0]))]);
const clusterOf = new Map(cl.map((r) => [Number(r.id), r.cluster_id]));
const vecs = qs.map((q) => {
  const t = Number(q.targets[0]);
  return { t, lit: `[${Array.from(queryVector(t, clusterOf.get(t), tier.dims, DEFAULT_QUERY_DRIFT)).join(',')}]` };
});

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`vector lane alone, depth ${DEPTH}, ${vecs.length} drifted queries\n`);
console.log('setting          hit@1   hit@30   median ms');
for (const setting of ['exact', 1, 8, 32, 100, 250]) {
  if (setting === 'exact') { await c.query('set enable_indexscan = off'); }
  else { await c.query('set enable_indexscan = on'); await c.query(`set ivfflat.probes = ${setting}`); }
  let h1 = 0; let h30 = 0; const ms = [];
  for (const v of vecs) {
    const t0 = performance.now();
    const { rows } = await c.query(
      `select id from ${tier.schema}.memories order by embedding <=> $1::halfvec limit ${DEPTH}`, [v.lit]);
    ms.push(performance.now() - t0);
    const ids = rows.map((r) => Number(r.id));
    if (ids[0] === v.t) h1 += 1;
    if (ids.includes(v.t)) h30 += 1;
  }
  const label = setting === 'exact' ? 'exact (seq scan)' : `probes = ${setting}`;
  console.log(`${label.padEnd(16)} ${(h1 / vecs.length).toFixed(3)}   ${(h30 / vecs.length).toFixed(3)}    ${med(ms).toFixed(2)}`);
}
await c.end();
