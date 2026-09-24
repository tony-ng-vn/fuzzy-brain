import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true }).refine(value => (value.match(/\.(\d+)/)?.[1].length ?? 0) <= 6,
  "Use at most six fractional second digits.");

export const recallScopeShape = {
  layer: z.enum(["all", "nodes", "evidence"]).optional().describe("Search approved nodes, source evidence, or both. Source and role filters select evidence; they cannot be combined with nodes."),
  source_id: z.uuid().nullable().optional().describe("Restrict evidence to a registered source UUID."),
  role: z.enum(["user", "assistant", "system", "tool", "other", "unknown"]).nullable().optional().describe("Restrict evidence to its recorded role or a known session parser's role."),
  from: timestamp.nullable().optional().describe("Inclusive timestamp lower bound, with at most six fractional second digits. Explicit dates override inferred calendar dates and require known message timestamps or node creation timestamps."),
  until: timestamp.nullable().optional().describe("Inclusive timestamp upper bound, with at most six fractional second digits. An undated message cannot match an explicit date range."),
};

export const recallInputShape = { question: z.string().trim().min(1).max(2000), ...recallScopeShape };

function exactTimestamp(value) {
  if (!value) return null;
  const fraction = (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0");
  const milliseconds = Date.parse(value);
  // Date supplies the timezone conversion, but PostgreSQL also retains microseconds.
  const digits = fraction.slice(0, 3) + fraction.slice(3).replace(/0+$/, "");
  return {
    text: new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, `.${digits}Z`),
    microseconds: BigInt(milliseconds) * 1000n + BigInt(fraction.slice(3)),
  };
}

export function parseRecallScope(input) {
  const parsed = z.object(recallScopeShape).safeParse(input);
  const invalid = () => Object.assign(new Error("Invalid recall scope."), { code: "invalid" });
  if (!parsed.success) throw invalid();
  const { layer = "all", source_id = null, role = null, from = null, until = null } = parsed.data;
  const lower = exactTimestamp(from), upper = exactTimestamp(until);
  if (lower && upper && lower.microseconds > upper.microseconds) throw invalid();
  if (layer === "nodes" && (source_id || role)) throw invalid();
  return {
    layer: source_id || role ? "evidence" : layer,
    source_id: source_id?.toLowerCase() ?? null, role,
    from: lower?.text ?? null,
    until: upper?.text ?? null,
  };
}
