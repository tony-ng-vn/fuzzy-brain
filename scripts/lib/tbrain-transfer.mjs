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
