// Solve for the synthetic generator's jitter and drift, then check the solve.
//
// No database, no corpus: this builds vectors in memory, so a candidate can be
// rejected in seconds instead of after a 1M regeneration and a 7-minute index
// build. DESIGN.md 7.2 recorded the pathology this exists to remove -- a
// cluster scattered so widely that a same-cluster sibling sits BELOW the
// noise floor, leaving every ANN index with nothing to route toward.
//
//   node scripts/calibrate-synth-geometry.mjs            # the derivation + the pinned constants
//   CANDIDATES=0.04:0.08,0.05:0.10 node scripts/calibrate-synth-geometry.mjs
//
// The sample is 100K rows at the SAME cluster size the 1M tier uses, so a
// cluster's internal geometry is measured exactly; the noise floor, which is
// the only quantity that depends on N, is carried analytically to 1M and 10M
// rather than being read off a sample that is 10x and 100x too small.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const synth = await import(`${BENCH}/lib/synth-vectors.mjs`);
const { memoryVector, queryVector, cosineSimilarity, DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT } = synth;

const tier = resolveTier('rehearsal1m');
const DIMS = tier.dims;
const TOPK = 30;
const SAMPLE = Number(process.env.SAMPLE ?? 100_000);
// 1M / 20,000 clusters = 50. The 10M tier keeps 20,000 clusters and so runs
// 500 per cluster, which is why this is overridable: a 10x larger cluster is
// 10x more chances for the WORST sibling to fall under the floor, and it is
// the worst one that decides whether a corner of the cluster is reachable.
const CLUSTER_SIZE = Number(process.env.CLUSTER_SIZE
  ?? Math.round(config.tiers.rehearsal1m.memories / resolveTier('rehearsal1m').clusters));
const SAMPLE_CLUSTERS = Math.floor(SAMPLE / CLUSTER_SIZE);
const N_PROBES = Number(process.env.PROBES ?? 60);

// ---------------------------------------------------------------------------
// The closed forms, and the arithmetic they support.
// ---------------------------------------------------------------------------
// A memory is renorm(centroid + jitter * g) with g ~ N(0, I) and the centroid a
// unit vector, so its perturbation has norm jitter * sqrt(dims) and it projects
// onto the centroid by 1 / sqrt(1 + jitter^2 * dims). Two siblings each carry
// that projection and independent noise, so their cosine is the product. A
// query is the same construction one level down, drifted off the target's own
// vector, so query-to-sibling is the product of the two projections.
const siblingCos = (j, dims = DIMS) => 1 / (1 + j * j * dims);              // sibling <-> sibling, and sibling <-> target
const targetCos = (d, dims = DIMS) => 1 / Math.sqrt(1 + d * d * dims);      // query   <-> its own target
const queryToSibling = (j, d, dims = DIMS) => targetCos(d, dims) * siblingCos(j, dims);

