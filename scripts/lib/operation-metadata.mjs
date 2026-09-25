import { createHash } from "node:crypto";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codes = new Set(["invalid", "not_found", "conflict", "unauthorized", "excluded", "unavailable", "cancelled"]);
const roles = new Set(["user", "assistant", "system", "tool", "other", "unknown"]);
const operations = new Set([
  "initialize", "tools/list", "ping", "recall", "remember", "mark_complete", "get_node", "list_reminders",
  "read_write_receipt", "status", "transfer_format", "prepare_capture", "validate_transfer", "archive_day",
  "read_receipt", "read_archive", "read_source", "read_evidence", "search_archive", "trace_status", "read_trace",
  "list_traces", "report_outcome", "trace_summary", "validate", "import", "receipt", "verify", "export", "search",
  "read", "source", "evidence", "add-node", "add-edge", "add-source", "add-episode", "add-evidence", "import-transfer",
  "show", "index", "dump", "list-sources", "list-episodes", "show-evidence", "set-readable", "add-talk",
  "set-exclusions", "mark-sender-deleted", "help",
]);
const finite = value => typeof value === "number" && Number.isFinite(value);
const validId = value => typeof value === "string" && uuid.test(value);
export const safeErrorCode = value => codes.has(value) ? value : "unavailable";
export const safeOperation = value => operations.has(value) ? value : "unknown";

export function fingerprint(value) {
  const text = JSON.stringify(value ?? null);
  return { sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), content_omitted: true };
}

export function callerMetadata(caller) {
  const known = new Set(["codex", "claude", "claude-code", "cursor", "chatgpt", "gemini", "vscode", "mcp-inspector", "tbrain"]);
  const name = typeof caller?.name === "string" ? caller.name.toLowerCase() : null;
  const version = typeof caller?.version === "string" && /^\d+(?:\.\d+){0,3}$/.test(caller.version) ? caller.version : null;
  return { name: known.has(name) ? name : null, name_sha256: name ? fingerprint(caller.name).sha256 : null,
    version, attribution: "client_reported" };
}

function references(value = {}) {
  if (!value || typeof value !== "object") value = {};
  const result = {};
  for (const key of ["id", "source_id", "episode_id", "receipt_id", "request_id", "evidence_id", "node_id"]) {
    if (validId(value[key])) result[key] = value[key].toLowerCase();
  }
  for (const key of ["evidence_ids", "node_ids"]) {
    if (!Array.isArray(value[key])) continue;
    result[key] = value[key].filter(validId).slice(0, 100).map(id => id.toLowerCase());
    if (value[key].length > result[key].length) result.references_truncated = true;
  }
  return result;
}

export function inputMetadata(value) {
  const input = value && typeof value === "object" ? value : {};
  const filters = {};
  if (roles.has(input.role)) filters.role = input.role;
  if (["all", "nodes", "evidence"].includes(input.layer)) filters.layer = input.layer;
  for (const key of ["limit", "offset", "text_limit", "text_offset", "context"]) {
    if (finite(input[key]) && input[key] >= 0) filters[key] = input[key];
  }
  for (const key of ["from", "until"]) {
    if (typeof input[key] === "string" && /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(input[key]) && input[key].length <= 40) filters[key] = input[key];
  }
  const transfer = input.transfer && typeof input.transfer === "object" ? input.transfer : input;
  return {
    ...fingerprint(value), filters, references: { ...references(input), ...references(transfer) },
    ...(Array.isArray(transfer.messages) ? { message_count: transfer.messages.length } : {}),
  };
}

export function outputMetadata(value) {
  const output = value && typeof value === "object" ? value : {};
  const metadata = { ...fingerprint(value), references: references(output) };
  for (const key of ["saved", "valid", "replayed", "degraded", "exhaustive", "truncated", "has_more"]) {
    if (typeof output[key] === "boolean") metadata[key] = output[key];
  }
  for (const key of ["total_messages", "next_offset", "next_text_offset", "total"]) {
    if (finite(output[key])) metadata[key] = output[key];
  }
  if (["committed", "prepared", "verified", "failed", "ready", "missing", "partial", "evidence", "supported", "conflict", "unavailable"].includes(output.state)) metadata.state = output.state;
  if (output.evidence && typeof output.evidence === "object") {
    metadata.evidence = { ...references(output.evidence), source: references(output.evidence.source) };
  }
  if (Array.isArray(output.hits)) {
    metadata.hit_count = output.hits.length;
    metadata.hits = output.hits.slice(0, 100).map((hit, index) => ({
      rank: index + 1,
      ...references(hit), ...references(hit?.provenance),
      ...(["node", "evidence"].includes(hit?.layer) ? { layer: hit.layer } : {}),
      ...(roles.has(hit?.role) ? { role: hit.role } : {}),
    }));
    metadata.hits_truncated = output.hits.length > 100;
  }
  return metadata;
}
