import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { validateNodeInput } from "@/lib/validation";

// POST /api/nodes -- create a node and its connections in one transaction,
// so a rejected edge (blank why, bad target) never leaves an orphan node.
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = validateNodeInput(payload);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { type, title, body, raw, connections, deadlineAt, deadlineOrigin } = parsed.value;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      "insert into nodes (type, title, body, raw) values ($1, $2, $3, $4) returning id, type, title, body, raw, created_at",
      [type, title, body, raw],
    );
    const node = rows[0];
    if (deadlineAt) {
      await client.query(
        `insert into node_temporal_events (node_id, event_type, value_at, raw, origin)
         values ($1, 'deadline_set', $2, $3, $4)`,
        [node.id, deadlineAt, raw, deadlineOrigin],
      );
    }
    const edges = [];
    for (const c of connections) {
      const res = await client.query(
        "insert into edges (source, target, why) values ($1, $2, $3) returning id, source, target, why, created_at",
        [node.id, c.targetId, c.why],
      );
      edges.push(res.rows[0]);
    }
    await client.query("commit");
    return NextResponse.json({ node: { ...node, due_at: deadlineAt }, edges }, { status: 201 });
  } catch (err) {
    await client.query("rollback");
    const message = err instanceof Error ? err.message : String(err);
    const clientFault = /foreign key|check constraint|invalid input syntax/i.test(message);
    return NextResponse.json({ error: message }, { status: clientFault ? 400 : 503 });
  } finally {
    client.release();
  }
}
