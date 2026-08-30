import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A chat turn that has not answered in three minutes is hung, not thinking.
// Deliberately not the ingest route's ten minutes: that is a batch job, this
// is someone waiting at a text box.
const TURN_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// The companion talks; it never touches the machine. The spawned session gets
// an empty tool set, which is what keeps the brain's only write path a POST
// /api/nodes behind Tony's explicit click.
//
// The sandbox is a default-CLOSED allow-list, not a deny-list. Measured on CLI
// 2.1.223:
//   --allowedTools ADDS permissions, it does not restrict (an allowlist of
//     "just brain.mjs" still ran `echo HACKED`).
//   --permission-mode manual did not help, because the user-level defaultMode
//     "auto" approves whatever a list misses.
//   --disallowedTools <names> removes named tools -- but a deny-list is
//     default-open: with a hand-maintained list of ~28 tools the session still
//     exposed CronList, DesignSync, ReportFindings, ScheduleWakeup, TaskGet,
//     and TaskList (DesignSync reaches the network and the user's cloud
//     account), and any tool a future CLI adds would be granted silently.
//   --tools "" yields "tools":[] -- an empty set, verified via the init event.
//     A new CLI tool is then excluded until someone opts it in.
// Slash commands run OUTSIDE the tool system, so an empty tool set does not
// stop them: `/context` leaks absolute paths and memory files, `/config`
// mutates config. --disable-slash-commands closes that surface.
const SANDBOX_FLAGS = [
  "--tools",
  "",
  "--disable-slash-commands",
  // Ignore the permissive user-level settings (defaultMode "auto") and every
  // configured MCP server; both can hand the session capabilities the empty
  // tool set was meant to withhold. Note: --setting-sources project still
  // loads a project .claude/settings.json if one ever lands (hooks included);
  // there is none today, and that invariant is worth keeping.
  "--setting-sources",
  "project",
  "--strict-mcp-config",
];

// App secrets that must never reach the sandboxed subprocess. execFile inherits
// the server's env by default, and the Next server has loaded .env.local, so
// without this the child `claude` would hold the brain's Postgres credentials.
// Add any new .env.local secret here; claude itself needs none of them.
const STRIPPED_ENV_KEYS = ["DATABASE_URL"];

// Per-node caps on what goes into the snapshot. The brain is human-curated and
// small by design, but one pasted transcript must never be able to push a turn
// past the model's context or slow every later turn in the session.
const SNAPSHOT_TEXT_CAP = 4000;
const SNAPSHOT_TOTAL_CAP = 200_000;

export type BrainNodeRow = {
  id: string;
  type: string | null;
  title: string;
  body: string;
  raw: string;
  created_at: string | Date;
};

export type BrainEdgeRow = { source: string; target: string; why: string };

export type NodeDraft = {
  type: string;
  title: string;
  raw: string;
  body: string;
  connections: { targetId: string; why: string }[];
};

export type CompanionResult =
  | { ok: true; reply: string; drafts: NodeDraft[]; sessionId: string }
  | { ok: false; error: string; busy?: boolean };

type ExecOpts = { cwd: string; env?: NodeJS.ProcessEnv };
type ExecFn = (cmd: string, args: string[], opts: ExecOpts) => Promise<{ stdout: string }>;
type SubprocessError = { code?: string; message?: string; stderr?: string; stdout?: string };

// State that must survive Next's dev hot-reload, cached on globalThis the same
// way lib/db.ts caches the pool. Two pieces live here:
//   inFlight -- one turn at a time; a module-scope flag alone would reset on
//     HMR and let two turns spawn concurrently.
//   sessions -- the set of session ids THIS route minted. A resumed turn skips
//     the system prompt (the original session carries it), so a client-supplied
//     id that we never issued would run without the no-tools / fence contract.
//     Resuming is therefore allowed only for ids we handed back.
const globalForCompanion = globalThis as unknown as {
  companionInFlight?: Promise<CompanionResult> | null;
  companionSessions?: Set<string>;
};
const sessions: Set<string> = (globalForCompanion.companionSessions ??= new Set());

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n[...truncated]` : text;
}

function isoDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

// The whole brain as text. The companion has no tools, so this snapshot is the
// only way it knows what Tony already told it -- it replaces the skill's
// "run brain.mjs index, then show the recent bodies" opening step with a read
// the route does deterministically before the model ever runs.
export function renderBrainSnapshot(nodes: BrainNodeRow[], edges: BrainEdgeRow[]): string {
  if (nodes.length === 0) return "The brain is empty. Nothing has been saved yet.";

  const titleById = new Map(nodes.map((n) => [n.id, n.title]));
  const lines: string[] = [`${nodes.length} nodes, ${edges.length} connections.`, ""];

  for (const node of nodes) {
    lines.push(`### ${node.title}`);
    lines.push(`id: ${node.id} | type: ${node.type || "untyped"} | saved: ${isoDay(node.created_at)}`);
    lines.push(`raw (his verbatim words): ${clip(node.raw, SNAPSHOT_TEXT_CAP)}`);
    // Only worth the tokens when the readable actually differs from the raw.
    if (node.body && node.body !== node.raw) {
      lines.push(`readable: ${clip(node.body, SNAPSHOT_TEXT_CAP)}`);
    }
    lines.push("");
  }

  if (edges.length > 0) {
    lines.push("## Connections");
    for (const edge of edges) {
      const from = titleById.get(edge.source) ?? edge.source;
      const to = titleById.get(edge.target) ?? edge.target;
      lines.push(`- ${from} -> ${to}: ${edge.why}`);
    }
  }

  return clip(lines.join("\n"), SNAPSHOT_TOTAL_CAP);
}

