// Unit tests for the ingest trigger's logic (lib/ingest.ts), which the
// frontend button's API route calls. Matches the repo's own pattern: the
// route stays a thin, untested pass-through (see app/api/nodes/route.ts);
// the real logic gets tested directly.
//
// runIngest is async (it shells out via non-blocking execFile, never
// execFileSync -- a synchronous call would freeze the whole Next.js
// process for up to the 10 minute timeout on every click) and serializes
// itself with a module-scope lock, so a second call while one is running
// comes back immediately as a structured "already running" result instead
// of racing the same database inserts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIngest } from "../lib/ingest.ts";

test("runIngest runs the ingest script against the current node binary and returns its stdout", async () => {
  const fakeExec = async (cmd, args) => {
    assert.equal(cmd, process.execPath);
    assert.ok(args[0].endsWith("ingest-sessions.mjs"), `expected the ingest script, got ${args[0]}`);
    return { stdout: "ingest-sessions summary (claude-code)\n  ingested         3 (12 evidence rows)\n" };
  };
  const result = await runIngest(fakeExec);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.output, /ingested\s+3/);
});

test("runIngest surfaces a subprocess failure as a structured error, never throws", async () => {
  const fakeExec = async () => {
    const err = new Error("no ingest config at ~/.fuzzy-brain/ingest.json; create it with at least an allowlist");
    throw err;
  };
  await assert.doesNotReject(() => runIngest(fakeExec));
  const result = await runIngest(fakeExec);
  assert.equal(result.ok, false);
});

test("runIngest translates a timeout into a safe message that says data so far is kept", async () => {
  const fakeExec = async () => {
    const err = new Error("Command timed out");
    err.code = "ETIMEDOUT";
    throw err;
  };
  const result = await runIngest(fakeExec);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /timed out/i);
    assert.match(result.error, /saved|kept/i);
  }
});

test("runIngest never forwards raw stderr -- no file paths, db details, or session content leak to the caller", async () => {
  const fakeExec = async () => {
    const err = new Error(
      "Command failed: node /Users/tony/Desktop/fuzzy-brain/scripts/ingest-sessions.mjs\n" +
        'error: duplicate key value violates unique constraint "episodes_source_locator_idx"\n' +
        "DETAIL:  Key (source_id, source_locator)=(abc-123, session-xyz-secret) already exists.\n" +
        "    at Connection.parseE (pg/lib/connection.js:120:11)",
    );
    err.stderr = err.message;
    throw err;
  };
  const result = await runIngest(fakeExec);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.error, /\/Users\//);
    assert.doesNotMatch(result.error, /session-xyz-secret/);
    assert.doesNotMatch(result.error, /pg\/lib/);
    assert.doesNotMatch(result.error, /DETAIL/);
  }
});

test("runIngest refuses a second call while one is already in flight", async () => {
  let releaseFirst;
  const slowExec = () => new Promise((resolve) => { releaseFirst = resolve; });
  const first = runIngest(slowExec);

  const second = await runIngest(async () => ({ stdout: "should never run" }));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.alreadyRunning, true);

  releaseFirst({ stdout: "first run done" });
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
});

test("runIngest releases its lock after finishing, so the next call runs normally", async () => {
  await runIngest(async () => ({ stdout: "done" }));
  const result = await runIngest(async () => ({ stdout: "done again" }));
  assert.equal(result.ok, true);
});

test("runIngest spawns and captures a real subprocess end to end via the default exec path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fuzzy-ingest-fixture-"));
  const scriptPath = join(dir, "fixture.mjs");
  writeFileSync(scriptPath, "console.log('fixture ran ok');");
  try {
    const result = await runIngest(undefined, scriptPath);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.output, /fixture ran ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real nonzero-exit subprocess still produces a safe, translated failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fuzzy-ingest-fixture-"));
  const scriptPath = join(dir, "fail.mjs");
  writeFileSync(scriptPath, "console.error('boom: /secret/path/leaked'); process.exit(1);");
  try {
    const result = await runIngest(undefined, scriptPath);
    assert.equal(result.ok, false);
    if (!result.ok) assert.doesNotMatch(result.error, /secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
