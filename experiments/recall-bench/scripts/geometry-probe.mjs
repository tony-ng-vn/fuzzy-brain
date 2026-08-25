// What does a query's neighbourhood actually look like, in vector space?
//
// DESIGN.md 7.2 diagnosed the scale tier's dead vector lane as a geometry
// problem rather than an index problem: the synthetic generator scatters a
// cluster so widely that a same-cluster sibling sits BELOW the noise floor, so
// there is no neighbourhood for an ANN search to descend into. That diagnosis
// was made from a handful of numbers. This script is the instrument that
// produces them properly, and it runs against any tier, so the real-embedding
// arm and the synthetic arm are measured the same way and the columns of the
// resulting table can be set beside each other honestly.
//
// Read-only. It disables index scans for the exact top-k (a session GUC), and
// otherwise only SELECTs. Nothing here writes, indexes, or analyzes.
//
//   TIER=quality50k  node scripts/geometry-probe.mjs   # real 768-dim nomic
//   TIER=rehearsal1m node scripts/geometry-probe.mjs   # synthetic 256-dim
//
// Query vectors come from whatever the tier really uses: the frozen
// query-vectors.f32 cache (the real embedding of the query TEXT, verified
// against its own sha256 sidecar) for real tiers, and synth-vectors' drifted
// vector rebuilt from cluster_id for synthetic ones. Neither arm is ever
// handed the target's own stored embedding -- that is deviation 2, the error
// that made every earlier recall number an upper bound.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { queryVector, DEFAULT_QUERY_DRIFT, cosineSimilarity } = await import(`${BENCH}/lib/synth-vectors.mjs`);
const { queryTextsHash } = await import(`${BENCH}/load.mjs`);

const TIER_NAME = process.env.TIER ?? 'quality50k';
const SPLIT = process.env.SPLIT ?? 'dev';
const N_QUERIES = Number(process.env.N ?? 200);
const N_CLUSTERS = Number(process.env.NCLUSTERS ?? 40);
const MEMBERS_PER_CLUSTER = Number(process.env.MEMBERS ?? 20);
const TOPK = Number(process.env.TOPK ?? 30);

const tier = resolveTier(TIER_NAME);
const SCHEMA = tier.schema;
// halfvec at the synthetic tiers, vector at the real ones: the cast has to
// match the column or pgvector refuses the operator.
const CAST = tier.vector === 'synthetic' ? 'halfvec' : 'vector';

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const lit = (v) => `[${Array.from(v).join(',')}]`;

