// lib/synth-vectors.mjs -- deterministic cluster vectors for the 10M tier
// (DESIGN.md section 3.6). Pure math, no model, no I/O: this is what stands
// in for a real embedder at the synthetic-vector tiers (rehearsal1m,
// full10m), where 1.2's throughput numbers make running the real embedder
// over 10M bodies infeasible.
//
// Geometry: every cluster gets a random unit-vector centroid. A memory's
// vector is that centroid plus small gaussian jitter, renormalized -- same
// cluster reads as "topically close" under cosine, the way a real sentence
// embedding clusters near-duplicate content. A query vector is built by
// drifting off one specific target memory's own vector (not just the shared
// centroid), which is what makes `queryVector` take a `targetId`: it lets a
// generated query be reliably nearest-neighbour to the record it was written
// about, which a real embedding of a genuinely on-topic query would also be.
//
// gen-corpus.mjs's own certification (DESIGN.md 4.2 rule 2) also uses this
// module as a *documented proxy* for the vector lane at the real-vector
// tiers (smoke1k, quality50k), because the real embeddings for those tiers
// are computed later by load.mjs, after generation. See gen-corpus.mjs's
// header comment for the full reasoning and the honesty tradeoff that
// implies.

import { makeRng } from './rng.mjs';

// The jitter every regular memory vector is built with, and the drift a query
// is built with off its target. queryVector drifts off a target's vector
// computed at this SAME jitter -- if a caller built the target's own corpus
// entry with a different jitter, the "target" the query drifts from would not
// be the vector actually stored for that id. load.mjs imports both rather than
// keeping its own copy, because it did keep its own copy and that was the bug.
//
// RECALIBRATED 2026-08-25, from 0.10 / 0.15. The old pair was tuned on the one
// property "the target still ranks near 1 against its siblings", which it did
// satisfy -- and which is satisfiable by a corpus with no cluster structure at
// all, because a query drifted off a target ranks that target first whether or
// not anything else is nearby. DESIGN.md 7.2 measured what that missed: at
// jitter 0.10 the perturbation norm is 0.10 * sqrt(256) = 1.6 against a UNIT
// centroid, which scatters a cluster so widely that a same-cluster sibling sat
// at cosine 0.185 while the best of a million unrelated rows sat at 0.248. The
// corpus had no cluster structure in vector space; both IVFFlat and HNSW had
// nothing to route toward, and the recall number measured this file rather
// than the retrieval system.
//
// Derived, not guessed (scripts/calibrate-synth-geometry.mjs shows the
// arithmetic and checks it against real generator output). With a unit
// centroid, dims D, jitter j and drift d:
//
//   sibling <-> sibling, sibling <-> target : 1 / (1 + j^2 D)
//   query   <-> its own target             : 1 / sqrt(1 + d^2 D)
//   query   <-> a sibling                  : the product of the two
//   k-th best of N unrelated rows          : z(1 - k/N) / sqrt(D)
//
// Two conditions fix the pair, both read off the real 768-dim tier
// (scripts/geometry-probe.mjs against bench_q50k, 210 dev queries):
//
//   1. cos(neighbour, target) must EXCEED cos(query, target). Real measures
//      0.808 against 0.705, a ratio of 1.15. This is the navigability
//      property in 7.2's own words -- the target's nearest neighbours have to
//      be the rows the query's top-k already holds, so a greedy descent that
//      reaches any one of them reaches the target. Reversed, the target is an
//      isolated spike with no path to it, which is what 7.2 measured.
//   2. query-to-sibling must clear the top-30 noise floor AT 10M (0.283 at
//      256 dims), with margin, or the top-k is extreme-value noise rather
//      than a neighbourhood. Calibrating against the 1M floor (0.251) would
//      leave the corpus failing again at the tier it exists to serve.
//
// Solving both gives j <= 0.0399 and d <= 0.0796; the pair below is that
// bound rounded up one notch, deliberately -- it is the HARDEST geometry that
// still satisfies both conditions, and a benchmark should not be made easier
// than its constraints require. Verified at the shipped values rather than the
// solved ones: query-to-sibling measures 0.441 against the 0.283 floor, p5
// 0.351, and 498.8 of 499 siblings clear it at the 10M cluster size.
export const DEFAULT_MEMORY_JITTER = 0.04;
export const DEFAULT_QUERY_DRIFT = 0.08;

function unitVector(rng, dims) {
  const v = new Float32Array(dims);
  let normSq = 0;
  for (let i = 0; i < dims; i++) {
    const x = rng.gauss();
    v[i] = x;
    normSq += x * x;
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

function renormalize(v) {
  let normSq = 0;
  for (let i = 0; i < v.length; i++) normSq += v[i] * v[i];
  const norm = Math.sqrt(normSq) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

// jitter/drift off a base vector: gaussian perturbation scaled by `amount`,
// then renormalized back onto the unit sphere.
function perturb(base, rng, amount) {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = base[i] + amount * rng.gauss();
  return renormalize(out);
}

export function clusterCentroid(clusterId, dims) {
  const rng = makeRng(`synth-vectors/cluster:${clusterId}:dims:${dims}`);
  return unitVector(rng, dims);
}

export function memoryVector(id, clusterId, dims, jitter) {
  const centroid = clusterCentroid(clusterId, dims);
  const rng = makeRng(`synth-vectors/memory:${id}:cluster:${clusterId}:dims:${dims}`);
  return perturb(centroid, rng, jitter);
}

// `jitter` is a parameter rather than a hardcoded DEFAULT_MEMORY_JITTER so a
// calibration sweep can price a candidate (jitter, drift) pair without editing
// this file between every point. Callers should leave it at the default: the
// base has to be the vector the loader actually stored, and the loader stores
// memoryVector(..., DEFAULT_MEMORY_JITTER).
export function queryVector(targetId, clusterId, dims, drift, jitter = DEFAULT_MEMORY_JITTER) {
  // Drift off the target's own vector (not the bare centroid): a query
  // written about one specific memory should be closest to that memory,
  // not merely closer to it than to unrelated clusters.
  const base = memoryVector(targetId, clusterId, dims, jitter);
  const rng = makeRng(`synth-vectors/query:${targetId}:cluster:${clusterId}:dims:${dims}`);
  return perturb(base, rng, drift);
}

export function toHalfvecLiteral(v) {
  // pgvector's halfvec/vector text literal: '[v1,v2,...]'. Six significant
  // digits is well past halfvec's own fp16 precision, so nothing is lost.
  let out = '[';
  for (let i = 0; i < v.length; i++) {
    if (i > 0) out += ',';
    out += v[i].toPrecision(6);
  }
  return out + ']';
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}
