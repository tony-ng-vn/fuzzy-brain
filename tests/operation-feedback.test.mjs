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

test("summary shows recall latency and failures separately from a long background cycle", async t => {
  const journal = await setup(t);
  for (const duration_ms of [5, 20]) {
    const call = await journal.start({ entry_point: "tbrain_mcp", operation: "recall" });
    await journal.finish(call.id, { result: { hits: [], degraded: duration_ms === 20 }, duration_ms });
    await journal.recordDelivery(call.id, "sent");
  }
  const rejected = await journal.start({ entry_point: "tbrain_mcp", operation: "recall" });
  await journal.finish(rejected.id, { error: { code: "invalid" }, duration_ms: 1 });
  await journal.recordDelivery(rejected.id, "failed");
  await journal.start({ entry_point: "tbrain_mcp", operation: "recall" });
  const sync = await journal.start({ entry_point: "sync_cli", operation: "sync" });
  await journal.finish(sync.id, { result: { ok: false }, duration_ms: 1200000 });
  const diagnostic = await journal.start({ entry_point: "tbrain_mcp", operation: "trace_summary" });
  await journal.finish(diagnostic.id, { error: { code: "unavailable" }, duration_ms: 10000 });
  const summary = await journal.summary();
  assert.deepEqual(summary.per_operation.recall, {
    operations: 4, incomplete: 1, errors: { invalid: 1 }, empty_retrievals: 2, degraded_retrievals: 1,
    failed_deliveries: 1, unconfirmed_deliveries: 0, recall_states: { unknown: 2 },
    duration_ms: { samples: 3, p50: 5, p95: 20, p99: 20 },
  });
  assert.equal(summary.per_operation.sync.duration_ms.p95, 1200000);
  assert.equal(summary.per_operation.sync.unconfirmed_deliveries, 0);
  assert.deepEqual(summary.per_operation.sync.errors, { unavailable: 1 });
  assert.equal(summary.per_operation.trace_summary, undefined);
  assert.equal(summary.diagnostics.errors.unavailable, 1);
  assert.deepEqual(summary.by_operation, { recall: 4, sync: 1 });
  assert.equal(summary.duration_ms.p95, 1200000, "the existing overall statistic remains available");
});

test("delivery counts describe MCP replies without treating CLI completion as a lost reply", async t => {
  const journal = await setup(t);
  for (const entry_point of ["tbrain_cli", "recall_cli", "brain_cli", "index_cli", "sync_cli", "unknown"]) {
    const operation = await journal.start({ entry_point, operation: "recall", input: {} });
    await journal.finish(operation.id, { result: { hits: [] }, duration_ms: 1 });
  }
  for (const state of ["sent", "failed", null]) {
    const operation = await journal.start({ entry_point: "tbrain_mcp", operation: "recall", input: {} });
    await journal.finish(operation.id, { result: { hits: [] }, duration_ms: 1 });
    if (state) await journal.recordDelivery(operation.id, state);
  }
  const legacy = await journal.start({ entry_point: "fuzzy_brain_mcp", operation: "remember", input: {} });
  await journal.finish(legacy.id, { result: { saved: true }, duration_ms: 1, delivery: "sent" });
  await journal.start({ entry_point: "fuzzy_brain_mcp", operation: "recall", input: {} });
  const summary = await journal.summary({ day: legacy.id.slice(0, 10) });
  assert.equal(summary.failed_deliveries, 1);
  assert.equal(summary.unconfirmed_deliveries, 1);
  assert.equal(summary.incomplete, 1);
});

test("summary counts each failed background step once per run without copying errors", async t => {
  const journal = await setup(t);
  const first = await journal.start({ entry_point: "sync_cli", operation: "sync", input: [] });
  await journal.finish(first.id, { result: { ok: false, error: "PRIVATE ERROR", failures: [
    { stage: "ingest", message: "PRIVATE ERROR" }, { stage: "ingest" }, { stage: "embedding" }, { stage: "PRIVATE STAGE" },
  ] }, duration_ms: 2 });
  const second = await journal.start({ entry_point: "sync_cli", operation: "sync", input: [] });
  await journal.finish(second.id, { result: { ok: false, failures: [{ stage: "embedding" }] }, duration_ms: 1 });
  const summary = await journal.summary({ day: first.id.slice(0, 10) });
  assert.deepEqual(summary.failed_stages, { ingest: 1, embedding: 2 });
  assert.equal(JSON.stringify(summary).includes("PRIVATE"), false);
});


test("feedback distinguishes expected and used nodes from source evidence", async t => {
  const journal = await setup(t);
  const operation = await journal.start({ operation: "recall" });
  await journal.finish(operation.id, { result: { hits: [] }, duration_ms: 1 });
  const expected = randomUUID(), used = randomUUID(), evidence = randomUUID();
  const input = { operation_id: operation.id, stage: "retrieval", outcome: "partial", finding: "missing_expected_node",
    expected_node_ids: [expected], used_node_ids: [used], expected_evidence_ids: [evidence], used_evidence_ids: [evidence] };
  const receipt = await journal.report(input);
  const saved = await journal.readReport(receipt.id);
  for (const key of ["expected_node_ids", "used_node_ids", "expected_evidence_ids", "used_evidence_ids"]) assert.deepEqual(saved[key], input[key]);
  assert.equal(saved.attribution, "caller_reported");
  assert.equal((await journal.read(operation.id)).finish.outcome, "success");
  assert.equal((await journal.summary()).findings.missing_expected_node, 1);
  for (const key of ["expected_node_ids", "used_node_ids"]) {
    await assert.rejects(journal.report({ ...input, [key]: ["PRIVATE NODE TEXT"] }), error => error.code === "invalid");
    await assert.rejects(journal.report({ ...input, [key]: Array.from({ length: 21 }, () => randomUUID()) }), error => error.code === "invalid");
  }
  const legacy = await journal.report({ operation_id: operation.id, stage: "reasoning", outcome: "unknown", finding: "none" });
  const unchanged = await journal.readReport(legacy.id);
  assert.deepEqual(unchanged.expected_node_ids, []);
  assert.deepEqual(unchanged.used_node_ids, []);
});


test("summary counts recall result states without treating them as answer quality", async t => {
  const journal = await setup(t);
  for (const state of ["supported", "conflicting", "evidence", "partial", "missing", "PRIVATE state", undefined]) {
    const operation = await journal.start({ operation: "recall" });
    await journal.finish(operation.id, { result: { state, note: "PRIVATE explanation", hits: [] }, duration_ms: 1 });
  }
  const failed = await journal.start({ operation: "recall" });
  await journal.finish(failed.id, { error: { code: "unavailable" } });
  await journal.start({ operation: "recall" });
  const unrelated = await journal.start({ operation: "index_status" });
  await journal.finish(unrelated.id, { result: { state: "missing" } });
  await journal.report({ operation_id: failed.id, stage: "reasoning", outcome: "failed", finding: "insufficient_support" });
  const summary = await journal.summary();
  const expected = { supported: 1, conflicting: 1, evidence: 1, partial: 1, missing: 1, unknown: 2 };
  assert.deepEqual(summary.recall_states, expected);
  assert.deepEqual(summary.per_operation.recall.recall_states, expected);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.errors.unavailable, 1);
  assert.equal(summary.findings.insufficient_support, 1);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
});
