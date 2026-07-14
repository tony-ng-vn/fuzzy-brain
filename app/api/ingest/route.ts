import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";

// POST /api/ingest -- manually triggers the same session ingester the CLI
// runs (scripts/ingest-sessions.mjs). No new write path: this shells out
// to the one script that already owns every ingestion guard.
//
// The custom header requirement is a CSRF guard, not an auth check: this
// route has no body, so a plain cross-origin <form> or fetch would ship
// as a browser "simple request" with no preflight, letting any page open
// in another tab silently trigger a sync. A required custom header forces
// a preflight, which a page on another origin cannot pass.
export async function POST(request: Request) {
  if (request.headers.get("x-fuzzy-brain-sync") !== "1") {
    return NextResponse.json({ error: "missing required sync header" }, { status: 403 });
  }

  const result = await runIngest();
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.alreadyRunning ? 409 : 500 });
  }
  return NextResponse.json({ output: result.output }, { status: 200 });
}
