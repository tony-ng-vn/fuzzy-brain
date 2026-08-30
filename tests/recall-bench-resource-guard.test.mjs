// Pins the machine guard against the run that made it necessary: a 10M
// open-loop bench (17.8 GB working set, 96 connections) on a 24 GB, 12-core
// laptop drove swap to 15.6 GB and load average to 72, and the desktop stopped
// responding. Every threshold here is measured, so a change to one should be
// a deliberate edit with a new measurement behind it.
import test from "node:test";
import assert from "node:assert/strict";
import { assessHeadroom, shouldAbort } from "../experiments/recall-bench/lib/resource-guard.mjs";

const LAPTOP = { totalRamGb: 24, cpus: 12, load1: 2, swapUsedGb: 0.2 };

test("the run that overwhelmed the machine is refused, for both of its reasons", () => {
  const problems = assessHeadroom({ workingSetGb: 17.8, connections: 96, machine: LAPTOP });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /working set 17\.8 GB exceeds 16\.8 GB/);
  assert.match(problems[1], /96 connections exceeds 48/);
});

test("the 1M tier, which this laptop does sustain at 1,200 QPS, is allowed", () => {
  assert.deepEqual(assessHeadroom({ workingSetGb: 2.1, connections: 32, machine: LAPTOP }), []);
});

test("a machine already swapping or already busy is left alone", () => {
  const swapping = assessHeadroom({
    workingSetGb: 2.1,
    connections: 32,
    machine: { ...LAPTOP, swapUsedGb: 4 },
  });
  assert.equal(swapping.length, 1);
  assert.match(swapping[0], /swap is already in use/);

  const busy = assessHeadroom({
    workingSetGb: 2.1,
    connections: 32,
    machine: { ...LAPTOP, load1: 14 },
  });
  assert.equal(busy.length, 1);
  assert.match(busy[0], /load average 14\.0 already exceeds 12 cores/);
});

// An unreadable swap figure must not become a silent veto on every run.
test("an unknown swap reading is not treated as pressure", () => {
  assert.deepEqual(
    assessHeadroom({ workingSetGb: 2.1, connections: 32, machine: { ...LAPTOP, swapUsedGb: null } }),
    [],
  );
});

test("a corpus whose size cannot be measured yet still checks the rest", () => {
  const problems = assessHeadroom({ workingSetGb: null, connections: 96, machine: LAPTOP });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /96 connections exceeds 48/);
});

test("the watchdog aborts on swap growth during a run, not on steady swap", () => {
  assert.equal(
    shouldAbort({ startSwapGb: 0.2, currentSwapGb: 3.5, totalRamGb: 24 }),
    true,
    "3.3 GB of growth is the run swapping the machine",
  );
  assert.equal(shouldAbort({ startSwapGb: 0.2, currentSwapGb: 1.1, totalRamGb: 24 }), false);
  assert.equal(
    shouldAbort({ startSwapGb: 11, currentSwapGb: 12.5, totalRamGb: 24 }),
    true,
    "past half of RAM in swap the machine is unusable however it got there",
  );
  assert.equal(shouldAbort({ startSwapGb: null, currentSwapGb: 3, totalRamGb: 24 }), false);
});
