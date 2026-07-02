import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { validateNodeInput } from "@/lib/validation";

// POST /api/nodes -- create a node and its connections in one transaction,
// so a rejected edge (blank why, bad target) never leaves an orphan node.
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = validateNodeInput(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { type, title, body, connections } = parsed.value;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      "insert into nodes (type, title, body) values ($1, $2, $3) returning id, type, title, body, created_at",
      [type, title, body],
    );
    const node = rows[0];
    const edges = [];
    for (const c of connections) {
      const res = await client.query(
        "insert into edges (source, target, why) values ($1, $2, $3) returning id, source, target, why, created_at",
        [node.id, c.targetId, c.why],
      );
      edges.push(res.rows[0]);
    }
    await client.query("commit");
    return NextResponse.json({ node, edges }, { status: 201 });
  } catch (err) {
    await client.query("rollback");
    const message = err instanceof Error ? err.message : String(err);
    const clientFault = /foreign key|check constraint|invalid input syntax/i.test(message);
    return NextResponse.json({ error: message }, { status: clientFault ? 400 : 503 });
  } finally {
    client.release();
  }
}
