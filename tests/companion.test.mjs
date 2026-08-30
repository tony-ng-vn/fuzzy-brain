// Unit tests for the companion bridge's logic (lib/companion.ts). Matches
// the repo's pattern: the route stays a thin pass-through; the logic --
// snapshot rendering, draft extraction, the spawn contract, the busy lock,
// error translation -- gets tested directly with an injected exec.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  extractDrafts,
  renderBrainSnapshot,
  runCompanionTurn,
} from "../lib/companion.ts";

const NODE = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "note",
  title: "Haven: working vision and principles",
  body: "Tony wants the vision work stored.",
  raw: "i think we will need to store it.",
  created_at: "2026-08-02T10:00:00.000Z",
};

const EDGE = {
  source: NODE.id,
  target: NODE.id,
  why: "a test edge that points home",
};

function okPayload(result, sessionId = "abc-123") {
  return JSON.stringify({ is_error: false, result, session_id: sessionId });
}

test("renderBrainSnapshot carries both layers, ids, and the edge whys", () => {
  const snapshot = renderBrainSnapshot([NODE], [EDGE]);
  assert.match(snapshot, /Haven: working vision and principles/);
  assert.match(snapshot, /i think we will need to store it\./);
  assert.match(snapshot, /Tony wants the vision work stored\./);
  assert.match(snapshot, new RegExp(NODE.id));
  assert.match(snapshot, /a test edge that points home/);
});

test("renderBrainSnapshot skips the readable when it just repeats the raw", () => {
  const snapshot = renderBrainSnapshot([{ ...NODE, body: NODE.raw }], []);
  assert.ok(!snapshot.includes("readable:"), "identical body must not be repeated");
});

test("renderBrainSnapshot caps a pathological node instead of shipping it whole", () => {
  const huge = { ...NODE, raw: "x".repeat(50_000) };
  const snapshot = renderBrainSnapshot([huge], []);
  assert.ok(snapshot.length < 10_000, `snapshot should be capped, got ${snapshot.length}`);
  assert.match(snapshot, /\[\.\.\.truncated\]/);
});

test("buildSystemPrompt embeds the style guide and the no-tools contract", () => {
  const prompt = buildSystemPrompt([NODE], [], "STYLE-GUIDE-MARKER");
  assert.match(prompt, /STYLE-GUIDE-MARKER/);
  assert.match(prompt, /Tools are switched off/);
  assert.match(prompt, /brain-node/);
});

test("extractDrafts pulls a well-formed draft and cleans the prose", () => {
  const reply = [
    "This one feels like a keeper.",
    "```brain-node",
    JSON.stringify({
      type: "note",
      title: "A keeper",
      raw: "exactly what tony typed",
      body: "Tony said a thing.",
      connections: [{ targetId: NODE.id, why: "because it rhymes" }],
    }),
    "```",
    "Want me to set it aside instead?",
  ].join("\n");

  const { prose, drafts } = extractDrafts(reply);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].title, "A keeper");
  assert.equal(drafts[0].raw, "exactly what tony typed");
  assert.equal(drafts[0].connections[0].why, "because it rhymes");
  assert.ok(!prose.includes("brain-node"), "the fence must leave the prose");
  assert.match(prose, /keeper/);
  assert.match(prose, /set it aside/);
});

test("extractDrafts drops drafts that could not save: blank raw, blank title, bad JSON", () => {
  const blankRaw = "```brain-node\n" + JSON.stringify({ title: "t", raw: "   " }) + "\n```";
  const blankTitle = "```brain-node\n" + JSON.stringify({ title: "", raw: "words" }) + "\n```";
  const badJson = "```brain-node\n{not json}\n```";

  assert.equal(extractDrafts(blankRaw).drafts.length, 0);
  assert.equal(extractDrafts(blankTitle).drafts.length, 0);
  assert.equal(extractDrafts(badJson).drafts.length, 0);
  // A malformed fence stays visible rather than vanishing silently.
  assert.match(extractDrafts(badJson).prose, /not json/);
});

test("extractDrafts strips a connection with a blank why instead of offering it", () => {
  const reply =
    "```brain-node\n" +
    JSON.stringify({
      title: "t",
      raw: "words",
      connections: [{ targetId: NODE.id, why: "  " }],
    }) +
    "\n```";
  const { drafts } = extractDrafts(reply);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].connections.length, 0);
});

