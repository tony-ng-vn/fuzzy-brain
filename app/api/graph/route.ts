import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

// GET /api/graph -- the entire brain: all nodes and all edges.
// The graph is small by design (human-curated), so one full read is fine.
export async function GET() {
  try {
    const [nodes, edges] = await Promise.all([
      pool.query("select id, type, title, body, created_at from nodes order by created_at"),
      pool.query("select id, source, target, why, created_at from edges order by created_at"),
    ]);
    return NextResponse.json({ nodes: nodes.rows, edges: edges.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
