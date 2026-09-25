import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";
import { logCaptureFailure, runSessionCapture } from "../scripts/ingest-sessions.mjs";

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), "tbrain-capture-outcome-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "traces");
  const env = { ...process.env, HOME: home, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE_DIR: directory,
    FUZZY_BRAIN_INGEST_CONFIG: join(home, "config.json"), FUZZY_BRAIN_INGEST_LOCK: join(home, "capture.lock") };
  return { home, env, journal: createOperationJournal({ directory }) };
}

function run(env, args = []) {
  return new Promise(resolve => execFile(process.execPath,
    [fileURLToPath(new URL("../scripts/ingest-sessions.mjs", import.meta.url)), ...args],
    { env, encoding: "utf8", timeout: 20000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}

test("session capture reports a partial save and links its child commands without private errors", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const { home, env, journal } = await setup(t);
  env.DATABASE_URL = database.url;
  env.DATABASE_URL_DEV = database.url;
  const project = join(home, "archive", "claude-code", "allowed");
  const codex = join(home, "codex");
  await mkdir(project, { recursive: true });
  await mkdir(codex);
  for (const text of ["PRIVATE KEEP", "PRIVATE REJECT"]) {
    const id = randomUUID();
    await writeFile(join(project, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id,
      cwd: "/synthetic/allowed", message: { role: "user", content: text } }));
  }
  const id = randomUUID();
  await writeFile(join(codex, `rollout-synthetic-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd: "/synthetic/allowed" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE OTHER SOURCE" }] } },
  ].map(item => JSON.stringify(item)).join("\n"));
  await writeFile(env.FUZZY_BRAIN_INGEST_CONFIG, JSON.stringify({ allowlist: ["allowed"], settledHours: 0,
    sourceLabel: "synthetic-claude", codexSourceLabel: "synthetic-codex", archiveRoot: join(home, "archive"),
    liveProjectsDir: join(home, "unused"), codexSessionsDir: codex }));
  await database.client.query("alter table brain_dev.episodes add constraint reject_fixture check (raw not like '%PRIVATE REJECT%')");
  const result = await run(env);
  assert.equal(result.code, 1, result.stdout);
  assert.doesNotMatch(result.stderr, /PRIVATE/);
  const counts = await database.client.query("select count(*)::int n from brain_dev.evidence");
  assert.equal(counts.rows[0].n, 2, "valid sessions from both sources must still commit");
  const traces = (await journal.list()).traces;
  const parent = traces.find(item => item.start.operation === "session_capture");
  assert.ok(parent);
  assert.equal(parent.finish.outcome, "error");
  assert.deepEqual(parent.finish.output.failed_sources, ["claude"]);
  assert.equal(parent.finish.output.capture_sources.claude.failed, 1);
  assert.equal(parent.finish.output.capture_sources.codex.ingested, 1);
  const writes = traces.filter(item => item.start.operation === "sync-session");
  assert.equal(writes.length, 2);
  assert.ok(writes.every(item => item.start.parent_id === parent.id));
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE/);
});

test("capture help and invalid options return before loading capture configuration", async t => {
  const { env, journal } = await setup(t);
  const help = await run(env, ["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).state, "help");
  const invalid = await run(env, ["--PRIVATE-OPTION"]);
  assert.equal(invalid.code, 1);
  assert.doesNotMatch(invalid.stderr, /PRIVATE/);
  const traces = (await journal.list()).traces;
  assert.equal(traces.length, 2);
  assert.equal(traces.find(item => item.start.operation === "session_capture").finish.error_code, "invalid");
});

test("a failed source and a failed error logger cannot stop the other source", () => {
  const calls = [];
  const result = runSessionCapture({ settledHours: 24 }, {
    claude() { calls.push("claude"); throw new Error("PRIVATE failure"); },
    codex() { calls.push("codex"); return { failed: 0, ingested: 3, evidenceRows: 7 }; },
    onError() { throw new Error("PRIVATE logger failure"); },
  });
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed_sources, ["claude"]);
  assert.equal(result.capture_sources.codex.evidenceRows, 7);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("capture error logs contain a safe category and count without child output", t => {
  const lines = [];
  t.mock.method(console, "error", value => lines.push(value));
  logCaptureFailure("batch", { code: "PRIVATE CODE", message: "PRIVATE MESSAGE", stdout: "PRIVATE OUTPUT" }, 8);
  assert.deepEqual(JSON.parse(lines[0]), { event: "session_capture.failed", stage: "batch", error_code: "unavailable", count: 8 });
});

test("a failed child command cannot print its private stderr before the capture logger handles it", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const { env } = await setup(t);
  const source = `import { cli } from ${JSON.stringify(new URL("../scripts/lib/brain-cli.mjs", import.meta.url).href)};
    import { logCaptureFailure } from ${JSON.stringify(new URL("../scripts/ingest-sessions.mjs", import.meta.url).href)};
    try { cli("show", ["PRIVATE INVALID UUID"]); }
    catch (error) { logCaptureFailure("startup", error); process.exitCode = 1; }`;
  const result = await new Promise(resolve => execFile(process.execPath, ["--input-type=module", "--eval", source],
    { env: { ...env, DATABASE_URL: database.url }, encoding: "utf8", timeout: 20000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /PRIVATE/);
  assert.equal(JSON.parse(result.stderr).event, "session_capture.failed");
});
