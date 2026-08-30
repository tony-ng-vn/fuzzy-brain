// Pins the metric definitions from DESIGN.md section 5: Recall@k, MRR@10, the
// macro-averaged multi-target variant, and the bootstrap CI shape.
//
// These assertions run against experiments/recall-bench/lib/stats.mjs itself --
// the same module bench-recall.mjs imports for its headline numbers -- so a
// change to what "Recall@10" means fails here rather than quietly moving the
// reported number. Fixture results in, exact metric values out. No DB needed.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const statsPath = join(repoRoot, "experiments", "recall-bench", "lib", "stats.mjs");
const { mean, recallAtK, reciprocalRankAtK, macroRecallAtK, bootstrapCI } =
  await import(pathToFileURL(statsPath));

const EPS = 1e-9;

// Five single-target queries with hand-placed target ranks: 1, 5, 10, "not found", 3.
const fixtureQueries = [
  { hits: ["T1", 2, 3, 4, 5, 6, 7, 8, 9, 10], target: "T1" },
  { hits: [1, 2, 3, 4, "T2", 6, 7, 8, 9, 10], target: "T2" },
  { hits: [1, 2, 3, 4, 5, 6, 7, 8, 9, "T3"], target: "T3" },
  { hits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], target: "not-present" },
  { hits: [1, 2, "T5", 4, 5, 6, 7, 8, 9, 10], target: "T5" },
];

test("recallAtK matches hand-computed values at k=1, k=5, k=10", () => {
  const r1 = mean(fixtureQueries.map((q) => recallAtK(q.hits, q.target, 1)));
  const r5 = mean(fixtureQueries.map((q) => recallAtK(q.hits, q.target, 5)));
  const r10 = mean(fixtureQueries.map((q) => recallAtK(q.hits, q.target, 10)));

  assert.ok(Math.abs(r1 - 0.2) < EPS, `Recall@1 expected 0.2, got ${r1}`); // only rank-1 hit counts
  assert.ok(Math.abs(r5 - 0.6) < EPS, `Recall@5 expected 0.6, got ${r5}`); // ranks 1,3,5 count
  assert.ok(Math.abs(r10 - 0.8) < EPS, `Recall@10 expected 0.8, got ${r10}`); // ranks 1,3,5,10 count
});

test("reciprocal rank / MRR@10 matches hand-computed values", () => {
  const rrValues = fixtureQueries.map((q) => reciprocalRankAtK(q.hits, q.target, 10));
  assert.deepEqual(rrValues, [1, 1 / 5, 1 / 10, 0, 1 / 3]);
  const mrr = mean(rrValues);
  const expected = (1 + 1 / 5 + 1 / 10 + 0 + 1 / 3) / 5;
  assert.ok(Math.abs(mrr - expected) < EPS, `MRR@10 expected ${expected}, got ${mrr}`);
});

test("macro-averaged multi-target recall never mixes into the single-target headline metric", () => {
  // 3 targets, 2 land in the top 10 -> 2/3, per section 5's multi-target definition.
  const hits = [10, 20, 30, 4, 5, 6, 7, 8, 9, 99];
  const targets = [20, 99, "missing"];
  const score = macroRecallAtK(hits, targets, 10);
  assert.ok(Math.abs(score - 2 / 3) < EPS, `expected 2/3, got ${score}`);

  // all targets present -> 1; none present -> 0
  assert.equal(macroRecallAtK([1, 2, 3], [1, 2, 3], 10), 1);
  assert.equal(macroRecallAtK([1, 2, 3], [4, 5, 6], 10), 0);
});

test("bootstrap CI brackets the empirical mean and collapses to a point when there is no variance", () => {
  const flat = bootstrapCI(Array(50).fill(1), { resamples: 500 });
  assert.ok(
    Math.abs(flat.lower - 1) < EPS && Math.abs(flat.upper - 1) < EPS,
    "constant input must yield a degenerate [1,1] CI",
  );

  const mixed = [...Array(80).fill(1), ...Array(20).fill(0)]; // p = 0.8, n = 100
  const empiricalMean = mean(mixed);
  const ci = bootstrapCI(mixed, { resamples: 2000 });
  assert.ok(Math.abs(ci.point - empiricalMean) < EPS, "point estimate must be the empirical mean");
  assert.ok(
    ci.lower <= empiricalMean && empiricalMean <= ci.upper,
    `CI [${ci.lower}, ${ci.upper}] must bracket the mean ${empiricalMean}`,
  );
  assert.ok(ci.lower < ci.upper, "a mixed sample must produce a non-degenerate interval");
  assert.ok(ci.lower >= 0 && ci.upper <= 1, "recall values are bounded in [0, 1]");
});

test("bootstrap CI narrows as the sample size grows, for the same underlying proportion", () => {
  const small = [...Array(16).fill(1), ...Array(4).fill(0)]; // n=20, p=0.8
  const large = [...Array(800).fill(1), ...Array(200).fill(0)]; // n=1000, p=0.8, matches section 5's n=1000 example
  const smallCi = bootstrapCI(small, { resamples: 2000 });
  const largeCi = bootstrapCI(large, { resamples: 2000 });

  assert.ok(
    smallCi.upper - smallCi.lower > largeCi.upper - largeCi.lower,
    "a 20-query CI must be wider than a 1000-query CI at the same p",
  );
});

test("bootstrapCI is seeded, so a reported interval reproduces exactly", () => {
  const values = [...Array(60).fill(1), ...Array(40).fill(0)];
  const a = bootstrapCI(values, { resamples: 1000 });
  const b = bootstrapCI(values, { resamples: 1000 });
  assert.deepEqual(a, b, "the same input must produce a byte-identical CI across calls");
});
