// Does binary_quantize preserve enough of this corpus's cosine geometry to be
// worth an index? (DESIGN.md 7.8, experiment 3.)
//
//   TIER=full10m N=40 node scripts/bq-agreement.mjs
//
// A binary lane is only useful if reranking a Hamming-ordered candidate list by
// halfvec cosine recovers the cosine ranking. This measures exactly that, and it
// measures it BEFORE paying for a 10M graph build, so an index that could never
// have worked is a five-minute finding instead of a two-hour one.
//
// The probe runs against a 1/20 sample of the corpus held in its own unlogged
// table, so every point is an EXACT scan rather than an approximate one -- the
// question here is about the quantizer, not about a graph. What that costs is
// stated rather than hidden: a candidate list of M rows in a 500,000-row sample
// is the same share of the corpus as 20M rows in the full 10,000,000, so the
// oversample factor this reports is a factor over the SAMPLE, and it carries to
// the full corpus only insofar as Hamming-vs-cosine rank agreement is a property
// of the vector distribution rather than of N.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveTier } = await import(`${BENCH}/config.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { queryVector, DEFAULT_QUERY_DRIFT } = await import(`${BENCH}/lib/synth-vectors.mjs`);

const TIER_NAME = process.env.TIER ?? 'full10m';
const tier = resolveTier(TIER_NAME);
const N = Number(process.env.N ?? 40);
const SPLIT = process.env.SPLIT ?? 'dev';
const MS = (process.env.MS ?? '10,20,30,60,100,200,400,600,1200').split(',').map(Number);
const K = Number(process.env.K ?? 10);
const SAMPLE = `${tier.schema}.bq_probe`;

const client = benchClient();
await client.connect();

const { rows: [{ n: sampleRows }] } = await client.query(`select count(*)::bigint as n from ${SAMPLE}`);
console.log(`sample table ${SAMPLE}: ${sampleRows} rows (1/20 of ${tier.memories})`);

const queries = readFileSync(`${BENCH}/.out/${TIER_NAME}/queries-${SPLIT}.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, N);
const ids = queries.map((q) => Number(q.targets[0]));
const { rows: clusterRows } = await client.query(
  `select id, cluster_id from ${tier.schema}.memories where id = any($1::bigint[])`, [ids]);
const clusterOf = new Map(clusterRows.map((r) => [Number(r.id), r.cluster_id]));

const probes = queries.map((q) => {
  const t = Number(q.targets[0]);
  const v = queryVector(t, clusterOf.get(t), tier.dims, DEFAULT_QUERY_DRIFT);
  return { family: q.family, lit: `[${Array.from(v).join(',')}]` };
});

// Parallel workers are what make an exact scan of the sample affordable; the
// geometry probe already raises this for the same reason.
await client.query('set max_parallel_workers_per_gather = 6');

const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

// The cosine top-K of the sample is the thing a binary lane has to hand the
// reranker. Anything it misses at candidate depth M, the rerank cannot recover.
const truth = [];
const cosineMs = [];
for (const p of probes) {
  const t0 = performance.now();
  const { rows } = await client.query(
    `select id from ${SAMPLE} order by embedding <=> $1::halfvec limit ${K}`, [p.lit]);
  cosineMs.push(performance.now() - t0);
  truth.push(new Set(rows.map((r) => Number(r.id))));
}
console.log(`exact cosine top-${K} over the sample: median ${median(cosineMs).toFixed(1)} ms\n`);

console.log(`candidates M   oversample   cosine top-${K} recovered   median ms`);
for (const M of MS) {
  let recovered = 0;
  const ms = [];
  for (let i = 0; i < probes.length; i += 1) {
    const t0 = performance.now();
    const { rows } = await client.query(
      `select id from ${SAMPLE} order by bits <~> binary_quantize($1::halfvec)::bit(${tier.dims}) limit ${M}`,
      [probes[i].lit]);
    ms.push(performance.now() - t0);
    const got = new Set(rows.map((r) => Number(r.id)));
    for (const id of truth[i]) if (got.has(id)) recovered += 1;
  }
  console.log(
    `${String(M).padEnd(14)} ${String(M / K).padEnd(12)} ${(recovered / (probes.length * K)).toFixed(3).padStart(21)}   ${median(ms).toFixed(1).padStart(9)}`);
}

await client.end();
