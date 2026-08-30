// Pins the two pieces of fit-rerank.mjs's offline fitting math that would
// silently produce a wrong learned profile if they drifted: the lane-weight
// recombination (raw per-lane rank -> RRF -> topK cut -> the real rerank()),
// and the logistic-regression fit's sign recovery. No database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'experiments', 'recall-bench');
const { recombineAndRerank, pipelineRecallAt10, trainLogistic } = await import(pathToFileURL(join(benchRoot, 'fit-rerank.mjs')));
const { config } = await import(pathToFileURL(join(benchRoot, 'config.mjs')));

const RRF_K = { and: 60, or: 60, vector: 60, trigram: 60 };

// A pure-fusion rerank config: score = fused, nothing else. Ranking then
// depends only on the recombined RRF this test computes by hand, not on
// whatever config.mjs's committed rerank weights happen to be today.
const PURE_FUSION_CFG = {
  ...config,
  rerank: { ...config.rerank, weights: { fused: 1, lexical: 0, cosine: 0, entity: 0, recency: 0, dateFit: 0, rareHit: 0, titleHit: 0, dupPenalty: 0 } },
};

function candidate(id, laneRanks) {
  return {
    id,
    laneRanks,
    features: { cosine: 0.5, lexical: 1, rareHit: false, titleHit: false, dupGroup: null, occurredAt: '2024-03-12T00:00:00.000Z', people: [], tags: [] },
  };
}

const qf = { terms: [], entities: { people: [], places: [] }, dateRange: { from: null, to: null }, quoted: [] };

test('recombineAndRerank: RRF from raw per-lane ranks, not a cached score, decides the order', () => {
  // A ranks first in the AND lane, B ranks first in the VECTOR lane. Whether
  // A or B fuses higher depends only on the lane WEIGHTS passed in.
  const wideCands = [candidate('A', { and: 1 }), candidate('B', { vector: 1 })];

  // and=0.5, vector=2 -> A: 0.5/61 = 0.008197, B: 2/61 = 0.032787 -> B wins.
  const laneWFavoringB = { and: 0.5, or: 0, vector: 2, trigram: 0 };
  const rankedB = recombineAndRerank({ qf, wideCands }, laneWFavoringB, RRF_K, 2, PURE_FUSION_CFG);
  assert.deepEqual(rankedB.map((c) => c.id), ['B', 'A']);

  // and=3, vector=0.1 -> A: 3/61 = 0.04918, B: 0.1/61 = 0.00164 -> A wins.
  // Same two candidates, same lane ranks -- only the weight vector changed.
  const laneWFavoringA = { and: 3, or: 0, vector: 0.1, trigram: 0 };
  const rankedA = recombineAndRerank({ qf, wideCands }, laneWFavoringA, RRF_K, 2, PURE_FUSION_CFG);
  assert.deepEqual(rankedA.map((c) => c.id), ['A', 'B']);
});

test('recombineAndRerank: the topK cut drops a candidate that fused below it', () => {
  const wideCands = [candidate('A', { and: 1 }), candidate('B', { and: 2 }), candidate('C', { and: 3 })];
  const laneW = { and: 1, or: 0, vector: 0, trigram: 0 };
  const ranked = recombineAndRerank({ qf, wideCands }, laneW, RRF_K, 2, PURE_FUSION_CFG);
  assert.deepEqual(ranked.map((c) => c.id), ['A', 'B'], 'only the top 2 by RRF survive the cut');
});

test('pipelineRecallAt10: a lane-weight trial that demotes the target below topK scores it a miss', () => {
  const wideCands = [candidate('A', { and: 1 }), candidate('B', { and: 2 }), candidate('C', { and: 3 })];
  const records = [{ qf, targetId: 'C', wideCands }];
  const laneWDials = { base: { and: 1, or: 0, vector: 0, trigram: 0 } };
  const rerankWeights = { fused: 1, lexical: 0, cosine: 0, entity: 0, recency: 0, dateFit: 0, rareHit: 0, titleHit: 0, dupPenalty: 0 };
  // C fuses last of the three (and-rank 3 is the weakest RRF contribution),
  // and a topK of 2 cuts it -- this is the same mechanism the fitted lane
  // dials rely on to demote a wrong candidate out of the returned top-10.
  assert.equal(pipelineRecallAt10(records, laneWDials, rerankWeights, RRF_K, 2), 0);
  assert.equal(pipelineRecallAt10(records, laneWDials, rerankWeights, RRF_K, 3), 1, 'a wider topK keeps C in the candidate set');
});

test('trainLogistic recovers the sign of a separable synthetic feature', () => {
  const X = [[5], [4], [3], [-3], [-4], [-5]];
  const yPositive = [1, 1, 1, 0, 0, 0];
  const [wPositive] = trainLogistic(X, yPositive, { iters: 500 });
  assert.ok(wPositive > 0, `expected a positive coefficient, got ${wPositive}`);

  const yNegative = [0, 0, 0, 1, 1, 1];
  const [wNegative] = trainLogistic(X, yNegative, { iters: 500 });
  assert.ok(wNegative < 0, `expected a negative coefficient with the label flipped, got ${wNegative}`);
});
