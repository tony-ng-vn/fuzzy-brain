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

// The jitter every regular memory vector is built with. queryVector drifts
// off a target's vector computed at this SAME jitter -- if a caller built
// the target's own corpus entry with a different jitter, the "target" the
// query drifts from would not be the vector actually stored for that id.
// Tuned empirically (see gen-corpus.mjs's self-check output): at jitter 0.10
// / drift 0.15, 300 trials of a query against 500 same-cluster siblings
// never dropped the target past rank 2, at both dims=256 and dims=768.
export const DEFAULT_MEMORY_JITTER = 0.10;
export const DEFAULT_QUERY_DRIFT = 0.15;

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

export function queryVector(targetId, clusterId, dims, drift) {
  // Drift off the target's own vector (not the bare centroid): a query
  // written about one specific memory should be closest to that memory,
  // not merely closer to it than to unrelated clusters.
  const base = memoryVector(targetId, clusterId, dims, DEFAULT_MEMORY_JITTER);
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
