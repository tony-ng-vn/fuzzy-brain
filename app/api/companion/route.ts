import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { buildSystemPrompt, runCompanionTurn } from "@/lib/companion";

// A single turn is one paste at most; anything past this is a mistake or an
// accident, and it would be paid for on every later turn in the session.
const MAX_MESSAGE_CHARS = 20_000;

// The bridge spawns a process, so it is localhost-only on purpose. The real
// boundary is the socket: the dev/start scripts bind to 127.0.0.1 (see
// package.json), so nothing off this machine can connect at all. This Host
// check is defense-in-depth on top of that -- a Host header is trivially
// spoofable by a non-browser client, so it is NOT a boundary on its own; it
// only catches a misconfiguration where the server was bound to the LAN.
function isLocalRequest(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function loadStyleGuide(): Promise<string> {
  try {
    return await readFile(join(process.cwd(), "docs", "writing-style.md"), "utf8");
  } catch {
    // The companion still works without it; it just drafts a plainer readable.
    console.error("[companion] writing-style.md missing, drafting without it");
    return "Describe what the raw says and quote his phrases verbatim. Never interpret.";
  }
}

// POST /api/companion -- one turn with the brain companion.
//
// The custom header is a CSRF guard, matching /api/ingest: it forces a
// preflight that a page on another origin cannot pass, so no site open in
// another tab can drive this.
export async function POST(request: Request) {
  if (request.headers.get("x-fuzzy-brain-companion") !== "1") {
    return NextResponse.json({ error: "missing required companion header" }, { status: 403 });
  }
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "the companion is available on localhost only" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { message, sessionId } = (payload ?? {}) as { message?: unknown; sessionId?: unknown };
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `that is longer than one turn can carry (${MAX_MESSAGE_CHARS} characters)` },
      { status: 400 },
    );
  }
  const resumeId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;

  // Only a new session pays for the snapshot; a resumed one already holds it.
  let systemPrompt = () => "";
  if (!resumeId) {
    try {
      const [nodes, edges, styleGuide] = await Promise.all([
        pool.query("select id, type, title, body, raw, created_at from nodes order by created_at"),
        pool.query("select source, target, why from edges order by created_at"),
        loadStyleGuide(),
      ]);
      systemPrompt = () => buildSystemPrompt(nodes.rows, edges.rows, styleGuide);
    } catch (err) {
      console.error("[companion] could not load the brain:", err);
      return NextResponse.json({ error: "Cannot reach the brain right now." }, { status: 503 });
    }
  }

  const result = await runCompanionTurn({ message, sessionId: resumeId }, { systemPrompt });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.busy ? 409 : 502 });
  }
  return NextResponse.json(
    { reply: result.reply, drafts: result.drafts, sessionId: result.sessionId },
    { status: 200 },
  );
}
