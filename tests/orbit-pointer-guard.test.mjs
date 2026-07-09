// Node strips TypeScript types at import time, so the .ts module loads directly.
import test from "node:test";
import assert from "node:assert/strict";
import { guardOrbitPointerPositions } from "../lib/orbit-pointer-guard.ts";

test("ignores values that are not a control with a pointer map", () => {
  assert.equal(guardOrbitPointerPositions(null), false);
  assert.equal(guardOrbitPointerPositions(42), false);
  assert.equal(guardOrbitPointerPositions({}), false);
  assert.equal(guardOrbitPointerPositions({ _pointerPositions: null }), false);
});

test("the crashing read now finds a zeroed position instead of undefined", () => {
  // Mirrors OrbitControls.onPointerUp: read _pointerPositions[pointerId] for a
  // pointer that was never tracked, then read .x -- this used to throw.
  const controls = { _pointerPositions: {} };
  assert.equal(guardOrbitPointerPositions(controls), true);
  const pos = controls._pointerPositions[42];
  assert.ok(pos, "expected a fallback position object");
  assert.equal(pos.x, 0);
  assert.equal(pos.y, 0);
});

test("a tracked pointer keeps its recorded position", () => {
  // Mirrors _trackPointer: read (auto-creates the entry), then set().
  const controls = { _pointerPositions: {} };
  guardOrbitPointerPositions(controls);
  controls._pointerPositions[7].set(120, 340);
  assert.equal(controls._pointerPositions[7].x, 120);
  assert.equal(controls._pointerPositions[7].y, 340);
});

test("delete still clears an entry (never leaves it undefined)", () => {
  const controls = { _pointerPositions: {} };
  guardOrbitPointerPositions(controls);
  controls._pointerPositions[1].set(1, 2);
  delete controls._pointerPositions[1];
  assert.equal(controls._pointerPositions[1].x, 0);
});

test("non-numeric properties are not shadowed by the fallback", () => {
  const controls = { _pointerPositions: {} };
  guardOrbitPointerPositions(controls);
  assert.equal(typeof controls._pointerPositions.hasOwnProperty, "function");
  assert.equal(controls._pointerPositions.somethingElse, undefined);
});

test("guarding is idempotent and does not re-wrap", () => {
  const controls = { _pointerPositions: {} };
  assert.equal(guardOrbitPointerPositions(controls), true);
  const wrapped = controls._pointerPositions;
  assert.equal(guardOrbitPointerPositions(controls), true);
  assert.equal(controls._pointerPositions, wrapped);
});
