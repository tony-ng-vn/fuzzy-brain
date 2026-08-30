// Node strips TypeScript types at import time, so the .ts module loads directly.
import test from "node:test";
import assert from "node:assert/strict";
import { validateNodeInput } from "../lib/validation.ts";

test("accepts a minimal valid node", () => {
  const res = validateNodeInput({ type: "story", title: "First job", raw: "the raw words" });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value.connections, []);
});

test("type is optional and defaults to empty", () => {
  const res = validateNodeInput({ title: "Untyped node", raw: "kept exactly" });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.type, "");
});

test("raw is required and blank raw is rejected", () => {
  const missing = validateNodeInput({ title: "No raw" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /raw/);
  const blank = validateNodeInput({ title: "Blank raw", raw: "   " });
  assert.equal(blank.ok, false);
});

test("raw is never trimmed or altered", () => {
  const res = validateNodeInput({ title: "x", raw: "  spaces and typos kepy  " });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.raw, "  spaces and typos kepy  ");
});

test("body defaults to raw when absent or blank", () => {
  const absent = validateNodeInput({ title: "x", raw: "the words" });
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal(absent.value.body, "the words");
  const blank = validateNodeInput({ title: "x", raw: "the words", body: "   " });
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.value.body, "the words");
  const given = validateNodeInput({ title: "x", raw: "the words", body: "a readable" });
  assert.equal(given.ok, true);
  if (given.ok) assert.equal(given.value.body, "a readable");
});

test("an explicit deadline in node text becomes append-only temporal metadata", () => {
  const res = validateNodeInput(
    {
      type: "startup",
      title: "Stripe Atlas offer",
      raw: "I can use this offer until Aug 5 2027.",
    },
    new Date("2026-08-06T12:00:00-07:00"),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.deadlineAt, "2027-08-06T06:59:59.999Z");
    assert.equal(res.value.deadlineOrigin, "derived");
  }
});

test("trims and accepts a node with connections", () => {
  const res = validateNodeInput({
    type: " lesson ",
    title: " Ship early ",
    raw: "r",
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

test("rejects missing title", () => {
  assert.equal(validateNodeInput({ type: "story", title: "  ", raw: "r" }).ok, false);
  assert.equal(validateNodeInput(null).ok, false);
});

test("rejects a connection with a blank why", () => {
  const res = validateNodeInput({
    type: "story",
    title: "x",
    raw: "r",
    connections: [{ targetId: "abc", why: "   " }],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /why/);
});

test("rejects a connection without a target", () => {
  const res = validateNodeInput({
    type: "story",
    title: "x",
    raw: "r",
    connections: [{ why: "because" }],
  });
  assert.equal(res.ok, false);
});
