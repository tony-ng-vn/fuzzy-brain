// Pins the synthetic vector geometry that DESIGN.md 7.2 found broken.
//
// Two invariants live here, and they failed in different ways.
//
// 1. THE LOADER AND THE QUERY BUILDER MUST AGREE ON JITTER. load.mjs carried
//    its own SYNTH_MEMORY_JITTER = 0.12 while synth-vectors' queryVector()
//    drifts off memoryVector(..., DEFAULT_MEMORY_JITTER = 0.10). So every
//    scale-tier query was drifted off a vector that is not the one in the
//    database. It reads as an innocuous cos 0.997 -- which is exactly the
//    number DESIGN.md 6.8 recorded and read as "the reconstruction is
//    faithful". It was not; it was this bug.
//
// 2. A SAME-CLUSTER SIBLING MUST OUT-RANK THE TOP-K NOISE FLOOR. This is the
//    pathology 7.2 diagnosed: at jitter 0.10 / 256 dims the perturbation norm
//    is 1.6 against a unit centroid, which scatters a cluster so widely that a
//    sibling (cos 0.185) sits BELOW the best-of-a-million noise row (cos
//    0.248). The corpus then has no cluster structure in vector space at all,
//    every ANN index has nothing to route toward, and the recall number
//    measures the generator rather than the retrieval system.
//
// The second half is parameterized by N on purpose. The noise floor grows with
// corpus size -- z(1 - k/N)/sqrt(dims) -- so an invariant verified only at
// test scale would let the pathology come back at 1M and 10M, which is
// precisely the rung the constants exist to serve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'experiments', 'recall-bench');
const synth = await import(pathToFileURL(join(benchRoot, 'lib', 'synth-vectors.mjs')));
const { encodeField } = await import(pathToFileURL(join(benchRoot, 'load.mjs')));
const { resolveTier } = await import(pathToFileURL(join(benchRoot, 'config.mjs')));

const {
  memoryVector, queryVector, cosineSimilarity,
  DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT,
} = synth;

const tier = resolveTier('rehearsal1m');

function parseLiteral(literal) {
  return Float32Array.from(JSON.parse(literal));
}

test('the loader stores exactly the vector queryVector drifts off', () => {
  for (const [id, clusterId] of [[1, 0], [1_000, 17], [999_999, 19_999]]) {
    const stored = parseLiteral(encodeField('embedding', { id, cluster_id: clusterId }, tier));
    const expected = memoryVector(id, clusterId, tier.dims, DEFAULT_MEMORY_JITTER);

    // Six significant digits is the literal's own precision, so exact equality
    // is not available; anything below 1 - 1e-5 is a different vector.
    assert.ok(
      cosineSimilarity(stored, expected) > 0.99999,
      `stored vector for id ${id} is not memoryVector(..., DEFAULT_MEMORY_JITTER)`,
    );
  }
});

// z-score of the (1 - k/N) quantile of a standard normal, by bisection on the
// erf-free tail. Only needs three digits: it feeds a floor estimate, not a gate.
function normalQuantile(p) {
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    // Phi(mid) via the complementary error function, Abramowitz-Stegun 7.1.26.
    const t = 1 / (1 + 0.3275911 * (mid / Math.SQRT2));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
      * Math.exp(-(mid / Math.SQRT2) * (mid / Math.SQRT2));
    const phi = 0.5 * (1 + y);
    if (phi < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// The expected cosine of the k-th best of N unrelated unit vectors against a
// fixed query: unrelated cosines are ~N(0, 1/dims), so the k/N upper tail sits
// at z(1 - k/N)/sqrt(dims).
function noiseFloor(n, k, dims) {
  return normalQuantile(1 - k / n) / Math.sqrt(dims);
}

// Closed forms for this generator, all against a unit centroid (see
// lib/synth-vectors.mjs's header for the derivation these mirror).
const cosQueryTarget = (drift, dims) => 1 / Math.sqrt(1 + drift * drift * dims);
const cosQuerySibling = (jitter, drift, dims) =>
  1 / ((1 + jitter * jitter * dims) * Math.sqrt(1 + drift * drift * dims));

for (const n of [1_000_000, 10_000_000]) {
  test(`a same-cluster sibling out-ranks the top-30 noise floor at N = ${n}`, () => {
    const floor = noiseFloor(n, 30, tier.dims);
    const sibling = cosQuerySibling(DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT, tier.dims);
    assert.ok(
      sibling > floor,
      `sibling-to-query cosine ${sibling.toFixed(3)} must exceed the rank-30 noise floor `
      + `${floor.toFixed(3)} at N = ${n}; below it the corpus has no cluster structure to route on`,
    );
  });
}

test('the target still ranks #1 under exact cosine, above its own siblings', () => {
  const target = cosQueryTarget(DEFAULT_QUERY_DRIFT, tier.dims);
  const sibling = cosQuerySibling(DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT, tier.dims);
  assert.ok(
    target > sibling,
    `query-to-target ${target.toFixed(3)} must beat query-to-sibling ${sibling.toFixed(3)}`,
  );
});

// The closed forms are what the calibration arithmetic is done on, so they are
// checked against the generator itself rather than trusted. Averaged over many
// query-target pairs, not one: a single cosine at 256 dims carries a standard
// deviation near 0.05, which is larger than the effect being pinned.
test('the closed forms above match the generator empirically', () => {
  const dims = tier.dims;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const targetCosines = [];
  const siblingCosines = [];

  for (let clusterId = 0; clusterId < 40; clusterId++) {
    const ids = Array.from({ length: 20 }, (_, i) => 5_000 + clusterId * 100 + i);
    const vectors = ids.map((id) => memoryVector(id, clusterId, dims, DEFAULT_MEMORY_JITTER));
    const q = queryVector(ids[0], clusterId, dims, DEFAULT_QUERY_DRIFT);
    targetCosines.push(cosineSimilarity(q, vectors[0]));
    for (const v of vectors.slice(1)) siblingCosines.push(cosineSimilarity(q, v));
  }

  const predictedTarget = cosQueryTarget(DEFAULT_QUERY_DRIFT, dims);
  const predictedSibling = cosQuerySibling(DEFAULT_MEMORY_JITTER, DEFAULT_QUERY_DRIFT, dims);
  assert.ok(Math.abs(mean(targetCosines) - predictedTarget) < 0.02,
    `query-to-target closed form ${predictedTarget.toFixed(3)} vs measured ${mean(targetCosines).toFixed(3)}`);
  assert.ok(Math.abs(mean(siblingCosines) - predictedSibling) < 0.02,
    `query-to-sibling closed form ${predictedSibling.toFixed(3)} vs measured ${mean(siblingCosines).toFixed(3)}`);
});
