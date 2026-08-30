// The binary vector lane replaces one CTE with two, and the two ways it can be
// wrong are both silent. If the candidate stage's ORDER BY is not the index
// expression character for character, the planner matches no index and
// sequential-scans 10M rows -- a slow correct answer, which a latency table
// reads as "binary quantization does not help". If the date filter drifts past
// the candidate stage onto the rerank, the lane returns whatever survives the
// window instead of a full candidate set inside it, which is the ANN mistake
// DESIGN.md 6.1 exists to prevent. Both are asserted here, without a database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { binaryVectorLaneCtes } from '../experiments/recall-bench/lib/binary-lane.mjs';
import { buildRetrievalSql } from '../experiments/recall-bench/engine.mjs';
import { config, resolveTier } from '../experiments/recall-bench/config.mjs';

const BASE = {
  schema: 'bench_x10m',
  vecParam: '$5',
  dims: 256,
  depth: 30,
  oversample: 20,
};

test('the candidate stage orders by the indexed expression verbatim', () => {
  const [cand] = binaryVectorLaneCtes(BASE);
  assert.match(
    cand,
    /order by binary_quantize\(m\.embedding\)::bit\(256\) <~> binary_quantize\(\$5::halfvec\)::bit\(256\)/,
  );
});

test('the candidate stage takes depth times oversample rows', () => {
  const [cand] = binaryVectorLaneCtes({ ...BASE, depth: 30, oversample: 20 });
  assert.match(cand, /limit 600\b/);
  const [wider] = binaryVectorLaneCtes({ ...BASE, depth: 30, oversample: 40 });
  assert.match(wider, /limit 1200\b/);
});

test('the rerank stage reorders those candidates by exact halfvec cosine, cut to depth', () => {
  const [, lane] = binaryVectorLaneCtes(BASE);
  assert.match(lane, /from vec_cand/);
  assert.match(lane, /order by embedding <=> \$5::halfvec/);
  assert.match(lane, /limit 30\b/);
  // Hamming distance must not reach the fused ranking: the whole point is that
  // fusion sees a cosine ordering, exactly as it did before.
  assert.equal(/<~>/.test(lane), false);
});

test('the date filter stays on the candidate stage, never on the rerank', () => {
  const span = '\n    and ($6::daterange is null or m.occurred_at <@ $6::daterange)';
  const [cand, lane] = binaryVectorLaneCtes({ ...BASE, spanClause: span });
  assert.match(cand, /occurred_at <@ \$6::daterange/);
  assert.equal(/occurred_at/.test(lane), false);
});

test('an oversample below 1 is refused rather than producing a lane with nothing to rerank', () => {
  assert.throws(() => binaryVectorLaneCtes({ ...BASE, oversample: 0 }), /oversample must be an integer/);
  assert.throws(() => binaryVectorLaneCtes({ ...BASE, oversample: 1.5 }), /oversample must be an integer/);
});

// bench-recall --ablation runs several profiles down one pool, so two profiles
// that emit different SQL under one prepared-statement name is a wrong-plan bug.
// This is the collision tests/recall-bench-statement-name.test.mjs already
// guards for long names, applied to the new profile flag.
test('tunedScaleBinary gets its own prepared-statement name', () => {
  const tier = resolveTier('full10m');
  const plain = buildRetrievalSql(tier, config.profiles.tunedScale, config);
  const binary = buildRetrievalSql(tier, config.profiles.tunedScaleBinary, config);
  assert.notEqual(plain.name, binary.name);
  assert.match(binary.name, /_bq$/);
  assert.equal(plain.paramCount, binary.paramCount);
});

test('tunedScale keeps the halfvec lane it has always had', () => {
  const tier = resolveTier('full10m');
  const { text } = buildRetrievalSql(tier, config.profiles.tunedScale, config);
  assert.equal(/binary_quantize/.test(text), false);
  assert.equal(/vec_cand/.test(text), false);
});

// A rare-token query skips the ANN search entirely when the conjunction already
// has the answer. That gate is a One-Time Filter over the scan, so it has to sit
// on the stage that does the scanning; on the rerank stage it would filter rows
// the scan had already paid for.
test('the vector-skip gate stays on the candidate stage', () => {
  const gate = '\n    and (select count(*) from and_lane) < 1';
  const [cand, lane] = binaryVectorLaneCtes({ ...BASE, vectorGate: gate });
  assert.match(cand, /and_lane\) < 1/);
  assert.equal(/and_lane/.test(lane), false);
});
