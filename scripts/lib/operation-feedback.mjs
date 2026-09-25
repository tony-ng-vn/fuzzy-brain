import { z } from "zod";

export const traceIdShape = z.string().regex(/^\d{4}-\d{2}-\d{2}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const traceListFilterShape = {
  workflow_id: z.uuid().nullable().optional(),
  parent_id: traceIdShape.nullable().optional(),
  operation_id: traceIdShape.nullable().optional(),
};
export const traceListFilterSchema = z.strictObject(traceListFilterShape);
export const outcomeReportShape = {
  operation_id: traceIdShape.nullable().default(null),
  workflow_id: z.uuid().nullable().default(null),
  stage: z.enum(["request", "capture", "verification", "retrieval", "reasoning", "setup"]),
  outcome: z.enum(["succeeded", "failed", "partial", "unknown"]),
  finding: z.enum(["none", "request_construction", "schema_rejection", "source_identity_conflict", "unavailable_storage",
    "outdated_server", "missing_expected_evidence", "irrelevant_results", "incorrect_attribution", "incomplete_readback",
    "insufficient_support", "conflicting_evidence", "pending_index", "other"]),
  observed_at: z.iso.datetime({ offset: true }).nullable().default(null),
  expected_evidence_ids: z.array(z.uuid()).max(20).default([]),
  used_evidence_ids: z.array(z.uuid()).max(20).default([]),
};
export const outcomeReportSchema = z.strictObject(outcomeReportShape).refine(value => value.operation_id || value.workflow_id,
  "A report needs an operation or workflow identifier.");

function count(values, key) {
  const result = {};
  for (const value of values) {
    const label = key(value);
    if (label) result[label] = (result[label] ?? 0) + 1;
  }
  return result;
}

function summarizeTraceGroup(traces) {
  const durations = traces.map(t => t.finish?.duration_ms)
    .filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = fraction => durations.length ? durations[Math.ceil(durations.length * fraction) - 1] : null;
  const replies = traces.filter(t => ["tbrain_mcp", "fuzzy_brain_mcp"].includes(t.start.entry_point) && t.finish);
  const deliveryState = trace => trace.delivery?.state ?? trace.finish.delivery;
  return {
    operations: traces.length,
    incomplete: traces.filter(t => !t.finish).length,
    errors: count(traces, t => t.finish?.error_code),
    empty_retrievals: traces.filter(t => ["recall", "search_archive", "search"].includes(t.start.operation) && t.finish?.output.hit_count === 0).length,
    degraded_retrievals: traces.filter(t => t.finish?.output.degraded === true).length,
    failed_deliveries: replies.filter(t => deliveryState(t) === "failed").length,
    unconfirmed_deliveries: replies.filter(t => !["sent", "failed"].includes(deliveryState(t))).length,
    duration_ms: { samples: durations.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}

export function summarizeOperations(traces, reports) {
  const diagnosticNames = new Set(["trace_status", "read_trace", "list_traces", "report_outcome", "trace_summary", "index_status"]);
  const diagnostics = traces.filter(t => diagnosticNames.has(t.start.operation));
  traces = traces.filter(t => !diagnosticNames.has(t.start.operation));
  const groups = new Map();
  for (const trace of traces) {
    const name = trace.start.operation;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(trace);
  }
  return {
    ...summarizeTraceGroup(traces),
    diagnostics: { operations: diagnostics.length, incomplete: diagnostics.filter(t => !t.finish).length,
      errors: count(diagnostics, t => t.finish?.error_code) },
    failed_stages: count(traces.flatMap(t => t.finish?.output.failed_stages ?? []), stage => stage),
    caller_reports: reports.length, findings: count(reports, r => r.finding),
    by_release: count(traces, t => t.start.release ?? "unknown"),
    by_operation: count(traces, t => t.start.operation),
    per_operation: Object.fromEntries([...groups].map(([name, group]) => [name, summarizeTraceGroup(group)])),
    attribution: "Operation results are server-observed. Caller feedback and expected evidence are unverified reports.",
  };
}
