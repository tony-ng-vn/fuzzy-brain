import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { renderEpisode } from "../scripts/lib/session-parser.mjs";

async function run(script, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...args], { env: { ...process.env, ...env }, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "tbrain-cli-traces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journal: createOperationJournal({ directory }), env: { BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE_DIR: directory, DATABASE_URL: "postgresql://127.0.0.1:1/unavailable" } };
}

test("portable CLI traces offline help and invalid input without changing stdout", async t => {
  const { journal, env } = await setup(t);
  const help = await run("tbrain.mjs", ["--help"], env);
  assert.equal(help.code, 0);
  assert.equal(JSON.parse(help.stdout).state, "help");
  assert.equal(help.stderr, "");
  const invalid = await run("recall.mjs", ["PRIVATE QUERY", "--unsupported"], env);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  const traces = (await journal.list()).traces;
  assert.equal(traces.length, 2);
  const failed = traces.find(t => t.start.entry_point === "recall_cli");
  assert.equal(failed.finish.error_code, "invalid");
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE QUERY/);
});

test("command help is traced as help and never executes the requested write", async t => {
  const { journal, env } = await setup(t);
  for (const args of [["import", "/PRIVATE_MISSING_FILE", "--authorize", "--help"], ["report-outcome", "/PRIVATE_MISSING_FILE", "-h"], ["help", "evidence"]]) {
    const response = await run("tbrain.mjs", args, env);
    assert.equal(response.code, 0);
    assert.equal(JSON.parse(response.stdout).state, "help");
    assert.equal(response.stderr, "");
  }
  const { traces } = await journal.list();
  assert.equal(traces.length, 3);
  for (const trace of traces) {
    assert.equal(trace.start.operation, "help");
    assert.equal(trace.finish.outcome, "success");
  }
  assert.deepEqual((await journal.listReports()).reports, []);
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE_MISSING_FILE/);
});

test("controlled memory CLI records its input fingerprint and committed output identifiers", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const { journal, env } = await setup(t);
  const saved = await run("brain.mjs", ["add-node"], { ...env, DATABASE_URL: database.url }, {
    type: "note", raw: "PRIVATE SYNTHETIC MEMORY", title: "Synthetic", body: "PRIVATE SYNTHETIC MEMORY",
  });
  assert.equal(saved.code, 0, saved.stderr);
  const node = JSON.parse(saved.stdout);
  assert.ok(node.id);
  const [trace] = (await journal.list()).traces;
  assert.equal(trace.start.entry_point, "brain_cli");
  assert.equal(trace.start.operation, "add-node");
  assert.equal(trace.finish.output.references.id, node.id);
  assert.equal(trace.input.input.content_omitted, true);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE SYNTHETIC/);
});

test("trace diagnostics work through the portable CLI without a database", async t => {
  const { env } = await setup(t);
  const status = await run("tbrain.mjs", ["trace-status"], env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).state, "ready");
  const list = await run("tbrain.mjs", ["traces", "--limit", "1"], env);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).traces.length, 1);
});

test("portable trace listing filters linked calls and reports without opening the database", async t => {
  const { env, journal } = await setup(t);
  const workflow = randomUUID();
  const parent = await journal.start({ operation: "recall", workflow_id: workflow });
  const child = await journal.start({ operation: "search", workflow_id: workflow, parent_id: parent.id });
  await journal.finish(child.id, { duration_ms: 123.5, error: { code: "unavailable" } });
  await journal.start({ operation: "recall", workflow_id: randomUUID() });
  const report = await journal.report({ operation_id: child.id, workflow_id: workflow, stage: "retrieval", outcome: "succeeded", finding: "none" });
  const options = { ...env, TBRAIN_TRACE: "0" };
  const linked = await run("tbrain.mjs", ["traces", "--workflow-id", workflow, "--parent-id", parent.id], options);
  assert.equal(linked.code, 0, linked.stderr);
  assert.deepEqual(JSON.parse(linked.stdout).traces.map(item => item.id), [child.id]);
  const reports = await run("tbrain.mjs", ["traces", "--kind", "reports", "--operation-id", child.id], options);
  assert.equal(reports.code, 0, reports.stderr);
  assert.deepEqual(JSON.parse(reports.stdout).reports.map(item => item.id), [report.id]);
  const failed = await run("tbrain.mjs", ["traces", "--operation", "search", "--outcome", "error", "--min-duration-ms", "123.5"], options);
  assert.equal(failed.code, 0, failed.stderr);
  assert.deepEqual(JSON.parse(failed.stdout).traces.map(item => item.id), [child.id]);
  const incompatible = await run("tbrain.mjs", ["traces", "--kind", "reports", "--min-duration-ms", "0"], options);
  assert.equal(incompatible.code, 1);
  assert.equal(JSON.parse(incompatible.stderr).error.code, "invalid");
});

test("a partly failed session batch keeps committed identifiers and reports the rejected item", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const { journal, env } = await setup(t);
  const childEnv = { ...env, DATABASE_URL: database.url };
  const source = JSON.parse((await run("brain.mjs", ["add-source"], childEnv,
    { kind: "codex_session", label: "synthetic-batch-trace" })).stdout);
  const rendered = renderEpisode([{ speaker: "tony", text: "PRIVATE SYNTHETIC BATCH", ts: null }]);
  const packet = { source_id: source.id, source_locator: "PRIVATE SESSION", raw: rendered.raw,
    file_mtime_ms: 1, file_size: Buffer.byteLength(rendered.raw),
    evidence: rendered.spans.map(span => ({ quote: span.text, speaker: span.speaker, start_offset: span.start, end_offset: span.end })) };
  const batch = await run("brain.mjs", ["sync-session"], childEnv, [packet, { ...packet, source_locator: "PRIVATE INVALID", evidence: [{ quote: "wrong" }] }]);
  assert.equal(batch.code, 0, batch.stderr);
  const results = JSON.parse(batch.stdout);
  assert.equal(results[0].state, "committed");
  assert.equal(results[1].error, "invalid");
  const trace = (await journal.list()).traces.find(item => item.start.operation === "sync-session");
  assert.equal(trace.finish.outcome, "error");
  assert.equal(trace.finish.error_code, "invalid");
  assert.equal(trace.finish.output.failed_item_count, 1);
  assert.deepEqual(trace.finish.output.item_errors, { invalid: 1 });
  assert.equal(trace.finish.output.items[0].checkpoint_id, results[0].checkpoint_id);
  assert.equal(trace.finish.output.items[0].id, results[0].id);
  assert.equal(trace.finish.output.items[0].evidence_count, 1);
  assert.equal(trace.finish.output.items[0].state, "committed");
  assert.equal(trace.input.input.item_count, 2);
  assert.equal(trace.input.input.items[0].source_id, source.id);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE/);
  const rows = await database.client.query("select count(*)::int n from brain_dev.evidence");
  assert.equal(rows.rows[0].n, 1);
});
