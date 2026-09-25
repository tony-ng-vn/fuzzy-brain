import test from "node:test";
import assert from "node:assert/strict";
import { evidenceExcerpt } from "../scripts/lib/retrieval/excerpt.mjs";

test("source excerpts prefer a cluster of query words over one isolated mention", () => {
  const target = "Release automation helps me understand this change.";
  const text = "release " + "ordinary preamble ".repeat(1000) + target + " ordinary ending".repeat(100);
  const result = evidenceExcerpt(text, "understanding release automation");
  assert.ok(result.offset > 0);
  assert.ok(result.text.includes(target));
  assert.equal(result.text, text.slice(result.offset, result.offset + result.text.length));
  assert.equal(result.truncated, true);
});

test("short text and semantic-only matches preserve an exact source slice", () => {
  const short = "  Exact supplied words.\n\t";
  assert.deepEqual(evidenceExcerpt(short, "words"), { text: short, offset: 0, truncated: false });
  const long = "Unrelated words. ".repeat(100);
  for (const question of ["semantic paraphrase", "what is it"]) {
    assert.deepEqual(evidenceExcerpt(long, question), { text: long.slice(0, 700), offset: 0, truncated: true });
  }
});

test("excerpt boundaries do not split a Unicode surrogate pair", () => {
  const symbol = String.fromCodePoint(0x1f600);
  for (let shift = 0; shift < 8; shift++) {
    const text = "x".repeat(shift) + `${symbol} `.repeat(400) + "specific anchor" + `${symbol} `.repeat(400);
    const result = evidenceExcerpt(text, "specific anchor");
    assert.ok(result.text.includes("specific anchor"));
    assert.ok(result.text.length <= 700);
    assert.equal(result.text.isWellFormed(), true);
    assert.equal(result.text, text.slice(result.offset, result.offset + result.text.length));
  }
});

test("a long repeated cue does not displace the later cluster or exceed the excerpt limit", () => {
  const text = "release ".repeat(40000) + "release automation understanding";
  const result = evidenceExcerpt(text, "release automation understanding");
  assert.ok(result.text.endsWith("release automation understanding"));
  assert.ok(result.text.length <= 700);
  assert.ok(result.offset > 300000);
});
