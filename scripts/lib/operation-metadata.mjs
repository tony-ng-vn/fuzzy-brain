import { createHash } from "node:crypto";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codes = new Set(["invalid", "not_found", "conflict", "unauthorized", "excluded", "unavailable", "cancelled"]);
const roles = new Set(["user", "assistant", "system", "tool", "other", "unknown"]);
const operations = new Set([
  "initialize", "tools/list", "ping", "recall", "remember", "mark_complete", "get_node", "list_reminders", "index_status", "index_repair", "sync", "sync_install", "sync_config", "session_capture", "list-session-checkpoints",
  "read_write_receipt", "status", "transfer_format", "prepare_capture", "validate_transfer", "archive_day",
  "read_receipt", "read_archive", "read_source", "read_evidence", "search_archive", "trace_status", "read_trace",
  "list_traces", "report_outcome", "trace_summary", "validate", "import", "receipt", "verify", "export", "search",
  "read", "source", "evidence", "add-node", "add-edge", "add-source", "add-episode", "add-evidence", "import-transfer",
  "show", "index", "dump", "list-sources", "list-episodes", "show-evidence", "set-readable", "add-talk",
  "set-exclusions", "mark-sender-deleted", "help", "get-node", "read-write-receipt", "set-deadline", "clear-deadline", "mark-complete", "list-reminders", "session-checkpoints", "sync-session",
]);
const finite = value => typeof value === "number" && Number.isFinite(value);
const validId = value => typeof value === "string" && uuid.test(value);
export const safeErrorCode = value => codes.has(value) ? value : "unavailable";
const itemErrorCode = value => value?.error ? safeErrorCode(value.error.code ?? value.error)
  : value?.ok === false ? "unavailable" : null;
export function resultErrorCode(value) {
  if (!Array.isArray(value)) return itemErrorCode(value);
  for (const item of value) {
    const code = itemErrorCode(item);
    if (code) return code;
  }
  return null;
}
export const safeOperation = value => {
  const normalized = ["trace-status", "trace-summary", "report-outcome", "index-status"].includes(value) ? value.replaceAll("-", "_")
    : value === "traces" ? "list_traces" : value === "trace" ? "read_trace" : value;
  return operations.has(normalized) ? normalized : "unknown";
};

export function fingerprint(value) {
  const text = JSON.stringify(value ?? null);
  return { sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), content_omitted: true };
}

export function callerMetadata(caller) {
  const known = new Set(["codex", "claude", "claude-code", "cursor", "chatgpt", "gemini", "vscode", "mcp-inspector", "tbrain"]);
  const name = typeof caller?.name === "string" ? caller.name.toLowerCase() : null;
  const version = typeof caller?.version === "string" && caller.version.length <= 64 && /^\d+(?:\.\d+){0,3}$/.test(caller.version) ? caller.version : null;
  return { name: known.has(name) ? name : null, name_sha256: name ? fingerprint(caller.name).sha256 : null,
    version, attribution: "client_reported" };
}

function references(value, budget) {
  if (!value || typeof value !== "object") value = {};
  const result = {};
  for (const key of ["id", "source_id", "episode_id", "receipt_id", "checkpoint_id", "request_id", "evidence_id", "node_id"]) {
    if (validId(value[key])) result[key] = value[key].toLowerCase();
  }
  for (const key of ["evidence_ids", "node_ids"]) {
    if (!Array.isArray(value[key])) continue;
    result[key] = [];
    for (const id of value[key]) {
      if (result[key].length === 100 || budget.remaining === 0) break;
      if (!validId(id)) continue;
      result[key].push(id.toLowerCase());
      budget.remaining--;
    }
    if (value[key].length > result[key].length) {
      result.references_truncated = true;
      budget.truncated = true;
    }
  }
  return result;
}

function referenceCollector() {
  // Per-list limits alone multiply across a batch and can exceed a journal record.
  const budget = { remaining: 1000, truncated: false };
  return { read: value => references(value, budget), get truncated() { return budget.truncated; } };
}

function captureMetadata(value, readReferences) {
  const coverage = value.coverage && typeof value.coverage === "object" ? value.coverage : {};
  const messageRoles = {};
  for (const message of value.messages ?? []) {
    const role = roles.has(message?.role) ? message.role : "unknown";
    messageRoles[role] = (messageRoles[role] ?? 0) + 1;
  }
  return {
    coverage: {
      kind: ["source_export", "model_assembled"].includes(coverage.kind) ? coverage.kind : null,
      completeness: ["complete", "partial", "unknown"].includes(coverage.completeness) ? coverage.completeness : null,
    },
    message_roles: messageRoles,
    known_message_dates: (value.messages ?? []).filter(message => typeof message?.at === "string" && Number.isFinite(Date.parse(message.at))).length,
    source_key_sha256: typeof value.source_key === "string" ? fingerprint(value.source_key).sha256 : null,
    revision_sha256: typeof value.revision === "string" ? fingerprint(value.revision).sha256 : null,
    relation: { ...readReferences(value.relation), kind: ["correction", "supplements", "source_export"].includes(value.relation?.kind) ? value.relation.kind : null },
  };
}