test("a new session spawns claude default-closed: empty tool set, no slash commands, snapshot aboard", async () => {
  let seen;
  const execFn = async (cmd, args, opts) => {
    seen = { cmd, args, opts };
    return { stdout: okPayload("hey") };
  };

  const result = await runCompanionTurn(
    { message: "hello" },
    { execFn, systemPrompt: () => "SYSTEM-MARKER" },
  );

  assert.equal(result.ok, true);
  assert.equal(seen.cmd, "claude");
  assert.ok(seen.args.includes("--print"));
  assert.ok(seen.args.includes("--session-id"), "a new session must pin its id");
  assert.ok(!seen.args.includes("--resume"));
  assert.equal(seen.args[seen.args.indexOf("--append-system-prompt") + 1], "SYSTEM-MARKER");
  // The sandbox: an empty tool set (default-closed), no slash commands, no
  // user settings, no MCP servers.
  assert.equal(seen.args[seen.args.indexOf("--tools") + 1], "", "--tools must be empty");
  assert.ok(seen.args.includes("--disable-slash-commands"), "slash commands must be off");
  assert.ok(seen.args.includes("--strict-mcp-config"), "MCP servers must not leak in");
  assert.equal(seen.args[seen.args.indexOf("--setting-sources") + 1], "project");
  // No deny-list flag survives -- the sandbox is an allow-list now.
  assert.ok(!seen.args.includes("--disallowedTools"), "deny-list must be gone");
});

test("the message rides after a -- terminator so a leading dash cannot become a flag", async () => {
  let seen;
  const execFn = async (_cmd, args) => {
    seen = args;
    return { stdout: okPayload("ok") };
  };

  await runCompanionTurn({ message: "--dangerously-skip-permissions" }, { execFn, systemPrompt: () => "" });
  const dashDash = seen.indexOf("--");
  assert.ok(dashDash !== -1, "a -- terminator must be present");
  assert.equal(seen[seen.length - 1], "--dangerously-skip-permissions", "message must be the last arg");
  assert.equal(seen.indexOf("--dangerously-skip-permissions"), seen.length - 1, "message must appear only as the positional");
});

test("the subprocess env is stripped of the database credential", async () => {
  const priorUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://secret:secret@host/db";
  try {
    let seenEnv;
    const execFn = async (_cmd, _args, opts) => {
      seenEnv = opts.env;
      return { stdout: okPayload("ok") };
    };
    await runCompanionTurn({ message: "hi" }, { execFn, systemPrompt: () => "" });
    assert.ok(seenEnv, "an env must be passed explicitly");
    assert.equal(seenEnv.DATABASE_URL, undefined, "DATABASE_URL must never reach the child");
    assert.equal(seenEnv.PATH, process.env.PATH, "the rest of the env is inherited so claude can run");
  } finally {
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
  }
});

test("a resumed session must be one this route minted, and skips the system prompt", async () => {
  let seen;
  const execFn = async (_cmd, args) => {
    seen = args;
    return { stdout: okPayload("welcome back", "minted-1") };
  };

  // An id we never issued is refused, and never spawns.
  let spawned = false;
  const rejects = await runCompanionTurn(
    { message: "hi again", sessionId: "forged-id" },
    {
      execFn: async () => {
        spawned = true;
        return { stdout: okPayload("x") };
      },
    },
  );
  assert.equal(rejects.ok, false);
  assert.equal(spawned, false, "a forged resume id must not spawn a process");

  // Mint one, then resume it.
  const first = await runCompanionTurn({ message: "hello" }, { execFn, systemPrompt: () => "S" });
  assert.equal(first.ok, true);
  const resumed = await runCompanionTurn({ message: "again", sessionId: first.sessionId }, { execFn });
  assert.equal(resumed.ok, true);
  assert.equal(seen[seen.indexOf("--resume") + 1], first.sessionId);
  assert.ok(!seen.includes("--append-system-prompt"), "resume must not resend the brain");
});

test("a second turn while one is running comes back busy instead of racing", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const execFn = async () => {
    await gate;
    return { stdout: okPayload("done") };
  };

  const first = runCompanionTurn({ message: "one" }, { execFn, systemPrompt: () => "" });
  const second = await runCompanionTurn({ message: "two" }, { execFn, systemPrompt: () => "" });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);

  release();
  const result = await first;
  assert.equal(result.ok, true);
});

test("failures translate to safe messages: timeout, missing binary, usage limit", async () => {
  const timeout = await runCompanionTurn(
    { message: "hi" },
    { execFn: async () => { throw { code: "ETIMEDOUT" }; }, systemPrompt: () => "" },
  );
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /too long/);

  const missing = await runCompanionTurn(
    { message: "hi" },
    { execFn: async () => { throw { code: "ENOENT" }; }, systemPrompt: () => "" },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /claude command/);

  const limit = await runCompanionTurn(
    { message: "hi" },
    {
      execFn: async () => {
        throw { code: 1, stderr: "Claude AI usage limit reached|1234567890" };
      },
      systemPrompt: () => "",
    },
  );
  assert.equal(limit.ok, false);
  assert.match(limit.error, /usage limit/i);
  assert.ok(!limit.error.includes("1234567890"), "raw stderr must not leak");
});

test("an empty message never spawns a process", async () => {
  let spawned = false;
  const execFn = async () => {
    spawned = true;
    return { stdout: okPayload("x") };
  };
  const result = await runCompanionTurn({ message: "   " }, { execFn });
  assert.equal(result.ok, false);
  assert.equal(spawned, false);
});
