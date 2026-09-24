import { z } from "zod";

export const recallScopeShape = {
  layer: z.enum(["all", "nodes", "evidence"]).optional().describe("Search approved nodes, source evidence, or both. Source and role filters select evidence; they cannot be combined with nodes."),
  source_id: z.uuid().nullable().optional().describe("Restrict evidence to a registered source UUID."),
  role: z.enum(["user", "assistant", "system", "tool", "other", "unknown"]).nullable().optional().describe("Restrict evidence to its recorded role or a known session parser's role."),
  from: z.iso.datetime({ offset: true }).nullable().optional().describe("Inclusive timestamp lower bound. Explicit dates override inferred calendar dates and require known message timestamps or node creation timestamps."),
  until: z.iso.datetime({ offset: true }).nullable().optional().describe("Inclusive timestamp upper bound. An undated message cannot match an explicit date range."),
};

export const recallInputShape = { question: z.string().trim().min(1).max(2000), ...recallScopeShape };

export function parseRecallScope(input) {
  const parsed = z.object(recallScopeShape).safeParse(input);
  const invalid = () => Object.assign(new Error("Invalid recall scope."), { code: "invalid" });
  if (!parsed.success) throw invalid();
  const { layer = "all", source_id = null, role = null, from = null, until = null } = parsed.data;
  if (from && until && Date.parse(from) > Date.parse(until)) throw invalid();
  if (layer === "nodes" && (source_id || role)) throw invalid();
  return {
    layer: source_id || role ? "evidence" : layer,
    source_id: source_id?.toLowerCase() ?? null, role,
    from: from ? new Date(from).toISOString() : null,
    until: until ? new Date(until).toISOString() : null,
  };
}
