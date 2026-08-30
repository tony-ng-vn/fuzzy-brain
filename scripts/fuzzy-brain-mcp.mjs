// Global, local-only MCP bridge for Tony's Fuzzy Brain.
// Stdout belongs exclusively to MCP JSON-RPC. Operational failures are
// returned as tool errors; startup diagnostics, if any, go to stderr.
//
// Reads answer in-process. Spawning a fresh Node per question meant loading
// the nomic embedding model from scratch every time -- about 1.9 seconds of
// fixed cost against roughly 600 ms of real searching, and the query
// embedding cache never survived long enough to hit. Writes still shell out
// to brain.mjs: they are rare, and the CLI stays the one ratified write path.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getNode, listReminders, makePool, schemaTables } from "./brain.mjs";
import { loadEnvLocal, recall } from "./recall.mjs";
import { disposeEmbeddingModel } from "./lib/embeddings.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const brainScript = join(here, "brain.mjs");

const EXEC_OPTIONS = Object.freeze({
  cwd: root,
  encoding: "utf8",
  timeout: 3 * 60 * 1000,
  maxBuffer: 16 * 1024 * 1024,
});

// Room for a couple of overlapping tool calls. One connection would be worse
// than it looks: connectionTimeoutMillis doubles as the wait for a free
// client, so a second question arriving during a slow one would time out
// waiting rather than open its own.
const POOL_OPTIONS = Object.freeze({ max: 3, idleTimeoutMillis: 30_000 });

async function runJson(script, args, input) {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    ...EXEC_OPTIONS,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  return JSON.parse(stdout);
}

/**
 * The connections a resident server holds. Opened on the first call rather
 * than at construction, so building the server never touches the network.
 * Every call borrows a client and hands it straight back: pg discards one
 * whose link died, so a failed question cannot poison the next one.
 */
