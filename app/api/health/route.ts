import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

// GET /api/health -- verifies the database connection is alive.
export async function GET() {
  try {
    const { rows } = await pool.query("select 1 as ok");
    return NextResponse.json({ ok: rows[0].ok === 1, database: "up" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, database: "down", error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
