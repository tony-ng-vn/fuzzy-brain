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