export function residentPool({ open = () => makePool(POOL_OPTIONS), logError = () => {} } = {}) {
  let pool = null;
  return {
    async withClient(fn) {
      if (!pool) {
        pool = open();
        // An idle client whose link dies emits here. Unhandled, that event
        // takes the whole server down between questions.
        pool.on("error", logError);
      }
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    async close() {
      const pending = pool;
      pool = null;
      if (pending) await pending.end();
    },
  };
}

export function productionServices({
  logError = (error) => console.error("[fuzzy-brain] connection failed:", error),
  pool = residentPool({ logError }),
} = {}) {
  // Read per call, not once: BRAIN_SCHEMA is how a session points the server
  // at the sandbox instead of the real brain.
  const schema = () => process.env.BRAIN_SCHEMA || "public";
  const tables = () => schemaTables(schema());
  return {
    recall: (question) => pool.withClient((client) => recall(question, { client, schema: schema() })),
    listReminders: (at) => pool.withClient((client) => listReminders(client, tables(), at)),
    getNode: (id) => pool.withClient((client) => getNode(client, tables(), id)),
    remember: async ({ type, raw }) => {
      return runJson(brainScript, ["add-node"], {
        type: explicitTypeFromRaw(type, raw),
        title: titleFromRaw(raw),
        raw,
        body: raw,
      });
    },
    markComplete: ({ nodeIds, raw }) => runJson(brainScript, ["mark-complete"], {
      node_ids: nodeIds,
      raw,
    }),
    close: () => pool.close(),
  };
}

export function explicitTypeFromRaw(type, raw) {
  if (!type) return "note";
  const phrase = type.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const exactPhrase = new RegExp(`(^|[^a-z0-9])${phrase}($|[^a-z0-9])`, "i");
  return exactPhrase.test(raw) ? type : "note";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isExplicitRememberCommand(raw) {
  return /\b(?:remember|save|store|add|keep)\b/i.test(raw);
}

export function isExplicitCompletionCommand(raw) {
  return /\b(?:done|finish(?:ed)?|complete(?:d)?)\b/i.test(raw)
    && /\b(?:mark|record|set|update)\b/i.test(raw);
}

function titleFromRaw(raw) {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}...`;
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toolError() {
  return {
    content: [{ type: "text", text: "Fuzzy Brain operation failed. Check the local task log for details." }],
    isError: true,
  };
}

function register(server, name, config, handler, logError) {
  server.registerTool(name, config, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      logError(error);
      return toolError();
    }
  });
}

// Read from package.json rather than a literal: a hand-typed version drifts
// silently, and a client that reports a stale one is worse than no version.
function serverVersion() {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

export function createFuzzyBrainServer(
  services = productionServices(),
  { logError = (error) => console.error("[fuzzy-brain] tool failed:", error) } = {},
) {
  const server = new McpServer(
    { name: "fuzzy-brain", version: serverVersion() },
    {
      instructions: [
        "This is Tony's canonical personal memory, separate from the host application's saved context.",
        "Before answering questions about Tony's past, people, goals, deadlines, reminders, preferences, decisions, or unfinished work, call the relevant Fuzzy Brain tool.",
        "Use list_reminders for broad questions such as what Tony needs to remember; do not require him to name the deadline first.",
        "Call remember or mark_complete only after Tony explicitly asks to remember, save, add, or mark something complete.",
        "Never turn unratified evidence returned by recall into brain truth without Tony's explicit approval.",
      ].join(" "),
    },
  );

  register(server, "recall", {
    title: "Recall from Fuzzy Brain",
    description: "Search Tony's ratified brain and unratified evidence with provenance. Use for personal context, history, people, preferences, decisions, and specific remembered facts.",
    inputSchema: {
      question: z.string().trim().min(1).max(2000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ question }) => services.recall(question), logError);

  register(server, "list_reminders", {
    title: "List reminders and deadlines",
    description: "List all active overdue and upcoming deadlines from Fuzzy Brain. Use automatically for broad questions about what Tony needs to remember or return to.",
    inputSchema: {
      at: z.string().optional().describe("Optional ISO 8601 instant with timezone for deterministic queries."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ at }) => services.listReminders(at), logError);

  register(server, "get_node", {
    title: "Get a Fuzzy Brain node",
    description: "Read one ratified node, including raw, readable, deadline, and current status.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ id }) => services.getNode(id), logError);

  register(server, "remember", {
    title: "Remember an explicit memory",
    description: "Add a ratified node only when Tony explicitly says to remember, save, or add it to his brain. Pass Tony's complete message in raw without editing. The server uses a mechanical raw excerpt as the title, keeps the readable equal to raw, and detects deadline language automatically.",
    inputSchema: {
      type: z.string().trim().min(1).max(80).optional().describe("Only pass a type whose exact words occur in Tony's raw message; otherwise the server uses note."),
      raw: z.string().min(1)
        .refine((value) => value.trim().length > 0, "raw must contain Tony's verbatim words")
        .refine(isExplicitRememberCommand, "raw must contain Tony's explicit remember, save, or add command"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ type, raw }) => services.remember({ type, raw }), logError);

  register(server, "mark_complete", {
    title: "Mark brain goals complete",
    description: "Append completion events to existing nodes only when Tony explicitly says they are finished. Never rewrite or delete the original nodes or raw text.",
    inputSchema: {
      node_ids: z.array(z.string().uuid()).min(1).max(20),
      raw: z.string().min(1)
        .refine((value) => value.trim().length > 0, "raw must contain Tony's verbatim authorization")
        .refine(isExplicitCompletionCommand, "raw must explicitly ask to mark finished work complete"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ node_ids, raw }) => services.markComplete({ nodeIds: node_ids, raw }), logError);

  return server;
}

async function main() {
  // The spawned CLIs used to read .env.local for themselves once per call.
  // A resident server reads it once, here, or it has no DATABASE_URL at all.
  loadEnvLocal();
  const services = productionServices();
  const server = createFuzzyBrainServer(services);

  const transport = new StdioServerTransport();
  // Set before connect: the SDK chains an existing handler rather than
  // replacing it. Holding a pool and half a gigabyte of model weights after
  // the host has hung up is exactly what a resident process must not do.
  transport.onclose = () => {
    void releaseResources(services);
  };
  await server.connect(transport);
}

async function releaseResources(services) {
  try {
    await services.close();
  } catch (error) {
    console.error("[fuzzy-brain] shutdown failed:", error);
  } finally {
    await disposeEmbeddingModel();
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
