// Where a scale-tier query's time actually goes, per plan node, at 1M.
//
//   node scripts/explain-scale.mjs                    # every family, 6 queries each
//   FAMILY=date_filter N=10 node scripts/explain-scale.mjs
//   NODES=1 node scripts/explain-scale.mjs            # also dump the worst single plan
//
// The cut hunt (DESIGN.md 7.1, decision 4) needs to know which nodes carry the
// remaining milliseconds before anything is cut, or a change gets credited to
// the wrong thing. This runs the REAL statement engine.retrieve would run --
// same SQL, same bound parameters, same session GUCs -- by handing retrieve a
// client proxy that rewrites its one prepared statement into an EXPLAIN of
// itself. Nothing about the plan is reconstructed by hand, which is the only
// way the numbers describe the pipeline rather than a lookalike of it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { loadTermStats } = await import(`${BENCH}/lib/term-stats.mjs`);
const { queryVector, DEFAULT_QUERY_DRIFT } = await import(`${BENCH}/lib/synth-vectors.mjs`);
const engine = await import(`${BENCH}/engine.mjs`);
const { rerank } = await import(`${BENCH}/rerank.mjs`);

// TIER is overridable so the same instrument profiles rung 4 at 10M; the
// default reproduces the 1M numbers with no environment set.
const TIER_NAME = process.env.TIER ?? 'rehearsal1m';
const tier = resolveTier(TIER_NAME);
const profile = config.profiles.tunedScale;
const N = Number(process.env.N ?? 6);
const ONLY = process.env.FAMILY ?? null;
const DUMP = process.env.NODES === '1';

const client = benchClient();
await client.connect();
await client.query(engine.vectorSessionSettings(tier, config, false));

const all = readFileSync(`${BENCH}/.out/${TIER_NAME}/queries-test.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const families = [...new Set(all.map((q) => q.family))].filter((f) => !ONLY || f === ONLY);

const picked = [];
for (const f of families) picked.push(...all.filter((q) => q.family === f).slice(0, N));
const { rows: cl } = await client.query(
  `select id, cluster_id from ${tier.schema}.memories where id = any($1::bigint[])`,
  [picked.map((q) => Number(q.targets[0]))]);
const clusterOf = new Map(cl.map((r) => [Number(r.id), r.cluster_id]));

const vocab = await loadTermStats(client, tier);
const ctx = { tier, profile, vocab, cfg: config, rerank };

// The proxy: retrieve() issues exactly one named prepared statement for the
// pipeline and plain strings for its session GUCs. Rewriting only the named one
// leaves everything else -- including the GUCs the plan depends on -- untouched.
let lastPlan = null;
const proxy = {
  query: (arg, ...rest) => {
    if (arg && typeof arg === 'object' && arg.name && arg.text) {
      return client
        .query({ text: `explain (analyze, buffers, format json) ${arg.text}`, values: arg.values })
        .then((res) => {
          lastPlan = res.rows[0]['QUERY PLAN'][0];
          return { rows: [] }; // retrieve() maps over rows; an empty set is a valid no-hit
        });
    }
    return client.query(arg, ...rest);
  },
};

// Sum actual time into the node that owns it: a node's "Actual Total Time" is
// inclusive of its children, so subtracting the children is what attributes a
// millisecond once rather than at every level above it.
function walk(node, into, loopsAbove = 1) {
  const loops = node['Actual Loops'] ?? 1;
  const total = (node['Actual Total Time'] ?? 0) * loops;
  const kids = node.Plans ?? [];
  let kidTime = 0;
  for (const k of kids) kidTime += (k['Actual Total Time'] ?? 0) * (k['Actual Loops'] ?? 1);
  const self = Math.max(0, total - kidTime);
  const label = node['CTE Name']
    ? `CTE ${node['CTE Name']} / ${node['Node Type']}`
    : `${node['Node Type']}${node['Relation Name'] ? ` on ${node['Relation Name']}` : ''}${node['Index Name'] ? ` [${node['Index Name']}]` : ''}`;
  into.set(label, (into.get(label) ?? 0) + self);
  for (const k of kids) walk(k, into, loops);
}

const perFamily = new Map();
for (const q of picked) {
  const t = Number(q.targets[0]);
  const qv = queryVector(t, clusterOf.get(t), tier.dims, DEFAULT_QUERY_DRIFT);
  await engine.retrieve(proxy, { text: q.text, filters: q.declared_filters }, { ...ctx, queryVector: qv });
  if (!lastPlan) continue;
  const acc = perFamily.get(q.family) ?? { n: 0, exec: 0, plan: 0, nodes: new Map(), worst: null };
  acc.n += 1;
  acc.exec += lastPlan['Execution Time'] ?? 0;
  acc.plan += lastPlan['Planning Time'] ?? 0;
  walk(lastPlan.Plan, acc.nodes);
  if (!acc.worst || (lastPlan['Execution Time'] ?? 0) > acc.worst.t) {
    acc.worst = { t: lastPlan['Execution Time'] ?? 0, plan: lastPlan };
  }
  perFamily.set(q.family, acc);
}

console.log(`\nscale statement, plan-node time at 1M (${N} queries per family, mean ms)\n`);
for (const [family, acc] of perFamily) {
  console.log(`${family}  --  exec ${(acc.exec / acc.n).toFixed(2)} ms, planning ${(acc.plan / acc.n).toFixed(2)} ms`);
  const top = [...acc.nodes].map(([k, v]) => [k, v / acc.n]).sort((a, b) => b[1] - a[1]).slice(0, 7);
  for (const [label, ms] of top) {
    if (ms < 0.01) continue;
    console.log(`    ${ms.toFixed(3).padStart(7)} ms  ${label}`);
  }
  console.log('');
}

if (DUMP) {
  const worst = [...perFamily].sort((a, b) => b[1].worst.t - a[1].worst.t)[0];
  console.log(`\n=== slowest single plan (${worst[0]}, ${worst[1].worst.t.toFixed(2)} ms) ===`);
  console.log(JSON.stringify(worst[1].worst.plan, null, 1));
}

await client.end();
