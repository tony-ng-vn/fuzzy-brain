// A tuning sweep that draws from queries-test.jsonl picks its settings on the
// split it will later be reported against, which is the one thing the whole
// dev/test separation exists to prevent. bench-load has always loaded both
// splits into one pool; --split is the filter that lets a sweep stay off the
// test half without changing what a no-flag run measures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitsToLoad } from '../experiments/recall-bench/bench-load.mjs';

test('no flag loads both splits, so every committed number still reproduces', () => {
  assert.deepEqual(splitsToLoad(undefined), ['dev', 'test']);
  assert.deepEqual(splitsToLoad('both'), ['dev', 'test']);
});

test('a named split loads only that split', () => {
  assert.deepEqual(splitsToLoad('dev'), ['dev']);
  assert.deepEqual(splitsToLoad('test'), ['test']);
});

// A typo that silently fell through to both splits would report a dev-only
// sweep that had quietly read the test split, which is the failure this whole
// flag exists to make impossible.
test('an unrecognized split is refused rather than falling back to both', () => {
  assert.throws(() => splitsToLoad('devel'), /must be one of dev, test, both/);
  assert.throws(() => splitsToLoad(''), /must be one of dev, test, both/);
});