// ---------------------------------------------------------------------------
// Query vectors, from whatever source the tier genuinely uses.
// ---------------------------------------------------------------------------
async function loadQueries(client) {
  const outDir = `${BENCH}/.out/${TIER_NAME}`;
  const dev = readJsonl(`${outDir}/queries-dev.jsonl`);
  const test = readJsonl(`${outDir}/queries-test.jsonl`);
  const all = SPLIT === 'dev' ? dev : test;
  // The query files are written family by family, so slicing the head samples
  // one family. Stride instead, and keep each query's ORIGINAL index because
  // the query-vector cache is in file order.
  const stride = Math.max(1, Math.floor(all.length / N_QUERIES));
  const queries = [];
  for (let i = 0; i < all.length && queries.length < N_QUERIES; i += stride) {
    queries.push({ ...all[i], fileIndex: i });
  }

  if (tier.vector === 'real') {
    const buf = readFileSync(`${outDir}/query-vectors.f32`);
    const flat = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    // The cache is dev-then-test in file order, tier.dims floats each. Verify
    // it against its own sidecar so "the frozen dev-split query vectors" is a
    // checked claim rather than a filename.
    const sidecar = `${outDir}/query-vectors.f32.texts.sha256`;
    const want = readFileSync(sidecar, 'utf8').trim();
    const got = queryTextsHash([...dev, ...test]);
    if (want !== got) throw new Error(`query-vectors.f32 is stale: sidecar ${want} != texts ${got}`);
    const base = SPLIT === 'dev' ? 0 : dev.length * tier.dims;
    return queries.map((q) => ({
      qid: q.qid, family: q.family, target: Number(q.targets[0]),
      vec: flat.subarray(base + q.fileIndex * tier.dims, base + (q.fileIndex + 1) * tier.dims),
    }));
  }

  // Synthetic: rebuild the drifted vector from (targetId, cluster_id).
  const targets = queries.map((q) => Number(q.targets[0]));
  const { rows } = await client.query(
    `select id, cluster_id from ${SCHEMA}.memories where id = any($1::bigint[])`, [targets]);
  const clusterOf = new Map(rows.map((r) => [Number(r.id), r.cluster_id]));
  return queries.map((q) => {
    const target = Number(q.targets[0]);
    return {
      qid: q.qid, family: q.family, target,
      vec: queryVector(target, clusterOf.get(target), tier.dims, DEFAULT_QUERY_DRIFT),
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const c = benchClient();
await c.connect();

const queries = await loadQueries(c);
console.log(`# geometry probe -- tier ${TIER_NAME} (${tier.vector} ${tier.dims}-dim), schema ${SCHEMA}`);
console.log(`# ${queries.length} ${SPLIT}-split queries, exact top-${TOPK} by cosine with index scans disabled\n`);

// Exact top-k, index disabled, so the ladder measured is the corpus's and not
// any index's approximation of it.
await c.query('set enable_indexscan = off');
await c.query('set enable_bitmapscan = off');

// Every exact top-k here is a full scan of the tier, so at 10M each one reads
// ~10 GB and computes 10M distances. infra/postgresql.bench.conf pins
// max_parallel_workers_per_gather to 0 for the load-test tiers, which is right
// for a latency measurement and wrong for this: parallelism changes how long a
// cosine takes, never what it comes out at. Set per session, exactly as
// load.mjs --verify-oracle does for the same reason.
await c.query('SET max_parallel_workers_per_gather = 6');
await c.query('SET max_parallel_workers = 8');
await c.query('SET min_parallel_table_scan_size = 0');
await c.query('SET parallel_setup_cost = 0');
await c.query('SET parallel_tuple_cost = 0');

const stats = {
  target: [], rank2: [], rank10: [], rank30: [],
  targetRank1: 0, sameClusterFrac: [], targetInTopK: 0,
};
// Per family too: the mix is 23% paraphrase and 22% rare_token, and a
// mix-blind average hides a family whose queries land nowhere near their
// target's neighbourhood.
const byFamily = new Map();

// Is the exact top-k a coherent NEIGHBOURHOOD, or k independent lucky draws?
// This is the property an ANN search actually needs and the one the
// same-cluster label turns out not to capture. If the top-k rows are mutually
// similar they form a mode with a gradient leading into it; if they are
// mutually orthogonal they are just the extreme tail of a noise distribution,
// and there is nothing to descend.
const topKMutual = [];
const topKToTarget = [];

for (const q of queries) {
  const { rows } = await c.query(
    `select m.id, m.cluster_id, 1 - (m.embedding <=> $1::${CAST}) as cos, m.embedding::text as e
       from ${SCHEMA}.memories m
      order by m.embedding <=> $1::${CAST}
      limit ${TOPK}`, [lit(q.vec)]);
  const cos = rows.map((r) => Number(r.cos));
  const ids = rows.map((r) => Number(r.id));

  const targetRow = rows.find((r) => Number(r.id) === q.target);
  // The target's own cosine, whether or not it made the top-k: without it the
  // "query to its target" column silently becomes "query to its target, on the
  // easy queries only".
  if (targetRow) {
    stats.target.push(Number(targetRow.cos));
    stats.targetInTopK += 1;
  } else {
    const { rows: [t] } = await c.query(
      `select 1 - (embedding <=> $1::${CAST}) as cos from ${SCHEMA}.memories where id = $2`,
      [lit(q.vec), q.target]);
    if (t) stats.target.push(Number(t.cos));
  }
  if (ids[0] === q.target) stats.targetRank1 += 1;

  if (cos[1] !== undefined) stats.rank2.push(cos[1]);
  if (cos[9] !== undefined) stats.rank10.push(cos[9]);
  if (cos[29] !== undefined) stats.rank30.push(cos[29]);

  // THE crucial statistic: in a real embedding space a query's top-30 is
  // dominated by topically related documents, and that neighbourhood is the
  // gradient every ANN method descends. Measured excluding the target itself,
  // so it reports the neighbourhood rather than the planted spike.
  const targetCluster = rows.find((r) => Number(r.id) === q.target)?.cluster_id
    ?? (await c.query(`select cluster_id from ${SCHEMA}.memories where id = $1`, [q.target])).rows[0]?.cluster_id;
  const others = rows.filter((r) => Number(r.id) !== q.target);
  const frac = others.filter((r) => r.cluster_id === targetCluster).length / others.length;
  stats.sameClusterFrac.push(frac);

  // Mutual similarity inside the top-k, and the top-k's similarity to the
  // target -- computed on a bounded prefix, since this is O(k^2) per query.
  const near = rows.slice(0, 12).map((r) => Float32Array.from(JSON.parse(r.e)));
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) topKMutual.push(cosineSimilarity(near[i], near[j]));
  }
  const targetVec = targetRow
    ? Float32Array.from(JSON.parse(targetRow.e))
    : Float32Array.from(JSON.parse((await c.query(
      `select embedding::text as e from ${SCHEMA}.memories where id = $1`, [q.target])).rows[0].e));
  for (const r of rows) {
    if (Number(r.id) === q.target) continue;
    topKToTarget.push(cosineSimilarity(targetVec, Float32Array.from(JSON.parse(r.e))));
  }

  if (!byFamily.has(q.family)) byFamily.set(q.family, { target: [], floor: [], frac: [], rank1: 0, n: 0 });
  const f = byFamily.get(q.family);
  f.n += 1;
  if (ids[0] === q.target) f.rank1 += 1;
  if (targetRow) f.target.push(Number(targetRow.cos));
  if (cos[29] !== undefined) f.floor.push(cos[29]);
  f.frac.push(frac);
}

// Sibling geometry: pulled as vectors so sibling-to-sibling can be computed
// pairwise in JS. A bounded sample per cluster keeps the transfer small.
const sampleQueries = queries.slice(0, N_CLUSTERS);
const sibToQuery = [];
const sibToSib = [];
for (const q of sampleQueries) {
  const { rows: [{ cluster_id: cid }] } = await c.query(
    `select cluster_id from ${SCHEMA}.memories where id = $1`, [q.target]);
  // Ordered, not a bare LIMIT: an unordered limit returns the heap's physical
  // prefix, and dup-group members share both a cluster_id and consecutive ids,
  // so the prefix is mostly one near-duplicate group and sibling-to-sibling
  // reads far too high. md5 of the id is a deterministic shuffle.
  const { rows } = await c.query(
    `select id, embedding::text as e from ${SCHEMA}.memories
      where cluster_id = $1 and id <> $2
      order by md5(id::text) limit ${MEMBERS_PER_CLUSTER}`, [cid, q.target]);
  const vecs = rows.map((r) => Float32Array.from(JSON.parse(r.e)));
  for (const v of vecs) sibToQuery.push(cosineSimilarity(q.vec, v));
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) sibToSib.push(cosineSimilarity(vecs[i], vecs[j]));
  }
}

