import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const parse = result => JSON.parse(result.content[0].text);
for (const script of ["fuzzy-brain-mcp.mjs", "tbrain-mcp.mjs"]) {
  test(`${script} records and reads traces without database availability`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "tbrain-traced-stdio-"));
    const client = new Client({ name: "codex", version: "1.0.0" });
    t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))],
      env: { PATH: process.env.PATH, BRAIN_SCHEMA: "brain_dev", DATABASE_URL: "postgresql://127.0.0.1:1/unavailable", TBRAIN_TRACE_DIR: directory }, stderr: "pipe" }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["trace_status", "read_trace", "list_traces", "report_outcome", "trace_summary"]) assert.ok(names.includes(name), name);
    const statusReply = await client.callTool({ name: "trace_status", arguments: {} });
    const status = parse(statusReply);
    assert.equal(status.state, "ready");
    assert.equal(status.content, "metadata_only");
    assert.deepEqual(status.trace, statusReply._meta["tbrain/trace"]);
    const rejected = await client.callTool({ name: "recall", arguments: {} });
    assert.equal(rejected.isError, true);
    const id = rejected._meta["tbrain/trace"].id;
    assert.ok(rejected.content.some(block => block.text.includes(id)));
    const saved = parse(await client.callTool({ name: "read_trace", arguments: { id } }));
    assert.equal(saved.finish.error_code, "invalid");
    const reported = parse(await client.callTool({ name: "report_outcome", arguments: {
      operation_id: id, stage: "request", outcome: "failed", finding: "schema_rejection", workflow_id: randomUUID(),
    } }));
    assert.equal(reported.recorded, true);
    const report = parse(await client.callTool({ name: "read_trace", arguments: { id: reported.id, kind: "report" } }));
    assert.equal(report.attribution, "caller_reported");
    assert.equal(report.operation_id, id);
    const summary = parse(await client.callTool({ name: "trace_summary", arguments: {} }));
    assert.equal(summary.errors.invalid, 1);
    assert.equal(summary.findings.schema_rejection, 1);
    assert.equal(summary.incomplete, 0);
  });
}

test("a memory save links the server request to its controlled child command", async t => {
  const { createTbrainTestDatabase } = await import("./helpers/tbrain-database.mjs");
  const { createOperationJournal } = await import("../scripts/lib/operation-journal.mjs");
  const database = await createTbrainTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "tbrain-linked-traces-"));
  const client = new Client({ name: "codex", version: "1.0.0" });
  t.after(async () => { await client.close(); await database.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../scripts/fuzzy-brain-mcp.mjs", import.meta.url))],
    env: { PATH: process.env.PATH, BRAIN_SCHEMA: "brain_dev", DATABASE_URL: database.url, TBRAIN_TRACE_DIR: directory }, stderr: "pipe" }));
  const workflow = randomUUID(), request = randomUUID();
  const response = await client.callTool({ name: "remember", arguments: { raw: "remember PRIVATE SYNTHETIC TRACE MEMORY", request_id: request }, _meta: { "tbrain/workflow_id": workflow } });
  const saved = parse(response);
  assert.equal(saved.state, "committed");
  const journal = createOperationJournal({ directory });
  const traces = (await journal.list()).traces;
  const parent = traces.find(t => t.id === saved.trace.id);
  const child = traces.find(t => t.start.parent_id === parent.id);
  assert.ok(child);
  assert.equal(parent.start.workflow_id, workflow);
  assert.equal(child.start.workflow_id, workflow);
  assert.equal(child.start.entry_point, "brain_cli");
  assert.equal(child.start.operation, "add-node");
  assert.equal(child.finish.output.references.id, saved.id);
  assert.equal(child.input.input.references.request_id, request);
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE SYNTHETIC TRACE MEMORY/);
});
