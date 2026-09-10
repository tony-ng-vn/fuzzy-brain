import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createTbrainServer, productionTbrainServices, tbrainRuntimeConfig } from "../scripts/tbrain-mcp.mjs";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const READ_TOOLS = ["read_archive", "read_receipt", "recall", "search_archive", "status"];

function transfer() {
  return {
    format: "tbrain.transfer.v1", source_id: SOURCE_ID, source_key: "conversation-1", revision: "1",
    source: { platform: "test", conversation_id: null, title: null, project: null },
    coverage: { kind: "model_assembled", completeness: "partial", from: null, until: null,
      limitations: ["Only the supplied passage is available."], omissions: [] },
    messages: [{ id: null, role: "user", speaker: null, text: "A possibility, not a commitment.", at: null, fidelity: "verbatim" }],
    reflection: null, relation: null,
  };
}

async function connected(t, overrides = {}, config = {}) {
  const services = {
    recall: async (question) => ({ question, hits: [] }),
    readReceipt: async (id) => ({ id }),
    readArchive: async (input) => input,
    searchArchive: async (input) => input,
    archiveStatus: async () => ({ archives: 0 }),
    archiveDay: async () => ({ receipt_id: RECEIPT_ID }),
    ...overrides,
  };
  const server = createTbrainServer(services, config);
  const client = new Client({ name: "tbrain-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  return client;
}

const parsed = result => JSON.parse(result.content[0].text);

test("Tbrain defaults to read-only tools with evidence instructions", async (t) => {
  const client = await connected(t);
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), READ_TOOLS);
  assert.match(client.getInstructions(), /unratified|provisional/);
  assert.match(client.getInstructions(), /date range/i);
  assert.match(client.getInstructions(), /reminder automations/i);
  const denied = await client.callTool({ name: "archive_day", arguments: { transfer: transfer() } });
  assert.equal(denied.isError, true);
});

test("Tbrain archive authorization comes from runtime source consent", async (t) => {
  const seen = [];
  const client = await connected(t, { archiveDay: async input => { seen.push(input); return { receipt_id: RECEIPT_ID }; } },
    { allowCapture: true, allowedSourceIds: [SOURCE_ID] });
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["archive_day", ...READ_TOOLS]);
  const result = await client.callTool({ name: "archive_day", arguments: { transfer: transfer() } });
  assert.equal(result.isError, undefined);
  assert.equal(parsed(result).receipt_id, RECEIPT_ID);
  assert.deepEqual(seen, [transfer()]);
  const other = { ...transfer(), source_id: RECEIPT_ID };
  const denied = await client.callTool({ name: "archive_day", arguments: { transfer: other } });
  assert.equal(parsed(denied).error.code, "unauthorized");
  assert.equal(seen.length, 1);
});

test("Tbrain rejects payload consent and invented complete model coverage", async (t) => {
  const client = await connected(t, { archiveDay: async () => assert.fail("invalid transfer reached service") },
    { allowCapture: true, allowedSourceIds: [SOURCE_ID] });
  for (const payload of [{ ...transfer(), authorized: true }, { ...transfer(), coverage: { ...transfer().coverage, completeness: "complete" } }]) {
    const result = await client.callTool({ name: "archive_day", arguments: { transfer: payload } });
    assert.equal(result.isError, true);
  }
});

test("Tbrain archive search preserves undated scope and bounds page sizes", async (t) => {
  const client = await connected(t);
  const search = parsed(await client.callTool({ name: "search_archive", arguments: { query: "possibility" } }));
  assert.equal(search.from, null);
  assert.equal(search.until, null);
  assert.equal(search.limit, 10);
  assert.equal(search.offset, 0);
  const page = parsed(await client.callTool({ name: "read_archive", arguments: { id: RECEIPT_ID, offset: 10, limit: 5 } }));
  assert.deepEqual(page, { id: RECEIPT_ID, offset: 10, limit: 5 });
  for (const args of [{ query: "x", limit: 21 }, { query: "x", offset: -1 }, { query: "x", from: "last week" }]) {
    assert.equal((await client.callTool({ name: "search_archive", arguments: args })).isError, true);
  }
});

test("Tbrain exposes safe failure classes without private messages or causes", async (t) => {
  for (const code of ["conflict", "excluded", "not_found", "unauthorized", "invalid", "unavailable", "23505"]) {
    const client = await connected(t, { readReceipt: async () => {
      const error = new Error("private postgresql://password@host /Users/private");
      error.code = code;
      throw error;
    } });
    const result = await client.callTool({ name: "read_receipt", arguments: { id: RECEIPT_ID } });
    assert.equal(result.isError, true);
    assert.equal(parsed(result).error.code, code === "23505" ? "unavailable" : code);
    assert.doesNotMatch(JSON.stringify(result), /private|postgresql|password|Users/);
  }
});

test("Tbrain runtime capture requires exact opt-in and valid source ids", () => {
  assert.deepEqual(tbrainRuntimeConfig({}), { allowCapture: false, allowedSourceIds: [] });
  assert.equal(tbrainRuntimeConfig({ TBRAIN_ALLOW_CAPTURE: "true" }).allowCapture, false);
  assert.deepEqual(tbrainRuntimeConfig({ TBRAIN_ALLOW_CAPTURE: "1", TBRAIN_ALLOWED_SOURCE_IDS: ` ${SOURCE_ID},${SOURCE_ID} ` }),
    { allowCapture: true, allowedSourceIds: [SOURCE_ID] });
  assert.throws(() => tbrainRuntimeConfig({ TBRAIN_ALLOWED_SOURCE_IDS: "private invalid source" }), /source configuration is invalid/i);
});

test("Tbrain stdio refuses unapproved source before touching a database", async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../scripts/tbrain-mcp.mjs", import.meta.url))],
    env: { PATH: process.env.PATH, TBRAIN_ALLOW_CAPTURE: "1", TBRAIN_ALLOWED_SOURCE_IDS: "", DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data; });
  const client = new Client({ name: "tbrain-stdio-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(t => t.name).sort(), ["archive_day", ...READ_TOOLS]);
  const result = await client.callTool({ name: "archive_day", arguments: { transfer: transfer() } });
  assert.equal(result.isError, true);
  assert.equal(parsed(result).error.code, "unauthorized");
  assert.equal(stderr, "");
});


test("Tbrain production capture uses the authorized CLI and preserves safe error classes", async () => {
  const calls = [];
  let response = { receipt_id: RECEIPT_ID };
  const run = async (...args) => { calls.push(args); return response; };
  const services = productionTbrainServices({ allowCapture: true, allowedSourceIds: [SOURCE_ID] }, { run });
  assert.deepEqual(await services.archiveDay(transfer()), { receipt_id: RECEIPT_ID });
  assert.match(calls[0][0], /scripts\/brain\.mjs$/);
  assert.deepEqual(calls[0].slice(1), [["import-transfer", "--authorize", "--json-errors"], transfer()]);
  response = { state: "failed", error: { code: "excluded", message: "private reason" } };
  await assert.rejects(services.archiveDay(transfer()), error => {
    assert.equal(error.code, "excluded");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  const disabled = productionTbrainServices({ allowCapture: false, allowedSourceIds: [SOURCE_ID] }, { run });
  await assert.rejects(disabled.archiveDay(transfer()), { code: "unauthorized" });
  assert.equal(calls.length, 2);
});
