import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFuzzyBrainServer } from "../scripts/fuzzy-brain-mcp.mjs";
import { createTbrainServer } from "../scripts/tbrain-mcp.mjs";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";
import { traceTransport } from "../scripts/lib/operation-transport.mjs";

const parse = result => JSON.parse(result.content[0].text);
async function connect(t, kind, overrides = {}, providedJournal) {
  const directory = await mkdtemp(join(tmpdir(), "tbrain-transport-traces-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const journal = providedJournal ?? createOperationJournal({ directory });
  const services = { recall: async () => ({ hits: [], degraded: false }), archiveStatus: async () => ({ storage: "ready" }), ...overrides };
  const server = kind === "tbrain" ? createTbrainServer(services) : createFuzzyBrainServer(services, { logError() {} });
  const client = new Client({ name: "codex", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(traceTransport(right, { journal, entryPoint: `${kind}_mcp`, release: "0.31.0" })), client.connect(left)]);
  t.after(() => client.close());
  return { client, journal, directory };
}

for (const kind of ["tbrain", "fuzzy_brain"]) {
  test(`${kind} traces successful calls, schema rejections, and unknown tools at the protocol boundary`, async t => {
    let calls = 0;
    const { client, journal } = await connect(t, kind, { recall: async () => { calls++; return { hits: [], degraded: false }; } });
    for (const args of [{ question: "PRIVATE QUERY" }, {}, { question: 123 }]) {
      const result = await client.callTool({ name: "recall", arguments: args });
      const trace = result._meta?.["tbrain/trace"];
      assert.equal(trace.recorded, true);
      const saved = await journal.read(trace.id);
      assert.equal(saved.start.operation, "recall");
      assert.equal(saved.start.caller.name, "codex");
      assert.equal(saved.finish.outcome, typeof args.question === "string" ? "success" : "error");
      if (result.isError) assert.equal(saved.finish.error_code, "invalid");
      assert.doesNotMatch(JSON.stringify(saved), /PRIVATE QUERY/);
    }
    assert.equal(calls, 1);
    const unknown = await client.callTool({ name: "PRIVATE UNKNOWN TOOL", arguments: {} });
    assert.equal(unknown.isError, true);
    const saved = await journal.read(unknown._meta["tbrain/trace"].id);
    assert.equal(saved.start.operation, "unknown");
    assert.equal(saved.finish.outcome, "error");
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE UNKNOWN TOOL/);
  });
}

test("trace storage failure cannot replace a successful memory result", async t => {
  const journal = { async start() { throw new Error("PRIVATE disk failure"); }, status() { return { state: "degraded" }; } };
  const { client } = await connect(t, "fuzzy_brain", { recall: async () => ({ hits: [], saved: true }) }, journal);
  const result = await client.callTool({ name: "recall", arguments: { question: "synthetic" } });
  assert.equal(parse(result).saved, true);
  assert.notEqual(result.isError, true);
  assert.equal(result._meta["tbrain/trace"].recorded, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("overlapping calls retain the result belonging to each request", async t => {
  const { client, journal } = await connect(t, "tbrain", {
    recall: async question => { await new Promise(resolve => setTimeout(resolve, question === "first" ? 30 : 1)); return { hits: [], total: question === "first" ? 1 : 2 }; },
  });
  const results = await Promise.all(["first", "second"].map(question => client.callTool({ name: "recall", arguments: { question } })));
  const traces = await Promise.all(results.map(result => journal.read(result._meta["tbrain/trace"].id)));
  assert.notEqual(traces[0].id, traces[1].id);
  assert.deepEqual(traces.map(t => t.finish.output.total), [1, 2]);
});

test("service errors keep their category without logging their private message", async t => {
  const { client, journal, directory } = await connect(t, "tbrain", { recall: async () => { throw Object.assign(new Error("PRIVATE service detail"), { code: "excluded" }); } });
  const result = await client.callTool({ name: "recall", arguments: { question: "PRIVATE QUERY" } });
  const trace = await journal.read(result._meta["tbrain/trace"].id);
  assert.equal(trace.finish.error_code, "excluded");
  for (const day of await readdir(directory)) for (const file of await readdir(join(directory, day))) {
    assert.doesNotMatch(await readFile(join(directory, day, file), "utf8"), /PRIVATE/);
  }
});

test("a failed reply delivery keeps the successful operation and preserves shutdown cleanup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tbrain-delivery-traces-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const journal = createOperationJournal({ directory });
  let cleanup = 0;
  const inner = { async start() {}, async send() { throw new Error("PRIVATE transport failure"); },
    async close() { this.onclose(); }, onclose() { cleanup++; } };
  const wrapped = traceTransport(inner, { journal, entryPoint: "tbrain_mcp", release: "0.31.0" });
  wrapped.onmessage = () => {};
  await wrapped.start();
  await inner.onmessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "archive_day", arguments: {} } });
  await assert.rejects(() => wrapped.send({ jsonrpc: "2.0", id: 7, result: { structuredContent: { state: "committed" }, content: [] } }), /PRIVATE transport failure/);
  const [trace] = (await journal.list()).traces;
  assert.equal(trace.finish.outcome, "success");
  assert.equal(trace.delivery.state, "failed");
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/);
  await wrapped.close();
  assert.equal(cleanup, 1);
});

test("a trace completion failure does not replace the service result", async t => {
  const journal = { async start() { return { id: "test", recorded: true }; }, async finish() { throw new Error("PRIVATE disk failure"); } };
  const { client } = await connect(t, "tbrain", { recall: async () => ({ state: "committed" }) }, journal);
  const result = await client.callTool({ name: "recall", arguments: { question: "synthetic" } });
  assert.equal(parse(result).state, "committed");
  assert.equal(result._meta["tbrain/trace"].recorded, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("a stuck journal cannot hold a successful tool reply indefinitely", async t => {
  const journal = { start: () => new Promise(() => {}) };
  const { client } = await connect(t, "tbrain", { recall: async () => ({ hits: [] }) }, journal);
  const started = performance.now();
  const response = await client.callTool({ name: "recall", arguments: { question: "synthetic" } });
  assert.notEqual(response.isError, true);
  assert.equal(response._meta["tbrain/trace"].recorded, false);
  assert.ok(performance.now() - started < 2500);
});