// Sent once, when the session is created; --resume carries it forward, which
// is why later turns cost a few hundred cache-creation tokens instead of tens
// of thousands.
export function buildSystemPrompt(
  nodes: BrainNodeRow[],
  edges: BrainEdgeRow[],
  styleGuide: string,
): string {
  return `You are Tony's brain companion, reached from the Fuzzy Brain web app instead of a terminal.
You already hold his whole brain. Talk like a friend who remembers everything, not a system reporting what it loaded.
Do not open with a recap or a summary of what you know. Just say hey and follow him.

## This session uses no tools

Tools are switched off on purpose, and you never use one here -- not even a tool that appears available.
Do not run commands, read files, write anywhere, search, schedule, or monitor anything, and do not discuss or audit the tool setup with Tony; it is not part of the conversation.
The brain below is everything you have, and it is enough.
Never say you saved, wrote, or looked something up. Claiming otherwise is the one thing that breaks trust here.

## How a thought gets saved (read this carefully -- it is different from the terminal)

This repo's notes describe saving through scripts/brain.mjs or direct database writes. Forget all of that here. You are in the web app, not a terminal, and none of those paths exist for you.
Your one and only way to save a thought is to write a fenced block into your reply. Do not mention brain.mjs, the terminal, tools you lack, "a session that can write," pasting elsewhere, or holding a thought for later -- none of that is real here and it only confuses him.

The fence is not you doing something to the machine. It is just text you write that the app renders as a card beside your words, showing both layers with a save button. Writing the fence IS proposing the save; his click IS the agreement. There is no earlier step and no spoken yes to wait for.

So the moment something he says is worth keeping, write one plain sentence naming it, then the fence, in the same reply. Do not render the raw and readable as prose or quotes yourself -- the card shows them. Just the sentence, then the fence, exactly like this and with nothing else inside it:

\`\`\`brain-node
{
  "type": "note",
  "title": "one line that names it",
  "raw": "his words, copied verbatim, not a paraphrase",
  "body": "the readable layer, drafted per the style rules below",
  "connections": [{ "targetId": "<id of an existing node above>", "why": "why these two connect" }]
}
\`\`\`

Rules that are not negotiable:
- raw must be his actual words, exactly as he typed them. No typo fixes, no grammar fixes, no tidying. If you did not hear him say it, it does not go in raw.
- Never propose a connection he has not agreed to, and never leave a why blank. One connection at a time; do not lay a web on him. Use "connections": [] when there is nothing to link.
- Propose at most a few small nodes rather than one mega-node, and keep capture talk at the end of the conversation, not in the middle of it.
- Nothing is saved until he clicks the card. If he says no, drop it without argument.

## The readable layer

${styleGuide}

## His brain right now

${renderBrainSnapshot(nodes, edges)}`;
}

// Pull the drafts out of the reply so the UI can render them as save cards and
// the prose stays clean. A malformed fence is dropped rather than thrown: a bad
// draft must never cost Tony the sentence the companion wrote around it.
export function extractDrafts(reply: string): { prose: string; drafts: NodeDraft[] } {
  const drafts: NodeDraft[] = [];
  const prose = reply.replace(/```brain-node\s*([\s\S]*?)```/g, (match, json: string) => {
    try {
      const parsed = JSON.parse(json.trim()) as Record<string, unknown>;
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const raw = typeof parsed.raw === "string" ? parsed.raw : "";
      // The same two gates the database enforces, checked before the card is
      // ever shown so a draft that could not save never gets offered.
      if (!title || !raw.trim()) return match;

      const connections = (Array.isArray(parsed.connections) ? parsed.connections : [])
        .map((c) => c as Record<string, unknown>)
        .filter((c) => typeof c?.targetId === "string" && typeof c?.why === "string")
        .map((c) => ({ targetId: (c.targetId as string).trim(), why: (c.why as string).trim() }))
        .filter((c) => c.targetId && c.why);

      drafts.push({
        type: typeof parsed.type === "string" ? parsed.type.trim() : "",
        title,
        raw,
        body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body : raw,
        connections,
      });
      return "";
    } catch {
      return match;
    }
  });

  return { prose: prose.replace(/\n{3,}/g, "\n\n").trim(), drafts };
}

