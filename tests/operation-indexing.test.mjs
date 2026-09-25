import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";
import { outputMetadata } from "../scripts/lib/operation-metadata.mjs";
import { outcomeReportSchema, summarizeOperations } from "../scripts/lib/operation-feedback.mjs";
const run = promisify(execFile);
const id = "11111111-1111-4111-8111-111111111111";

test("index diagnostics retain safe counts and accept a pending-index finding", () => {
  const result = outputMetadata({ scope: { receipt_id: id }, evidence: { total: 7, indexed: 3, pending: 4, text: "PRIVATE" }, nodes: null,
    semantic_index: { state: "pending", note: "PRIVATE" } });
  assert.deepEqual(result.indexing, { state: "pending", evidence: { total: 7, indexed: 3, pending: 4 }, nodes: null });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(outcomeReportSchema.safeParse({ workflow_id: id, stage: "retrieval", outcome: "partial", finding: "pending_index" }).success, true);
  const summary = summarizeOperations([{ start: { operation: "index_status" } }], []);
  assert.equal(summary.operations, 0);
  assert.equal(summary.diagnostics.operations, 1);
});

test("a direct index repair leaves a trace even when the requested receipt does not exist", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const directory = await mkdtemp(join(tmpdir(), "index-repair-trace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/embed-sweep.mjs", import.meta.url));
  await assert.rejects(run(process.execPath, [script, "--receipt-id", id, "--limit", "4"], { env: {
    ...process.env, DATABASE_URL: database.url, DATABASE_URL_DEV: database.url, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE: "1", TBRAIN_TRACE_DIR: directory,
    FUZZY_BRAIN_EMBED_LOCK: join(directory, "sweep.lock"),
  } }));
  const { traces } = await createOperationJournal({ directory }).list();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].start.operation, "index_repair");
  assert.equal(traces[0].start.entry_point, "index_cli");
  assert.equal(traces[0].input.input.references.receipt_id, id);
  assert.equal(traces[0].finish.error_code, "not_found");
});