export function inputMetadata(value) {
  const refs = referenceCollector();
  const input = value && typeof value === "object" ? value : {};
  const filters = {};
  if (roles.has(input.role)) filters.role = input.role;
  if (["all", "nodes", "evidence"].includes(input.layer)) filters.layer = input.layer;
  for (const key of ["limit", "offset", "text_limit", "text_offset", "context", "max_duration_ms"]) {
    if (finite(input[key]) && input[key] >= 0) filters[key] = input[key];
  }
  for (const key of ["from", "until"]) {
    if (typeof input[key] === "string" && /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(input[key]) && input[key].length <= 40) filters[key] = input[key];
  }
  const transfer = input.transfer && typeof input.transfer === "object" ? input.transfer : input;
  return {
    ...fingerprint(value), filters, references: { ...refs.read(input), ...(transfer !== input ? refs.read(transfer) : {}) },
    ...(Array.isArray(value) ? { item_count: value.length, items: value.slice(0, 100).map(refs.read), items_truncated: value.length > 100 } : {}),
    ...(Array.isArray(transfer.messages) ? { message_count: transfer.messages.length, capture: captureMetadata(transfer, refs.read) } : {}),
    ...(refs.truncated ? { references_truncated: true } : {}),
  };
}

export function outputMetadata(value) {
  const refs = referenceCollector();
  const output = value && typeof value === "object" ? value : {};
  const metadata = { ...fingerprint(value), references: refs.read(output) };
  if (Array.isArray(value)) {
    metadata.item_count = value.length;
    metadata.items = value.slice(0, 100).map(item => {
      const fields = refs.read(item);
      if (["committed", "prepared", "verified", "failed"].includes(item?.state)) fields.state = item.state;
      if (typeof item?.replayed === "boolean") fields.replayed = item.replayed;
      for (const key of ["evidence_count", "seen_count"]) {
        if (Number.isSafeInteger(item?.[key]) && item[key] >= 0) fields[key] = item[key];
      }
      const code = itemErrorCode(item);
      if (code) fields.error_code = code;
      return fields;
    });
    metadata.items_truncated = value.length > 100;
    metadata.failed_item_count = 0;
    metadata.item_errors = {};
    for (const item of value) {
      const code = itemErrorCode(item);
      if (code) {
        metadata.failed_item_count++;
        metadata.item_errors[code] = (metadata.item_errors[code] ?? 0) + 1;
      }
    }
  }
  for (const key of ["ok", "saved", "valid", "replayed", "degraded", "exhaustive", "truncated", "has_more", "time_limit_reached"]) {
    if (typeof output[key] === "boolean") metadata[key] = output[key];
  }
  for (const key of ["total_messages", "next_offset", "next_text_offset", "total", "indexed_evidence", "indexed_nodes"]) {
    if (finite(output[key])) metadata[key] = output[key];
  }
  if (["committed", "prepared", "verified", "failed", "ready", "missing", "partial", "evidence", "supported", "conflict", "unavailable"].includes(output.state)) metadata.state = output.state;
  if (output.evidence && typeof output.evidence === "object") {
    metadata.evidence = { ...refs.read(output.evidence), source: refs.read(output.evidence.source) };
  }
  if (["empty", "pending", "complete"].includes(output.semantic_index?.state)) {
    const counts = value => value && ["total", "indexed", "pending"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      ? { total: value.total, indexed: value.indexed, pending: value.pending } : null;
    metadata.indexing = { state: output.semantic_index.state, evidence: counts(output.evidence), nodes: counts(output.nodes) };
  }
  if (Array.isArray(output.failures)) {
    metadata.failed_stages = [...new Set(output.failures.map(item => item?.stage)
      .filter(stage => ["ingest", "watch-items", "embedding"].includes(stage)))];
  }
  if (output.capture_sources && typeof output.capture_sources === "object") {
    metadata.capture_sources = {};
    for (const source of ["claude", "codex"]) {
      const counts = output.capture_sources[source];
      if (!counts || typeof counts !== "object") continue;
      metadata.capture_sources[source] = {};
      for (const key of ["scanned", "attempted", "deferred", "notSettled", "allowlistSkipped", "excluded", "noTonyTurns", "alreadyIngested", "unparseable", "failed", "ingested", "evidenceRows"]) {
        if (Number.isSafeInteger(counts[key]) && counts[key] >= 0) metadata.capture_sources[source][key] = counts[key];
      }
    }
    metadata.failed_sources = [...new Set((Array.isArray(output.failed_sources) ? output.failed_sources : [])
      .filter(source => ["claude", "codex"].includes(source)))];
  }
  if (Array.isArray(output.hits)) {
    metadata.hit_count = output.hits.length;
    metadata.hits = output.hits.slice(0, 100).map((hit, index) => ({
      rank: index + 1,
      ...refs.read(hit), ...refs.read(hit?.provenance),
      ...(["node", "evidence"].includes(hit?.layer) ? { layer: hit.layer } : {}),
      ...(roles.has(hit?.role) ? { role: hit.role } : {}),
      ...(["strong", "partial"].includes(hit?.match_strength) ? { match_strength: hit.match_strength } : {}),
      ...(Number.isSafeInteger(hit?.quote_offset) && hit.quote_offset >= 0 ? { quote_offset: hit.quote_offset } : {}),
      ...(Number.isSafeInteger(hit?.quote_length) && hit.quote_length >= 0 ? { quote_length: hit.quote_length } : {}),
      ...(typeof hit?.quote_truncated === "boolean" ? { quote_truncated: hit.quote_truncated } : {}),
    }));
    metadata.hits_truncated = output.hits.length > 100;
  }
  if (refs.truncated) metadata.references_truncated = true;
  return metadata;
}
