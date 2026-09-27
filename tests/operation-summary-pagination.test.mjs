import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";

const exec = promisify(execFile);
async function fixture(t, operations, reports) {
  const directory = await mkdtemp(join(tmpdir(), "tbrain-summary-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = createOperationJournal({ directory });
  for (let i = 0; i < operations; i++) {
    const call = await journal.start({ operation: "recall", entry_point: "tbrain_mcp" });
    await journal.finish(call.id, { result: { state: "missing", hits: [] }, duration_ms: i + 1 });
  }
  for (let i = 0; i < reports; i++) await journal.report({ workflow_id: randomUUID(), stage: "retrieval", outcome: "failed", finding: "missing_expected_evidence" });
  return { directory, journal };
}

for (const [operations, reports] of [[5, 1], [1, 5], [0, 5]]) {
  test(`summary continuation counts ${operations} operations and ${reports} reports exactly once`, async t => {
    const { journal } = await fixture(t, operations, reports);
    let input = { limit: 2 }, calls = 0, operationCount = 0, reportCount = 0;
    do {
      const page = await journal.summary(input);
      operationCount += page.operations; reportCount += page.caller_reports;
      assert.equal(page.exhaustive, false, "a partial page never claims full-day coverage");
      assert.equal(page.has_more, Boolean(page.next));
      if (page.next) assert.equal(page.next.tool, "trace_summary");
      input = page.next?.arguments;
      assert.ok(++calls <= 3, "continuation must finish without restarting the shorter list");
    } while (input);
    assert.equal(calls, 3);
    assert.equal(operationCount, operations);
    assert.equal(reportCount, reports);
  });
}

test("summary rejects partial, malformed, and cross-day continuation positions", async t => {
  const { journal } = await fixture(t, 1, 0);
  const day = new Date().toISOString().slice(0, 10);
  for (const input of [
    { after_operation: null }, { after_report: null },
    { after_operation: "bad", after_report: null },
    { day, after_operation: `2000-01-01_${randomUUID()}`, after_report: null },
  ]) await assert.rejects(() => journal.summary(input), error => error.code === "invalid");
  const finished = await journal.summary({ after_operation: null, after_report: null });
  assert.equal(finished.operations, 0);
  assert.equal(finished.exhaustive, false);
  assert.equal(finished.next, null);
});

for (const script of ["tbrain-mcp.mjs", "fuzzy-brain-mcp.mjs", "tbrain.mjs"]) {
  test(`${script} follows summary continuation without a database`, async t => {
    const { directory } = await fixture(t, 1, 3);
    const env = { PATH: process.env.PATH, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE_DIR: directory, TBRAIN_TRACE: "0", DATABASE_URL: "postgresql://127.0.0.1:1/unavailable" };
    let request;
    if (script === "tbrain.mjs") {
      request = async input => {
        const args = ["scripts/tbrain.mjs", "trace-summary", "--limit", String(input.limit)];
        if (input.day) args.push("--day", input.day);
        if ("after_operation" in input) args.push("--after-operation", input.after_operation ?? "done", "--after-report", input.after_report ?? "done");
        return JSON.parse((await exec(process.execPath, args, { env })).stdout);
      };
    } else {
      const client = new Client({ name: "summary-page-test", version: "1" });
      t.after(() => client.close());
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [`scripts/${script}`], env, stderr: "pipe" }));
      request = async input => {
        const result = await client.callTool({ name: "trace_summary", arguments: input });
        assert.notEqual(result.isError, true);
        return JSON.parse(result.content[0].text);
      };
    }
    const first = await request({ limit: 2 });
    assert.equal(first.caller_reports, 2);
    assert.ok(first.next);
    const second = await request(first.next.arguments);
    assert.equal(second.operations, 0);
    assert.equal(second.caller_reports, 1);
    assert.equal(second.next, null);
    assert.equal(second.exhaustive, false);
  });
}
