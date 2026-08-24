// DESIGN.md 6.8's binding correction: a throughput number measured while the
// vector lane was handed the answer is not evidence for a retrieval claim, so
// every load run now reports whole-pipeline recall next to the rate. These pin
// the reduction that turns sampled probes into that number -- the part that can
// silently go wrong without any run failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRecall } from '../experiments/recall-bench/bench-load.mjs';

// One probe as the hot loop records it: the POST-rerank top 10, plus where each
// survivor sat in the fused order before the rerank re-sorted them.
function probe(family, target, topIds, fusedRanks = topIds.map((_, i) => i + 1)) {
  return { family, target, topIds, fusedRanks };
}

test('recall@1 and recall@10 read the post-rerank order', () => {
  const s = summarizeRecall([
    probe('rare_token', 7, [7, 1, 2]),          // rank 1
    probe('rare_token', 9, [1, 2, 3, 4, 9]),    // rank 5: in @10, not @1
    probe('rare_token', 5, [1, 2, 3]),          // absent
  ]);
  assert.equal(s.families.rare_token.n, 3);
  assert.equal(s.families.rare_token.recallAt1, 1 / 3);
  assert.equal(s.families.rare_token.recallAt10, 2 / 3);
});

test('a target sitting past position 10 does not count as recall@10', () => {
  const eleven = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99];
  const s = summarizeRecall([probe('paraphrase_nolex', 99, eleven)]);
  assert.equal(s.families.paraphrase_nolex.recallAt10, 0);
});

test('both aggregates are reported, and they differ when the mix is skewed', () => {
  // Ten easy probes and one hard one. The unweighted family mean is the number
  // DESIGN.md 6.8 reported (0.669 was the mean of seven families), so it has to
  // stay comparable; the mix-weighted one is what the pool actually produces.
  const probes = [];
  for (let i = 0; i < 10; i++) probes.push(probe('rare_token', 1, [1]));
  probes.push(probe('paraphrase_nolex', 1, [2]));

  const s = summarizeRecall(probes);
  assert.equal(s.probes, 11);
  assert.equal(s.unweighted.recallAt10, 0.5);              // (1.0 + 0.0) / 2
  assert.ok(Math.abs(s.mixWeighted.recallAt10 - 10 / 11) < 1e-9);
});

test('explicit mix shares override the observed family counts', () => {
  const probes = [
    probe('a', 1, [1]),                                     // recall 1.0
    probe('b', 1, [2]), probe('b', 1, [2]), probe('b', 1, [2]),  // recall 0.0
  ];
  // Observed counts would weight b at 3/4; declared shares weight it at 1/2.
  const s = summarizeRecall(probes, { a: 0.5, b: 0.5 });
  assert.equal(s.mixWeighted.recallAt10, 0.5);
});

test('topK pressure counts final survivors that came from deep in the fused set', () => {
  const s = summarizeRecall([
    probe('near_dup', 1, [1, 2, 3], [1, 2, 3]),
    probe('near_dup', 4, [4, 5], [40, 3]),
  ]);
  assert.equal(s.topKPressure.survivorsPastFusedRank25, 1);
  assert.equal(s.topKPressure.deepestSurvivingFusedRank, 40);
});

test('no probes at all reports nothing rather than a fabricated zero', () => {
  assert.equal(summarizeRecall([]), null);
});
