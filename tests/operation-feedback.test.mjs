import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createOperationJournal } from "../scripts/lib/operation-journal.mjs";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "tbrain-feedback-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return createOperationJournal({ directory });
}

test("caller feedback stays separate from server facts and can describe a pre-call failure", async t => {
  const journal = await setup(t);
  const workflow = randomUUID();
  const report = await journal.report({ workflow_id: workflow, stage: "request", outcome: "failed", finding: "request_construction", observed_at: null });
  assert.equal(report.recorded, true);
  const saved = await journal.readReport(report.id);
  assert.equal(saved.attribution, "caller_reported");
  assert.equal(saved.operation_id, null);
  assert.equal(saved.workflow_id, workflow);
  assert.equal(saved.observed_at, null);
  assert.equal(saved.finding, "request_construction");
  assert.equal((await journal.list()).traces.length, 0);
});

test("feedback attaches to a verified trace and preserves expected evidence without approving it", async t => {
  const journal = await setup(t);
  const operation = await journal.start({ entry_point: "tbrain_mcp", operation: "recall", release: "0.31.0", input: {} });
  await journal.finish(operation.id, { result: { hits: [] }, duration_ms: 4 });
  const expected = randomUUID();
  const report = await journal.report({ operation_id: operation.id, stage: "retrieval", outcome: "failed", finding: "missing_expected_evidence", expected_evidence_ids: [expected] });
  assert.equal(report.recorded, true);
  const saved = await journal.readReport(report.id);
  assert.deepEqual(saved.expected_evidence_ids, [expected]);
  assert.equal(saved.attribution, "caller_reported");
  assert.equal((await journal.read(operation.id)).finish.outcome, "success");
  await assert.rejects(() => journal.report({ operation_id: `2000-01-01_${randomUUID()}`, stage: "retrieval", outcome: "failed", finding: "missing_expected_evidence" }), error => error.code === "not_found");
  await assert.rejects(() => journal.report({ stage: "retrieval", outcome: "failed", finding: "PRIVATE TEXT" }), error => error.code === "invalid");
});

test("summary separates empty retrieval, service errors, unfinished calls, and caller feedback", async t => {
  const journal = await setup(t);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await journal.start({ entry_point: "tbrain_mcp", operation: "recall", release: i === 0 ? "0.30.0" : "0.31.0", input: {} })).id);
  await journal.finish(ids[0], { result: { hits: [], degraded: true }, duration_ms: 5 });
  await journal.finish(ids[1], { result: { hits: [] }, duration_ms: 10 });
  await journal.finish(ids[2], { error: { code: "invalid" }, duration_ms: 1 });
  await journal.report({ operation_id: ids[1], stage: "retrieval", outcome: "failed", finding: "missing_expected_evidence" });
  const summary = await journal.summary({ day: ids[0].slice(0, 10) });
  assert.equal(summary.operations, 4);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.errors.invalid, 1);
  assert.equal(summary.empty_retrievals, 2);
  assert.equal(summary.degraded_retrievals, 1);
  assert.equal(summary.caller_reports, 1);
  assert.equal(summary.findings.missing_expected_evidence, 1);
  assert.equal(summary.duration_ms.p50, 5);
  assert.equal(summary.duration_ms.p95, 10);
  assert.equal(summary.by_release["0.30.0"], 1);
  assert.equal(summary.by_release["0.31.0"], 3);
  const limited = await journal.summary({ day: ids[0].slice(0, 10), limit: 2 });
  assert.equal(limited.operations, 2);
  assert.equal(limited.exhaustive, false);
});
