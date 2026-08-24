// A measurement window is only worth reading if the wall clock agrees that it
// happened when it claims to have happened. This machine sleeps overnight, and a
// window that spans a sleep reports a plausible-looking QPS with a p50 in the
// hundreds of seconds -- see .out/rehearsal1m/knee-sweep.log, discarded for
// exactly this. assessWindow is the guard that makes such a window self-evidently
// invalid in the report instead of something a reader has to infer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessWindow } from '../experiments/recall-bench/bench-load.mjs';

const EXPECTED = 180; // warmup 60 + duration 120, the claim-B window

test('a window that ran to schedule is valid', () => {
  const w = assessWindow({ expectedSec: EXPECTED, wallSec: 181.4, perfSec: 181.4 });
  assert.equal(w.valid, true);
  assert.equal(w.overranBy < 0.05, true);
  assert.equal(w.reason, null);
});

test('a window that overran its schedule is invalid', () => {
  // The overnight knee runs: a 60s schedule that took ~19 minutes.
  const w = assessWindow({ expectedSec: 60, wallSec: 1140, perfSec: 1140 });
  assert.equal(w.valid, false);
  assert.match(w.reason, /overran/);
});

test('a stalled dispatch ticker names a suspend', () => {
  // Node's clock on Darwin keeps advancing across a machine sleep, so comparing
  // clocks cannot see one. A dispatch ticker scheduled every 10ms going quiet for
  // minutes can only mean the machine stopped running us. Measured 2026-08-24:
  // pmset logged a 659s "Maintenance Sleep" straight through a sweep.
  const w = assessWindow({ expectedSec: 60, wallSec: 720, perfSec: 720, maxStallSec: 659 });
  assert.equal(w.valid, false);
  assert.match(w.reason, /suspend/);
});

test('suspend is reported ahead of the overrun it causes', () => {
  // Both trip together whenever the machine sleeps; the sleep is the cause and is
  // the more useful thing to print.
  const w = assessWindow({ expectedSec: 60, wallSec: 720, perfSec: 720, maxStallSec: 659 });
  assert.match(w.reason, /suspend/);
  assert.doesNotMatch(w.reason, /overran/);
});

test('ordinary scheduler jitter is not a suspend', () => {
  // A busy event loop routinely runs a 10ms timer late; only a multi-second gap
  // means the machine stopped.
  const w = assessWindow({ expectedSec: 60, wallSec: 60.4, perfSec: 60.4, maxStallSec: 0.35 });
  assert.equal(w.valid, true);
  assert.equal(w.reason, null);
});

test('a modest overrun inside tolerance still counts as valid', () => {
  // Pool teardown and the last few in-flight completions land after the schedule
  // ends; that is normal and must not flag an otherwise clean window.
  const w = assessWindow({ expectedSec: 180, wallSec: 195, perfSec: 195 });
  assert.equal(w.valid, true);
});
