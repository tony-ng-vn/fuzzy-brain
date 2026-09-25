import test from "node:test";
import assert from "node:assert/strict";
import { inputMetadata, outputMetadata } from "../scripts/lib/operation-metadata.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
test("capture traces retain the request structure needed to diagnose coverage and identity mistakes", () => {
  const result = inputMetadata({ transfer: { source_id: ID, source_key: "PRIVATE CONVERSATION", revision: "PRIVATE REVISION",
    coverage: { kind: "model_assembled", completeness: "complete" },
    relation: { receipt_id: ID, kind: "supplements", note: "PRIVATE NOTE" },
    messages: [{ role: "user", text: "PRIVATE WORDS", at: null }, { role: "assistant", text: "PRIVATE SUMMARY", at: "2026-09-25T00:00:00Z" }],
  } });
  assert.deepEqual(result.capture.coverage, { kind: "model_assembled", completeness: "complete" });
  assert.deepEqual(result.capture.message_roles, { user: 1, assistant: 1 });
  assert.equal(result.capture.known_message_dates, 1);
  assert.equal(result.capture.relation.receipt_id, ID);
  assert.match(result.capture.source_key_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.capture.revision_sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("batch outputs keep bounded record identifiers without source content", () => {
  const result = outputMetadata(Array.from({ length: 150 }, () => ({ id: ID, quote: "PRIVATE WORDS" })));
  assert.equal(result.item_count, 150);
  assert.equal(result.items.length, 100);
  assert.equal(result.items_truncated, true);
  assert.equal(result.items[0].id, ID);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("the shared list allowance leaves space for every retained item's primary identifiers", () => {
  const primary = Object.fromEntries(["id", "source_id", "episode_id", "receipt_id", "checkpoint_id", "request_id", "evidence_id", "node_id"].map(key => [key, ID]));
  const item = { ...primary, evidence_ids: Array(100).fill(ID), node_ids: Array(100).fill(ID), raw: "PRIVATE WORDS" };
  const items = Array.from({ length: 100 }, () => ({ ...item }));
  const variants = [inputMetadata(items), outputMetadata(items), outputMetadata({ ...item, evidence: { ...item, source: item }, hits: items.map(hit => ({ ...hit, provenance: item })) })];
  const countListIds = value => {
    if (!value || typeof value !== "object") return 0;
    return Object.entries(value).reduce((total, [key, child]) => total
      + (["evidence_ids", "node_ids"].includes(key) ? child.length : countListIds(child)), 0);
  };
  for (const result of variants) {
    assert.ok(countListIds(result) <= 1000);
    assert.equal(result.references_truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100 * 1024, "leave room for the surrounding journal event");
    const last = (result.items ?? result.hits).at(-1);
    for (const key of Object.keys(primary)) assert.equal(last[key], ID);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal(inputMetadata(item).references.evidence_ids.length, 100);
});

test("background traces retain failed stage names without child errors", () => {
  const result = outputMetadata({ ok: false, failures: [
    { stage: "ingest", message: "PRIVATE source text" },
    { stage: "embedding", message: "PRIVATE credentials" },
    { stage: "PRIVATE name", message: "PRIVATE data" },
  ] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed_stages, ["ingest", "embedding"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("batch failure counts cover items beyond the bounded identifier list", () => {
  const input = Array.from({ length: 150 }, () => ({ id: ID, raw: "PRIVATE WORDS" }));
  input[149] = { error: "PRIVATE ERROR", source_locator: "PRIVATE LOCATION" };
  const output = outputMetadata(input);
  assert.equal(output.items.length, 100);
  assert.equal(output.failed_item_count, 1);
  assert.deepEqual(output.item_errors, { unavailable: 1 });
  const metadata = inputMetadata(input);
  assert.equal(metadata.item_count, 150);
  assert.equal(metadata.items.length, 100);
  assert.equal(metadata.items_truncated, true);
  assert.doesNotMatch(JSON.stringify({ output, metadata }), /PRIVATE/);
});

test("capture traces retain only known sources and nonnegative integer counts", () => {
  const output = outputMetadata({ capture_sources: {
    claude: { failed: 2, evidenceRows: 4, scanned: -1, ingested: "PRIVATE WORDS", unknown: 12 },
    codex: { failed: 0 }, "PRIVATE SOURCE": { failed: 5 },
  }, failed_sources: ["claude", "claude", "PRIVATE SOURCE"] });
  assert.deepEqual(output.capture_sources, { claude: { failed: 2, evidenceRows: 4 }, codex: { failed: 0 } });
  assert.deepEqual(output.failed_sources, ["claude"]);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE/);
});

test("recall traces preserve match strength without accepting arbitrary labels", () => {
  const result = outputMetadata({ hits: [
    { id: ID, match_strength: "strong" }, { id: ID, match_strength: "partial" }, { id: ID, match_strength: "PRIVATE LABEL" },
  ] });
  assert.deepEqual(result.hits.map(hit => hit.match_strength), ["strong", "partial", undefined]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("recall traces retain excerpt positions without copying source text", () => {
  const result = outputMetadata({ hits: [
    { id: ID, quote: "PRIVATE WORDS", quote_offset: 20001, quote_length: 27000, quote_truncated: true },
    { id: ID, quote_offset: 0, quote_length: 12, quote_truncated: false },
    { id: ID, quote_offset: -1, quote_length: Number.MAX_SAFE_INTEGER + 1, quote_truncated: "PRIVATE LABEL" },
  ] });
  assert.equal(result.hits[0].quote_offset, 20001);
  assert.equal(result.hits[0].quote_length, 27000);
  assert.equal(result.hits[0].quote_truncated, true);
  assert.equal(result.hits[1].quote_offset, 0);
  assert.equal(result.hits[1].quote_length, 12);
  assert.equal(result.hits[1].quote_truncated, false);
  for (const key of ["quote_offset", "quote_length", "quote_truncated"]) assert.equal(result.hits[2][key], undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
