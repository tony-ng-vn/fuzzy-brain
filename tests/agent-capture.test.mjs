import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTbrainServer } from "../scripts/tbrain-mcp.mjs";
import { createFuzzyBrainServer } from "../scripts/fuzzy-brain-mcp.mjs";
import { validateTransfer } from "../scripts/lib/tbrain-transfer.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";

const SOURCE = "11111111-1111-4111-8111-111111111111";
async function connect(t, server) {
  const client = new Client({ name: "agent-capture-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(() => client.close());
  return client;
}
const parsed = response => JSON.parse(response.content[0].text);

test("an agent can prepare a minimal capture offline without inventing metadata", async t => {
  const client = await connect(t, createTbrainServer({}, { allowedSourceIds: [SOURCE] }));
  const raw = "  A half-formed thought.\nKeep the spacing.  ";
  const response = await client.callTool({ name: "prepare_capture", arguments: {
    source_key: "actual-conversation-id", revision: "1", platform: "agent-test",
    messages: [{ role: "user", text: raw }],
  } });
  assert.notEqual(response.isError, true);
  const prepared = parsed(response);
  assert.equal(prepared.saved, false);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.capture_enabled, false);
  assert.equal(prepared.storage_checked, false);
  const packet = validateTransfer(prepared.transfer);
  assert.equal(packet.source_id, SOURCE);
  assert.equal(packet.source_key, "actual-conversation-id");
  assert.equal(packet.source.conversation_id, null);
  assert.equal(packet.messages[0].text, raw);
  assert.equal(packet.messages[0].at, null);
  assert.equal(packet.messages[0].speaker, null);
  assert.equal(packet.messages[0].fidelity, "verbatim");
  assert.equal(packet.coverage.completeness, "partial");
  assert.equal(packet.reflection, null);
  assert.deepEqual(response.structuredContent, prepared);
});

test("preparation rejects ambiguous source selection and never grants authorization", async t => {
  const client = await connect(t, createTbrainServer({}, { allowedSourceIds: [SOURCE, "22222222-2222-4222-8222-222222222222"] }));
  const response = await client.callTool({ name: "prepare_capture", arguments: {
    source_key: "actual-conversation", revision: "1", platform: "test", messages: [{ role: "user", text: "supplied" }],
  } });
  assert.equal(response.isError, true);
  assert.match(parsed(response).error.message, /source/i);
});

test("offline validation returns actionable paths without returning rejected private values", async t => {
  const client = await connect(t, createTbrainServer({}));
  const packet = fixture();
  packet.messages[0].at = "PRIVATE_INVALID_TIMESTAMP";
  packet.coverage.completeness = "complete";
  packet.PRIVATE_UNKNOWN_KEY = "PRIVATE_VALUE";
  const response = await client.callTool({ name: "validate_transfer", arguments: { transfer: packet } });
  const result = parsed(response);
  assert.equal(result.saved, false);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.path === "messages.0.at"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const good = parsed(await client.callTool({ name: "validate_transfer", arguments: { transfer: fixture() } }));
  assert.equal(good.valid, true);
  assert.equal(good.saved, false);
  assert.equal(good.storage_checked, false);
});

test("capture preparation reports redactions and never echoes the removed values", async t => {
  const client = await connect(t, createTbrainServer({}, { allowedSourceIds: [SOURCE] }));
  const result = parsed(await client.callTool({ name: "prepare_capture", arguments: {
    source_key: "conversation", revision: "1", platform: "test", messages: [{ role: "user", text: "Synthetic SSN 123-45-6789" }],
  } }));
  assert.equal(result.saved, false);
  assert.ok(result.redactions.length);
  assert.doesNotMatch(JSON.stringify(result), /123-45-6789/);
});

test("both servers preserve text compatibility and expose structured read results", async t => {
  for (const server of [createTbrainServer({ recall: async () => ({ state: "missing", hits: [] }) }), createFuzzyBrainServer({ recall: async () => ({ state: "missing", hits: [] }) })]) {
    const client = await connect(t, server);
    const response = await client.callTool({ name: "recall", arguments: { question: "a clue" } });
    assert.deepEqual(response.structuredContent, parsed(response));
  }
});

test("invalid capture relationships are repairable requests rather than storage outages", async t => {
  const client = await connect(t, createTbrainServer({}, { allowedSourceIds: [SOURCE] }));
  const response = await client.callTool({ name: "prepare_capture", arguments: {
    source_key: "conversation", revision: "1", platform: "test", messages: [{ role: "user", text: "supplied" }],
    reflection: { author: "assistant", status: "provisional", text: "provisional", message_ordinals: [9] },
  } });
  assert.equal(response.isError, true);
  assert.equal(parsed(response).error.code, "invalid");
});
