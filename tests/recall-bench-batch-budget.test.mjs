// The embedding sweep's batch size, and why it is counted in tokens.
//
// A model call costs tokens, not rows. `padding: true` pads every row in a
// batch up to the longest one, and ONNX sizes its activation arena to that
// product, so a fixed row count silently becomes a memory budget that depends
// entirely on how long the memories happen to be.
//
// The bench tuned 64 rows on tiers whose bodies are 340-400 characters, where
// that is about 6,400 tokens and fits. The real evidence store averages 4,217
// characters, so 64 rows there is roughly 61,000 tokens. Measured on the
// longtail1k tier (bodies around 3,828 characters) with the shipped two-thread
// setting:
//
//   batch    rows/s   peak RSS
//       1      5.02     1.59 GB
//       4      4.89     2.93 GB
//       8      4.76     4.85 GB
//      16      4.35     6.98 GB
//      64      0.23    14.5 GB
//
// Throughput is flat to within noise through 16 and then falls 20x, while
// memory climbs about 0.42 GB per row the whole way. The first attempt to load
// that tier under the old fixed batch embedded none of its 1,000 rows in 50
// minutes. These tests pin the replacement: a budget in tokens, so the batch
// size does not depend on the corpus.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenBatches, BATCH_TOKEN_BUDGET } from '../experiments/recall-bench/load.mjs';
import { EMBED_CHAR_CAP } from '../scripts/lib/embeddings.mjs';

const CHARS_PER_TOKEN = 4;
const bodies = (lens) => lens.map((n) => ({ body: 'x'.repeat(n) }));
const tokensOf = (chars) => Math.max(1, Math.ceil(Math.min(chars, EMBED_CHAR_CAP) / CHARS_PER_TOKEN));

// The cost a batch actually pays: every row is padded to the batch's longest.
const paddedTokens = (rows, idx) => Math.max(...idx.map((i) => tokensOf(rows[i].body.length))) * idx.length;

function assertBounded(rows, batches, budget = BATCH_TOKEN_BUDGET) {
  for (const idx of batches) {
    assert.ok(idx.length > 0, 'no empty batch is emitted');
    assert.ok(paddedTokens(rows, idx) <= budget, `batch of ${idx.length} costs ${paddedTokens(rows, idx)} padded tokens, over the ${budget} budget`);
  }
}

test('every row is embedded exactly once, in order, for any length mix', () => {
  const cases = [
    bodies(Array(64).fill(3828)),                                  // the long tail
    bodies(Array(64).fill(370)),                                   // the quality tier
    bodies(Array(64).fill(0).map((_, i) => 200 + ((i * 997) % 5800))), // mixed
    bodies([200_000, 3800, 3800, 200, 200]),                      // one huge paste
    bodies([]),                                                   // nothing to do
  ];
  for (const rows of cases) {
    const batches = tokenBatches(rows);
    const flat = batches.flat();
    assert.deepEqual(flat, rows.map((_, i) => i), 'batches cover every row once, in order');
    assertBounded(rows, batches);
  }
});

test('a batch never exceeds the row ceiling even when rows are tiny', () => {
  const rows = bodies(Array(500).fill(10));
  for (const idx of tokenBatches(rows, 64)) {
    assert.ok(idx.length <= 64, `row ceiling respected, got ${idx.length}`);
  }
});

test('an oversized row is batched by what it costs, not by its raw length', () => {
  // A 200k-character paste is truncated at EMBED_CHAR_CAP before tokenizing, so
  // it must cost the cap. Sizing batches on raw length would blow the budget.
  const rows = bodies([200_000]);
  const [idx] = tokenBatches(rows);
  assert.deepEqual(idx, [0]);
  assert.ok(tokensOf(200_000) <= BATCH_TOKEN_BUDGET, 'a single truncated row fits a batch of one');
});

test('long bodies are batched small enough to keep memory bounded', () => {
  // The regression that motivated the change: 64 rows of real-length text
  // measured 14.5 GB. A token budget has to prevent that shape, not just
  // rearrange it.
  const rows = bodies(Array(64).fill(3828));
  const batches = tokenBatches(rows);
  const widest = Math.max(...batches.map((b) => paddedTokens(rows, b)));
  assert.ok(widest <= BATCH_TOKEN_BUDGET, `widest padded batch is ${widest} tokens`);
  assert.ok(Math.max(...batches.map((b) => b.length)) <= 8,
    'a 3,828-character body fits at most 8 rows per call, nowhere near the 64 that cost 14.5 GB');
});

test('short bodies still batch, so the frozen tiers load about as before', () => {
  // The point of budgeting in tokens rather than dropping batching outright:
  // at the quality tier's ~93 tokens per body a call should still carry tens of
  // rows, close to the old fixed 64.
  const rows = bodies(Array(64).fill(370));
  const batches = tokenBatches(rows);
  assert.ok(batches.length <= 3, `64 short bodies take ${batches.length} calls, not 64`);
  assert.ok(Math.max(...batches.map((b) => b.length)) >= 20, 'short bodies still travel together');
  assertBounded(rows, batches);
});
