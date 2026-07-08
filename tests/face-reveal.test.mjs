// Node strips TypeScript types at import time, so the .ts module loads directly.
import test from "node:test";
import assert from "node:assert/strict";
import {
  REVEAL_SEED,
  seededShuffle,
  grade,
  sortNodesForReveal,
  litPointIndices,
} from "../lib/face-reveal.ts";

test("seeded shuffle is deterministic across calls", () => {
  const a = seededShuffle(200, 42);
  const b = seededShuffle(200, 42);
  assert.deepEqual(a, b);
});

test("seeded shuffle is a permutation of every index", () => {
  const order = seededShuffle(50, REVEAL_SEED);
  assert.equal(order.length, 50);
  assert.deepEqual([...order].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i));
});

test("different seeds give a different order", () => {
  assert.notDeepEqual(seededShuffle(200, 1), seededShuffle(200, 2));
});

test("color grade puts mid-grey near the middle and stays in range", () => {
  const mid = grade(128, 1, 1);
  assert.ok(mid > 0.49 && mid < 0.51);
});

test("color grade clamps above and below to [0, 1]", () => {
  assert.equal(grade(255, 3, 3), 1);
  assert.equal(grade(0, 3, 3), 0);
  for (let v = 0; v <= 255; v += 5) {
    const g = grade(v, 2.2, 1.1);
    assert.ok(g >= 0 && g <= 1, `grade(${v}) = ${g} is out of [0, 1]`);
  }
});

test("contrast pivots around mid-grey: brighter input grades brighter", () => {
  assert.ok(grade(200, 2.2, 1.1) > grade(100, 2.2, 1.1));
});

test("sort orders by created_at, then by id, without mutating input", () => {
  const input = [
    { id: "z", created_at: "2026-07-02" },
    { id: "a", created_at: "2026-07-01" },
    { id: "b", created_at: "2026-07-01" },
  ];
  const snapshot = JSON.stringify(input);
  const sorted = sortNodesForReveal(input);
  assert.deepEqual(
    sorted.map((n) => n.id),
    ["a", "b", "z"],
  );
  assert.equal(JSON.stringify(input), snapshot);
});

test("reveal count equals node count until points run out, then clamps", () => {
  const order = seededShuffle(10, REVEAL_SEED);
  assert.equal(litPointIndices(order, 4).length, 4);
  assert.equal(litPointIndices(order, 10).length, 10);
  assert.equal(litPointIndices(order, 25).length, 10);
});

test("node-to-point mapping stays stable when a newer node is appended", () => {
  const order = seededShuffle(20, REVEAL_SEED);
  const nodes = [
    { id: "n1", created_at: "2026-07-01" },
    { id: "n3", created_at: "2026-07-03" },
    { id: "n2", created_at: "2026-07-02" },
  ];

  const pointOf = (list) => {
    const sorted = sortNodesForReveal(list);
    const lit = litPointIndices(order, sorted.length);
    return new Map(sorted.map((n, i) => [n.id, lit[i]]));
  };

  const before = pointOf(nodes);
  const after = pointOf([...nodes, { id: "n4", created_at: "2026-07-04" }]);

  for (const id of ["n1", "n2", "n3"]) {
    assert.equal(after.get(id), before.get(id), `node ${id} changed its point`);
  }
});