// Never forward raw subprocess output: it can carry absolute paths, the
// Postgres host from the environment, and whatever Tony just typed. Same rule
// as lib/ingest.ts, and it matters more here because the payload is his words.
function translateError(err: unknown): string {
  console.error("[companion] turn failed:", err);
  const { code, message, stderr, stdout } = (err ?? {}) as SubprocessError;
  const text = `${stderr ?? ""}\n${stdout ?? ""}\n${message ?? ""}`;

  if (code === "ETIMEDOUT") {
    return "The companion took too long to answer and was stopped. Say it again -- the conversation is still there.";
  }
  if (code === "ENOENT") {
    return "Could not find the claude command. The companion needs Claude Code installed and on PATH.";
  }
  if (/usage limit|rate.?limit|quota/i.test(text)) {
    return "Claude usage limit reached. This runs on your subscription, so it will come back when the limit resets -- nothing was charged.";
  }
  if (/no conversation found|session.*not found/i.test(text)) {
    return "That conversation expired. Start a new talk and the brain will load fresh.";
  }
  return "The companion could not answer. Check the server log for details.";
}

// One turn of conversation. Spawns Claude Code headlessly in the repo root so
// it inherits CLAUDE.md and AGENTS.md, with every tool denied.
export async function runCompanionTurn(
  input: { message: string; sessionId?: string | null },
  deps: { execFn?: ExecFn; systemPrompt?: () => string; cwd?: string } = {},
): Promise<CompanionResult> {
  const message = input.message?.trim() ?? "";
  if (!message) return { ok: false, error: "Say something first." };

  if (globalForCompanion.companionInFlight) {
    return {
      ok: false,
      error: "The companion is still answering. Give it a moment.",
      busy: true,
    };
  }

  // Resume only a session this route minted. An unknown id would run without
  // the system-prompt contract that only exists on sessions we created.
  const resuming = Boolean(input.sessionId);
  if (resuming && !sessions.has(input.sessionId as string)) {
    return { ok: false, error: "That conversation expired. Start a new talk and the brain will load fresh." };
  }

  const execFn: ExecFn =
    deps.execFn ??
    ((cmd, args, opts) =>
      execFileAsync(cmd, args, {
        ...opts,
        encoding: "utf8",
        timeout: TURN_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      }));

  const sessionId = resuming ? (input.sessionId as string) : randomUUID();

  const args = ["--print", "--output-format", "json"];
  if (resuming) {
    args.push("--resume", sessionId);
  } else {
    // The system prompt rides the session, so it is paid for once here and
    // carried by --resume on every later turn.
    args.push("--session-id", sessionId, "--append-system-prompt", deps.systemPrompt?.() ?? "");
  }
  args.push(...SANDBOX_FLAGS);
  // The message goes last, after a `--` terminator, so a message that starts
  // with `-` cannot be parsed as a CLI flag (argv injection into the very
  // flags that enforce the sandbox). Everything after `--` is positional, so
  // the message must be the final argument.
  args.push("--", message);

  // Inherit the server env but strip the app secrets: the sandbox must not hand
  // the child the brain's database credentials.
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];

  const run = (async (): Promise<CompanionResult> => {
    try {
      const { stdout } = await execFn("claude", args, { cwd: deps.cwd ?? process.cwd(), env });
      const payload = JSON.parse(stdout) as {
        is_error?: boolean;
        result?: string;
        session_id?: string;
      };
      if (payload.is_error || typeof payload.result !== "string") {
        return { ok: false, error: translateError({ stdout }) };
      }
      const { prose, drafts } = extractDrafts(payload.result);
      // Remember the id we can resume. The CLI usually echoes the same id we
      // pinned, but trust its value if it differs.
      const finalId = payload.session_id || sessionId;
      sessions.add(finalId);
      return { ok: true, reply: prose, drafts, sessionId: finalId };
    } catch (err) {
      return { ok: false, error: translateError(err) };
    }
  })();

  globalForCompanion.companionInFlight = run;
  try {
    return await run;
  } finally {
    globalForCompanion.companionInFlight = null;
  }
}
