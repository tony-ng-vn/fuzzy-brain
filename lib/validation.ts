export type ConnectionInput = { targetId: string; why: string };
export type NodeInput = { type: string; title: string; body: string; connections: ConnectionInput[] };

type Result = { ok: true; value: NodeInput } | { ok: false; error: string };

// Shared by the API route and tests. The why rule lives here as well as in the
// database CHECK constraint: a connection without a reason is rejected early.
export function validateNodeInput(raw: unknown): Result {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "body must be a JSON object" };
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type.trim() : "";
  const title = typeof r.title === "string" ? r.title.trim() : "";
  const body = typeof r.body === "string" ? r.body : "";
  if (!type) return { ok: false, error: "type is required" };
  if (!title) return { ok: false, error: "title is required" };

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
  return { ok: true, value: { type, title, body, connections } };
}
