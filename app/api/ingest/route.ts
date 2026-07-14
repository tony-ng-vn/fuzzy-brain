import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";

// POST /api/ingest -- manually triggers the same session ingester the CLI
// runs (scripts/ingest-sessions.mjs). No new write path: this shells out
// to the one script that already owns every ingestion guard.
export async function POST() {
  const result = runIngest();
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ output: result.output }, { status: 200 });
}
