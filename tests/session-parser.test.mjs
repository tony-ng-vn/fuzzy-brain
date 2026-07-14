// Unit tests for the Claude Code session transcript parser. No database,
// no filesystem: fixtures are inline JSONL strings shaped like the real
// transcript entries (verified against a live transcript, 2026-07-13).
// The parser's one meaning-integrity job: nothing machine-injected may
// ever render as Tony's words (ADR 0002; issue #12 plan point 4).
import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeSession } from "../scripts/lib/session-parser.mjs";

function jsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function userEntry(content, extra = {}) {
  return {
    type: "user",
    timestamp: "2026-07-10T09:00:00.000Z",
    sessionId: SESSION_ID,
    cwd: "/Users/tony/Desktop/fuzzy-brain",
    message: { role: "user", content },
    ...extra,
  };
}

function assistantEntry(blocks, extra = {}) {
  return {
    type: "assistant",
    timestamp: "2026-07-10T09:01:00.000Z",
    sessionId: SESSION_ID,
    cwd: "/Users/tony/Desktop/fuzzy-brain",
    message: { role: "assistant", content: blocks },
    ...extra,
  };
}

test("parses a plain conversation into turns with exact offsets", () => {
  const text = jsonl([
    userEntry("hello, i want to talk about the trip"),
    assistantEntry([{ type: "text", text: "tell me about it" }]),
  ]);
  const out = parseClaudeSession(text);
  assert.equal(out.sessionId, SESSION_ID);
  assert.equal(out.spans.length, 2);
  assert.equal(out.spans[0].speaker, "tony");
  assert.equal(out.spans[0].text, "hello, i want to talk about the trip");
  assert.equal(out.spans[1].speaker, "assistant");
  // The span invariant the evidence table enforces: quote is a substring
  // of raw at exactly [start, end).
  for (const s of out.spans) {
    assert.equal(out.raw.slice(s.start, s.end), s.text);
  }
});

test("strips injected system-reminder content from user turns, keeping the human text", () => {
  const text = jsonl([
    userEntry("real words from tony <system-reminder>machine noise here</system-reminder> more real words"),
    assistantEntry([{ type: "text", text: "ok" }]),
  ]);
  const out = parseClaudeSession(text);
  assert.equal(out.spans[0].text, "real words from tony  more real words");
  assert.ok(!out.raw.includes("machine noise"));
  assert.ok(!out.raw.includes("system-reminder"));
});

test("skips user turns that are pure machine injection", () => {
  const text = jsonl([
    userEntry("<system-reminder>only noise</system-reminder>"),
    userEntry(
      "<local-command-caveat>Caveat: local commands</local-command-caveat>\n<command-name>/model</command-name>\n<local-command-stdout>Set model</local-command-stdout>",
    ),
    userEntry("a real thought"),
    assistantEntry([{ type: "text", text: "noted" }]),
  ]);
  const out = parseClaudeSession(text);
  assert.equal(out.spans.length, 2);
  assert.equal(out.spans[0].text, "a real thought");
});

test("skips meta, sidechain, compact-summary, and api-error entries", () => {
  const text = jsonl([
    userEntry("injected context", { isMeta: true }),
    userEntry("subagent chatter", { isSidechain: true }),
    userEntry("compacted", { isCompactSummary: true }),
    assistantEntry([{ type: "text", text: "errored" }], { isApiErrorMessage: true }),
    userEntry("the only real turn"),
    assistantEntry([{ type: "text", text: "yes" }]),
  ]);
  const out = parseClaudeSession(text);
  assert.equal(out.spans.length, 2);
  assert.equal(out.spans[0].text, "the only real turn");
});

test("keeps assistant text blocks only: thinking never becomes evidence, tool calls become a marker", () => {
  const text = jsonl([
    userEntry("do the thing"),
    assistantEntry([
      { type: "thinking", thinking: "secret internal reasoning" },
      { type: "tool_use", id: "t1", name: "Bash", input: {} },
    ]),
    assistantEntry([{ type: "tool_use", id: "t2", name: "Read", input: {} }]),
    assistantEntry([{ type: "text", text: "done, here is the answer" }]),
  ]);
  const out = parseClaudeSession(text);
  assert.ok(!out.raw.includes("secret internal reasoning"));
  assert.ok(out.raw.includes("[2 tool calls omitted]"));
  const speakers = out.spans.map((s) => s.speaker);
  assert.deepEqual(speakers, ["tony", "assistant"]);
  // The marker is rendering context, not evidence: no span covers it.
  for (const s of out.spans) assert.ok(!s.text.includes("tool calls omitted"));
});

test("user tool_result and image blocks are not tony's words", () => {
  const text = jsonl([
    userEntry([{ type: "tool_result", tool_use_id: "t1", content: "command output text" }]),
    userEntry([
      { type: "text", text: "look at this" },
      { type: "image", source: {} },
    ]),
    assistantEntry([{ type: "text", text: "looking" }]),
  ]);
  const out = parseClaudeSession(text);
  assert.equal(out.spans.length, 2);
  assert.equal(out.spans[0].text, "look at this");
  assert.ok(!out.raw.includes("command output text"));
});

test("carries session metadata: cwd, occurred bounds from first and last kept turns", () => {
  const text = jsonl([
    userEntry("first", {}),
    assistantEntry([{ type: "text", text: "last" }], { timestamp: "2026-07-10T10:30:00.000Z" }),
  ]);
  const out = parseClaudeSession(text);
  assert.equal(out.cwd, "/Users/tony/Desktop/fuzzy-brain");
  assert.equal(out.occurredAt, "2026-07-10T09:00:00.000Z");
  assert.equal(out.occurredUntil, "2026-07-10T10:30:00.000Z");
});

test("a session with no real tony turns parses to null", () => {
  const text = jsonl([
    userEntry("<system-reminder>noise</system-reminder>"),
    assistantEntry([{ type: "text", text: "automation output" }]),
  ]);
  assert.equal(parseClaudeSession(text), null);
});

test("tolerates malformed lines and unknown entry types without crashing", () => {
  const text = [
    "not json at all {{{",
    JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
    JSON.stringify({ type: "queue-operation", operation: "x" }),
    JSON.stringify(userEntry("still works")),
    JSON.stringify(assistantEntry([{ type: "text", text: "indeed" }])),
  ].join("\n");
  const out = parseClaudeSession(text);
  assert.equal(out.spans.length, 2);
  assert.equal(out.spans[0].text, "still works");
});
