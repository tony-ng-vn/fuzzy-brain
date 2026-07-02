// Node strips TypeScript types at import time, so the .ts module loads directly.
import test from "node:test";
import assert from "node:assert/strict";
import { validateNodeInput } from "../lib/validation.ts";

test("accepts a minimal valid node", () => {
  const res = validateNodeInput({ type: "story", title: "First job", body: "" });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value.connections, []);
});

test("trims and accepts a node with connections", () => {
  const res = validateNodeInput({
    type: " lesson ",
    title: " Ship early ",
    body: "b",
    connections: [{ targetId: " abc ", why: " it follows " }],
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.type, "lesson");
    assert.equal(res.value.title, "Ship early");
    assert.deepEqual(res.value.connections, [{ targetId: "abc", why: "it follows" }]);
  }
});

test("rejects missing title or type", () => {
  assert.equal(validateNodeInput({ type: "story", title: "  " }).ok, false);
  assert.equal(validateNodeInput({ type: "", title: "x" }).ok, false);
  assert.equal(validateNodeInput(null).ok, false);
});

test("rejects a connection with a blank why", () => {
  const res = validateNodeInput({
    type: "story",
    title: "x",
    connections: [{ targetId: "abc", why: "   " }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /why/);
});

test("rejects a connection without a target", () => {
  const res = validateNodeInput({
    type: "story",
    title: "x",
    connections: [{ why: "because" }],
  });
  assert.equal(res.ok, false);
});
