// The metric definitions from DESIGN.md section 5, in one place.
//
// bench-recall.mjs reports these numbers and tests/recall-bench-recall.test.mjs
// pins them to hand-computed fixtures, so both sides have to be reading the
// same functions -- a second copy of "what Recall@10 means" is exactly the kind
// of drift that makes a headline number unreproducible.

import { makeRng } from './rng.mjs';

export function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Section 5's headline metric: the test split is single-target by construction,
// so this is 1 or 0 per query, never a fraction.
export function recallAtK(hits, target, k) {
  return hits.slice(0, k).includes(target) ? 1 : 0;
}

export function reciprocalRankAtK(hits, target, k) {
  const idx = hits.slice(0, k).indexOf(target);
  return idx === -1 ? 0 : 1 / (idx + 1);
}

// Section 5's multi-target variant, reported beside the headline and never
// folded into it: mean over queries of |top-k intersect targets| / |targets|.
export function macroRecallAtK(hits, targets, k) {
  if (targets.length === 0) return 0;
  const top = new Set(hits.slice(0, k));
  return targets.filter((t) => top.has(t)).length / targets.length;
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

// Percentile bootstrap over per-query scores (section 5: 10,000 resamples, 95%).
//
// The RNG is seeded rather than Math.random so a reported confidence interval
// can be reproduced from the repo alone -- section 4.4 treats the headline run
// as an auditable artifact, and a CI that moves between runs is not auditable.
export function bootstrapCI(values, opts = {}) {
  const { resamples = 10_000, level = 0.95, seed = 'recall-bench/bootstrap' } = opts;
  const n = values.length;
  const point = mean(values);
  if (n === 0) return { point: 0, lower: 0, upper: 0, resamples, level };

  const rng = makeRng(seed);
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[rng.int(0, n - 1)];
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);

  const alpha = 1 - level;
  const lower = means[Math.floor((alpha / 2) * resamples)];
  const upper = means[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)];
  return { point, lower, upper, resamples, level };
}
