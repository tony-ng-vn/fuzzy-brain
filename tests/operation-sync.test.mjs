import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import * as sync from "../scripts/fusion-sync.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";
const run = promisify(execFile);

test("background failure logs omit captured child output and private errors", () => {
  assert.equal(typeof sync.logSyncFailure, "function");
  const lines = [], original = console.error;
  console.error = value => lines.push(value);
  try { sync.logSyncFailure("ingest", Object.assign(new Error("PRIVATE source and credential"), { stdout: "PRIVATE conversation", code: "invalid" })); }
  finally { console.error = original; }
  assert.equal(JSON.parse(lines[0]).stage, "ingest");
  assert.equal(JSON.parse(lines[0]).error_code, "invalid");
  assert.doesNotMatch(lines.join("\n"), /PRIVATE/);
});

test("background sync and its independent index child retain linked traces", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const home = await mkdtemp(join(tmpdir(), "sync-trace-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, "traces");
  const env = { HOME: home, USER: process.env.USER, PATH: process.env.PATH, DATABASE_URL: database.url, DATABASE_URL_DEV: database.url,
    BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE: "1", TBRAIN_TRACE_DIR: directory, FUZZY_BRAIN_EMBED_LOCK: join(home, "sweep.lock") };
  const script = fileURLToPath(new URL("../scripts/fusion-sync.mjs", import.meta.url));
  try { await run(process.execPath, [script], { env, timeout: 30000 }); }
  catch (error) { assert.equal(error.killed, false); assert.equal(error.code, 1); }
  const { traces } = await createOperationJournal({ directory }).list({ limit: 100 });
  const parent = traces.find(trace => trace.start.operation === "sync");
  assert.ok(parent, "the sync itself needs an observed result");
  assert.equal(parent.start.entry_point, "sync_cli");
  assert.ok(parent.finish);
  const child = traces.find(trace => trace.start.operation === "index_repair");
  assert.ok(child, "indexing runs even if another stage fails");
  assert.equal(child.start.parent_id, parent.id);
  assert.equal(child.finish.outcome, "success");
  await assert.rejects(run(process.execPath, [script, "--misspelled-flag"], { env, timeout: 30000 }), error => error.code === 1);
  const after = (await createOperationJournal({ directory }).list({ limit: 100 })).traces;
  assert.equal(after.filter(trace => trace.start.operation === "index_repair").length, 1, "invalid arguments must not start capture or indexing");
});
