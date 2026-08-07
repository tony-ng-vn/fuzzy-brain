import { inferDeadline } from "../scripts/lib/temporal.mjs";

export type ConnectionInput = { targetId: string; why: string };
export type NodeInput = {
  type: string;
  title: string;
  body: string;
  raw: string;
  connections: ConnectionInput[];
  deadlineAt: string | null;
  deadlineOrigin: "derived" | null;
};

type Result = { ok: true; value: NodeInput } | { ok: false; error: string };

// Shared by the API route and tests. The why rule lives here as well as in the
// database CHECK constraint: a connection without a reason is rejected early.
// Same for the raw rule: a node without its verbatim words is rejected early.
export function validateNodeInput(input: unknown, referenceDate = new Date()): Result {
  if (typeof input !== "object" || input === null) return { ok: false, error: "body must be a JSON object" };
  const r = input as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type.trim() : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  // raw is Tony's verbatim words: validated for substance, never trimmed or altered.
  const raw = typeof r.raw === "string" ? r.raw : "";
  if (!title) return { ok: false, error: "title is required" };
  if (!raw.trim()) return { ok: false, error: "raw is required: the node's verbatim words" };
  // A deliberately written thought is its own readable; body falls back to raw.
  const body = typeof r.body === "string" && r.body.trim() ? r.body : raw;

  const rawConnections = Array.isArray(r.connections) ? r.connections : [];
  const connections: ConnectionInput[] = [];
  for (const c of rawConnections) {
    if (typeof c !== "object" || c === null) return { ok: false, error: "each connection must be an object" };
    const cc = c as Record<string, unknown>;
    const targetId = typeof cc.targetId === "string" ? cc.targetId.trim() : "";
    const why = typeof cc.why === "string" ? cc.why.trim() : "";
    if (!targetId) return { ok: false, error: "connection targetId is required" };
    if (!why) return { ok: false, error: "every connection needs a why sentence" };
    connections.push({ targetId, why });
  }
  const deadline = inferDeadline({ type, title, text: raw, referenceDate });
  return {
    ok: true,
    value: {
      type,
      title,
      body,
      raw,
      connections,
      deadlineAt: deadline?.dueAt ?? null,
      deadlineOrigin: deadline ? "derived" : null,
    },
  };
}