// A cross-cluster control, so "unrelated" has a measured value rather than an
// assumed zero. Real embedders are anisotropic and unrelated pairs do not sit
// at 0; the synthetic generator's do.
const crossCluster = [];
{
  const ids = queries.map((q) => q.target);
  const { rows } = await c.query(
    `select id, cluster_id, embedding::text as e from ${SCHEMA}.memories where id = any($1::bigint[])`, [ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), { cid: r.cluster_id, v: Float32Array.from(JSON.parse(r.e)) }]));
  const myCluster = new Map(queries.map((q) => [q.target, byId.get(q.target)?.cid]));
  for (const q of sampleQueries) {
    for (const other of queries) {
      if (other.target === q.target) continue;
      const row = byId.get(other.target);
      if (!row || row.cid === myCluster.get(q.target)) continue;
      crossCluster.push(cosineSimilarity(q.vec, row.v));
    }
  }
}

// A memory-to-memory control, which is the one that says whether cluster_id
// labels anything. "Query to a different cluster" is NOT comparable to
// "sibling to sibling": a query is ~10 words and a body is ~370 characters,
// and an embedder puts short and long text in different regions, so the two
// numbers differ by text length before they differ by topic.
const crossMemory = [];
{
  const { rows } = await c.query(
    `select id, cluster_id, embedding::text as e from ${SCHEMA}.memories
      order by md5(id::text) limit 300`);
  const parsed = rows.map((r) => ({ cid: r.cluster_id, v: Float32Array.from(JSON.parse(r.e)) }));
  for (let i = 0; i < parsed.length; i++) {
    for (let k = i + 1; k < parsed.length; k++) {
      if (parsed[i].cid === parsed[k].cid) continue;
      crossMemory.push(cosineSimilarity(parsed[i].v, parsed[k].v));
    }
  }
}

