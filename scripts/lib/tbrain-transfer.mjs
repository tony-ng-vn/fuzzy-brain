import { createHash } from "node:crypto";
import { z } from "zod";
import { scrubSensitivePatterns } from "../brain.mjs";

export const MAX_TRANSFER_BYTES = 4 * 1024 * 1024;
const text = z.string().min(1).max(200000).refine(v => v.trim().length > 0);
const label = z.string().min(1).max(500).refine(v => v.trim().length > 0);
const instant = z.iso.datetime({ offset: true }).nullable();

export const transferSchema = z.strictObject({
  format: z.literal("tbrain.transfer.v1"),
  source_id: z.uuid(),
  source_key: label,
  revision: label,
  source: z.strictObject({ platform: label, conversation_id: label.nullable(), title: label.nullable(), project: label.nullable() }),
  coverage: z.strictObject({
    kind: z.enum(["source_export", "model_assembled"]),
    completeness: z.enum(["complete", "partial", "unknown"]),
    from: instant, until: instant,
    limitations: z.array(label).max(100),
    omissions: z.array(z.strictObject({ reason: label, count: z.number().int().nonnegative().nullable() })).max(100),
  }),
  messages: z.array(z.strictObject({
    id: label.nullable(), role: z.enum(["user", "assistant", "system", "tool", "other", "unknown"]),
    speaker: label.nullable(), text, at: instant,
    fidelity: z.enum(["verbatim", "paraphrase", "unknown"]),
  })).min(1).max(2000),
  reflection: z.strictObject({
    author: z.literal("assistant"), status: z.literal("provisional"), text,
    message_ordinals: z.array(z.number().int().nonnegative()).max(2000),
  }).nullable(),
  relation: z.strictObject({ receipt_id: z.uuid(), kind: z.enum(["correction", "supplements", "source_export"]), note: label }).nullable(),
  original: z.strictObject({ media_type: z.enum(["text/plain", "application/json", "application/jsonl"]), text: z.string().min(1).max(MAX_TRANSFER_BYTES) }).optional(),
}).superRefine((v, ctx) => {
  const issue = message => ctx.addIssue({ code: "custom", message });
  if (v.coverage.kind === "model_assembled" && v.coverage.completeness === "complete") issue("model assembly cannot claim a complete source export");
  if (v.coverage.kind === "model_assembled" && !v.coverage.limitations.length) issue("model assembly must disclose its limitations");
  if (v.original && v.coverage.kind !== "source_export") issue("original bytes require source_export coverage");
  if (v.coverage.from && v.coverage.until && Date.parse(v.coverage.from) > Date.parse(v.coverage.until)) issue("coverage dates are reversed");
  const ids = v.messages.map(m => m.id).filter(id => id !== null);
  if (new Set(ids).size !== ids.length) issue("known message ids must be unique within a revision");
  if (v.reflection?.message_ordinals.some(i => i >= v.messages.length)) issue("reflection refers to unavailable messages");
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}

export function validateTransfer(input) {
  if (Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") > MAX_TRANSFER_BYTES) throw new Error("transfer exceeds 4 MiB");
  return transferSchema.parse(input);
}

export function prepareTransfer(input) {
  const supplied = validateTransfer(input);
  const redactions = [];
  // Filter metadata too: an excluded secret in a title is still a secret.
  function scrub(value, path = "") {
    if (typeof value === "string") {
      // Typed UUIDs are identifiers, not card numbers hidden in prose.
      if (path === "source_id" || path === "relation.receipt_id") return value;
      const filtered = scrubSensitivePatterns(value);
      for (const r of filtered.redactions) redactions.push({ path, reason: r.reason });
      return filtered.text;
    }
    if (Array.isArray(value)) return value.map((v, i) => scrub(v, `${path}.${i}`));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, path ? `${path}.${k}` : k)]));
    return value;
  }
  const bundle = scrub(supplied);
  // Identity must survive filtering; otherwise two different inputs could alias.
  if (["source_id", "source_key", "revision"].some(k => bundle[k] !== supplied[k])) throw new Error("sensitive transfer identity rejected");
  if (bundle.messages.some((m,i)=>m.id!==supplied.messages[i].id) || bundle.source.conversation_id!==supplied.source.conversation_id) throw new Error("sensitive source identifier rejected");
  validateTransfer(bundle);
  return { bundle, digest: digest(supplied), stored_digest: digest(bundle), redactions };
}

export const captureShape = {
  source_id: z.uuid().optional().describe("Use a configured source ID. May be omitted only when exactly one is configured."),
  source_key: label.describe("Stable identity of the actual conversation; reuse it for retries."),
  revision: label.describe("Reuse after an uncertain save. A changed packet needs a new revision and relation."),
  platform: label,
  conversation_id: label.nullable().default(null),
  title: label.nullable().default(null),
  project: label.nullable().default(null),
  messages: z.array(transferSchema.shape.messages.element.extend({
    id: label.nullable().default(null), speaker: label.nullable().default(null),
    at: instant.default(null), fidelity: z.enum(["verbatim", "paraphrase", "unknown"]).default("verbatim"),
  })).min(1).max(2000),
  limitations: z.array(label).min(1).max(100).default(["Only supplied messages are included; completeness is not verified."]),
  reflection: transferSchema.shape.reflection.default(null),
  relation: transferSchema.shape.relation.default(null),
};

export function prepareCapture(input, allowedSourceIds) {
  const value = z.object(captureShape).parse(input);
  const sourceId = value.source_id ?? (allowedSourceIds.length === 1 ? allowedSourceIds[0] : null);
  if (!sourceId || !allowedSourceIds.includes(sourceId)) {
    throw Object.assign(new Error("Choose one configured source_id from transfer_format before preparing capture."), { code: "unauthorized" });
  }
  const prepared = prepareTransfer({
    format: "tbrain.transfer.v1", source_id: sourceId, source_key: value.source_key, revision: value.revision,
    source: { platform: value.platform, conversation_id: value.conversation_id, title: value.title, project: value.project },
    coverage: { kind: "model_assembled", completeness: "partial", from: null, until: null, limitations: value.limitations, omissions: [] },
    messages: value.messages, reflection: value.reflection, relation: value.relation,
  });
  return { state: "prepared", saved: false, storage_checked: false, transfer: prepared.bundle, redactions: prepared.redactions };
}

// Never echo invalid values, unknown key names, or arbitrary exception messages.
const knownFields = new Set(["format", "source_id", "source_key", "revision", "source", "platform", "conversation_id", "title", "project",
  "coverage", "kind", "completeness", "from", "until", "limitations", "omissions", "reason", "count", "messages", "id", "role", "speaker", "text", "at",
  "fidelity", "reflection", "author", "status", "message_ordinals", "relation", "receipt_id", "note", "original", "media_type"]);

export function inspectTransfer(input) {
  try {
    const prepared = prepareTransfer(input);
    return { state: "prepared", valid: true, saved: false, storage_checked: false,
      digest: prepared.digest, stored_digest: prepared.stored_digest, redactions: prepared.redactions };
  } catch (error) {
    const issues = error instanceof z.ZodError ? error.issues.slice(0, 20).map(issue => ({
      path: issue.path.map(part => typeof part === "number" || knownFields.has(part) ? part : "[field]").join("."),
      code: issue.code,
      message: issue.code === "custom" ? issue.message : "Use the field type and allowed values in transfer_format. Remove unknown fields.",
    })) : [{ path: "", code: "invalid", message: "Keep the transfer within 4 MiB and do not use sensitive-pattern values as identifiers." }];
    return { state: "invalid", valid: false, saved: false, storage_checked: false, issues };
  }
}