// Unrelated pairs are ~N(0, 1/dims), so the k-th best of N of them sits at the
// (1 - k/N) normal quantile over sqrt(dims). This is the number that grows with
// the corpus and the reason the calibration is done against 10M, not 1M.
function normalQuantile(p) {
  let lo = 0; let hi = 12;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const x = mid / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    if (0.5 * (1 + y) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const noiseFloor = (n, k = TOPK, dims = DIMS) => normalQuantile(1 - k / n) / Math.sqrt(dims);

const FLOOR_1M = noiseFloor(1_000_000);
const FLOOR_10M = noiseFloor(10_000_000);

console.log(`# calibrating lib/synth-vectors.mjs at ${DIMS} dims, cluster size ${CLUSTER_SIZE}\n`);
console.log('## the noise floor the structure has to clear');
console.log(`  top-${TOPK} floor of pure noise at  1M rows: ${FLOOR_1M.toFixed(3)}`);
console.log(`  top-${TOPK} floor of pure noise at 10M rows: ${FLOOR_10M.toFixed(3)}   <- the one that binds`);
console.log(`  (a corpus calibrated against the 1M floor fails again at 10M, so the solve targets 10M)\n`);

console.log('## what the shipped constants do');
const jOld = 0.10; const dOld = 0.15;
console.log(`  jitter ${jOld} -> perturbation norm ${(jOld * Math.sqrt(DIMS)).toFixed(2)} against a unit centroid`);
console.log(`  drift  ${dOld} -> perturbation norm ${(dOld * Math.sqrt(DIMS)).toFixed(2)}`);
console.log(`  query -> target   ${targetCos(dOld).toFixed(3)}`);
console.log(`  query -> sibling  ${queryToSibling(jOld, dOld).toFixed(3)}   vs the 10M floor ${FLOOR_10M.toFixed(3)} -- BELOW it`);
console.log(`  sibling -> target ${siblingCos(jOld).toFixed(3)}   vs query -> target ${targetCos(dOld).toFixed(3)}`);
console.log('  so the target\'s own nearest neighbours are noise rows, not its cluster: nothing to descend.\n');

// ---------------------------------------------------------------------------
// The solve.
// ---------------------------------------------------------------------------
// Two conditions, both read off the real-embedding measurement in DESIGN.md
// (scripts/geometry-probe.mjs against bench_q50k):
//
//   (1) NAVIGABILITY. cos(neighbour, target) must exceed cos(query, target).
//       Measured real: 0.808 against 0.705, a ratio of 1.15. This is the whole
//       property -- the target's nearest neighbours are the same rows the
//       query's top-k holds, so greedy descent that reaches any one of them
//       reaches the target. Reversed, the target is an isolated spike and
//       there is no path to it, which is exactly what 7.2 measured.
//
//   (2) The neighbourhood must sit clear of the noise floor AT 10M, with
//       margin, or the top-k is extreme-value noise wearing a top-k's clothing.
const RATIO = 1.15;      // condition (1), from the real tier
const MARGIN = 1.55;     // condition (2): query-to-sibling at least this many x the 10M floor

// From (1): sqrt(1 + d^2 D) = RATIO * (1 + j^2 D), so with a = j^2 D the
// query-to-sibling cosine collapses to 1 / (RATIO * (1 + a)^2). Invert it.
const aMax = Math.sqrt(1 / (RATIO * MARGIN * FLOOR_10M)) - 1;
const jSolved = Math.sqrt(aMax / DIMS);
const bSolved = (RATIO * (1 + aMax)) ** 2 - 1;
const dSolved = Math.sqrt(bSolved / DIMS);

console.log('## the solve');
console.log(`  condition (1) sibling-to-target / query-to-target = ${RATIO}  (real tier measures 0.808 / 0.705 = 1.15)`);
console.log(`  condition (2) query-to-sibling >= ${MARGIN} x the 10M floor = ${(MARGIN * FLOOR_10M).toFixed(3)}`);
console.log(`  => jitter^2 * dims <= ${aMax.toFixed(4)}  =>  jitter <= ${jSolved.toFixed(4)}`);
console.log(`  => drift^2 * dims  <= ${bSolved.toFixed(4)}  =>  drift  <= ${dSolved.toFixed(4)}`);
console.log(`  rounded to the pinned constants: jitter ${DEFAULT_MEMORY_JITTER}, drift ${DEFAULT_QUERY_DRIFT}\n`);

// ---------------------------------------------------------------------------
// Empirical check, on real generator output rather than the algebra.
// ---------------------------------------------------------------------------
const candidates = (process.env.CANDIDATES
  ? process.env.CANDIDATES.split(',').map((s) => s.split(':').map(Number))
  : [[DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT]]);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

console.log(`## empirical, ${SAMPLE.toLocaleString()} vectors in memory (${SAMPLE_CLUSTERS} clusters of ${CLUSTER_SIZE}), ${N_PROBES} probe queries`);
console.log('| jitter | drift | q->target | rank2 | rank10 | rank30 | q->sib | q->sib p5 | q->sib min | sib->sib | sib->tgt | same-cluster of top-30 | rank 1 | sibs over 10M floor |');
console.log('| ------ | ----- | --------- | ----- | ------ | ------ | ------ | --------- | ---------- | -------- | -------- | ---------------------- | ------ | ------------------- |');

for (const [j, d] of candidates) {
  // Build the sample once per candidate: cluster c holds ids [c*S, c*S + S).
  const vecs = new Array(SAMPLE);
  for (let cl = 0; cl < SAMPLE_CLUSTERS; cl++) {
    for (let k = 0; k < CLUSTER_SIZE; k++) {
      const id = cl * CLUSTER_SIZE + k;
      vecs[id] = memoryVector(id, cl, DIMS, j);
    }
  }

  const acc = { t: [], r2: [], r10: [], r30: [], sib: [], sibsib: [], sibtgt: [], frac: [], over: [] };
  let rank1 = 0;
  for (let p = 0; p < N_PROBES; p++) {
    const cl = Math.floor((p * SAMPLE_CLUSTERS) / N_PROBES);
    const targetId = cl * CLUSTER_SIZE;
    const q = queryVector(targetId, cl, DIMS, d, j);

    const scored = new Array(SAMPLE);
    for (let id = 0; id < SAMPLE; id++) scored[id] = [id, cosineSimilarity(q, vecs[id])];
    scored.sort((a, b) => b[1] - a[1]);

    if (scored[0][0] === targetId) rank1 += 1;
    acc.t.push(cosineSimilarity(q, vecs[targetId]));
    acc.r2.push(scored[1][1]);
    acc.r10.push(scored[9][1]);
    acc.r30.push(scored[29][1]);

    const top = scored.slice(0, TOPK).filter(([id]) => id !== targetId);
    acc.frac.push(top.filter(([id]) => Math.floor(id / CLUSTER_SIZE) === cl).length / top.length);

    // Sibling stats, and the transfer-to-10M check: how many of this cluster's
    // members clear the floor a 10M corpus would put under them.
    let over = 0;
    for (let k = 1; k < CLUSTER_SIZE; k++) {
      const sib = vecs[targetId + k];
      const cs = cosineSimilarity(q, sib);
      acc.sib.push(cs);
      acc.sibtgt.push(cosineSimilarity(vecs[targetId], sib));
      if (cs > FLOOR_10M) over += 1;
      if (k < 8) for (let m = k + 1; m < 8; m++) acc.sibsib.push(cosineSimilarity(sib, vecs[targetId + m]));
    }
    acc.over.push(over);
  }

  const f = (a) => mean(a).toFixed(3).padStart(6);
  // The gate is a worst case, not an average: a mean sibling cosine comfortably
  // over the floor with a left tail crossing it is a corpus where some corners
  // of some clusters are still unreachable, and that surfaces later as a
  // family-shaped recall hole that reads like a tuning problem.
  const sorted = acc.sib.slice().sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  console.log(`| ${String(j).padStart(6)} | ${String(d).padStart(5)} | ${f(acc.t).padStart(9)} | ${f(acc.r2)} `
    + `| ${f(acc.r10)} | ${f(acc.r30)} | ${f(acc.sib)} | ${p5.toFixed(3).padStart(9)} | ${sorted[0].toFixed(3).padStart(10)} `
    + `| ${f(acc.sibsib).padStart(8)} | ${f(acc.sibtgt).padStart(8)} `
    + `| ${(mean(acc.frac) * (TOPK - 1)).toFixed(1).padStart(22)} | ${(rank1 / N_PROBES).toFixed(3).padStart(6)} `
    + `| ${mean(acc.over).toFixed(1).padStart(6)} of ${CLUSTER_SIZE - 1}      |`);
}