const row = (label, arr) => `| ${label.padEnd(38)} | ${mean(arr).toFixed(3).padStart(6)} | ${median(arr).toFixed(3).padStart(6)} | ${String(arr.length).padStart(6)} |`;
console.log('| measurement                            |   mean | median |      n |');
console.log('| -------------------------------------- | ------ | ------ | ------ |');
console.log(row('query to its own target', stats.target));
console.log(row(`query to rank 2 of exact top-${TOPK}`, stats.rank2));
console.log(row(`query to rank 10 of exact top-${TOPK}`, stats.rank10));
console.log(row(`query to rank 30 of exact top-${TOPK}`, stats.rank30));
console.log(row('query to a same-cluster sibling', sibToQuery));
console.log(row('sibling to sibling (same cluster)', sibToSib));
console.log(row('query to a different cluster', crossCluster));
console.log(row('memory to memory, different cluster', crossMemory));
console.log(row(`same-cluster share of exact top-${TOPK}`, stats.sameClusterFrac));
console.log(row(`mutual cosine inside the exact top-${TOPK}`, topKMutual));
console.log(row(`exact top-${TOPK} member to the target`, topKToTarget));

// The offset-invariant summary. Absolute cosines are not comparable between a
// real embedder (anisotropic: unrelated pairs sit well above zero) and this
// generator (isotropic by construction), but where the sibling sits on the
// ladder from the top-k floor to the target IS comparable, and it is what
// decides whether an ANN search has a gradient to follow.
const t = mean(stats.target);
const f = mean(stats.rank30);
const s = mean(sibToQuery);
console.log(`\nsibling ladder position  (sib - floor30) / (target - floor30) = ${((s - f) / (t - f)).toFixed(3)}`);
// The navigability number. A top-k whose members are as similar to each other
// as the query is to them is a mode; one whose members are mutually unrelated
// is the tail of a noise distribution wearing a top-k's clothing.
console.log(`top-${TOPK} coherence   mutual cosine / query-to-floor30           = ${(mean(topKMutual) / f).toFixed(3)}`);
console.log(`top-${TOPK} lift over background  (floor30 - cross) / (1 - cross)   = ${((f - mean(crossCluster)) / (1 - mean(crossCluster))).toFixed(3)}`);
console.log(`target rank 1 under exact cosine                              = ${(stats.targetRank1 / queries.length).toFixed(3)}`);
console.log(`target inside exact top-${TOPK}                                    = ${(stats.targetInTopK / queries.length).toFixed(3)}`);
console.log(`same-cluster rows in the exact top-${TOPK} (of ${TOPK - 1} non-target)     = ${(mean(stats.sameClusterFrac) * (TOPK - 1)).toFixed(1)}`);

console.log('\n| family            |  n | q->target | floor30 | same-cluster of top-30 | rank 1 |');
console.log('| ----------------- | -- | --------- | ------- | ---------------------- | ------ |');
for (const [family, f] of [...byFamily].sort()) {
  console.log(`| ${family.padEnd(17)} | ${String(f.n).padStart(2)} | ${mean(f.target).toFixed(3).padStart(9)} `
    + `| ${mean(f.floor).toFixed(3).padStart(7)} | ${(mean(f.frac) * (TOPK - 1)).toFixed(1).padStart(22)} `
    + `| ${(f.rank1 / f.n).toFixed(3).padStart(6)} |`);
}

await c.end();
