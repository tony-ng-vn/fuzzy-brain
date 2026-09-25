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
