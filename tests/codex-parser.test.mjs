// Unit tests for the Codex rollout parser. Fixture entries mirror the real
// envelope surveyed on this machine (2026-07-14): {type, timestamp, payload},
// with response_item payloads of type message/reasoning/function_call/etc.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexSessionTurns } from "../scripts/lib/session-parser.mjs";
import { renderEpisode } from "../scripts/lib/session-parser.mjs";

const SESSION_ID = "0199aaaa-bbbb-cccc-dddd-eeeeffff0000";

function meta(cwd = "/Users/tony/Desktop/fuzzy-brain") {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-10T09:00:00.000Z",
    payload: { id: SESSION_ID, cwd, cli_version: "x", timestamp: "2026-07-10T09:00:00.000Z" },
  });
}

function item(payload, ts = "2026-07-10T09:01:00.000Z") {
  return JSON.stringify({ type: "response_item", timestamp: ts, payload });
}

function userMsg(text, ts) {
  return item({ type: "message", role: "user", content: [{ type: "input_text", text }] }, ts);
}

function assistantMsg(text, ts) {
  return item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }, ts);
}

test("parses codex turns with metadata from session_meta", () => {
  const text = [meta(), userMsg("hey codex, fix the bug"), assistantMsg("on it")].join("\n");
  const out = parseCodexSessionTurns(text);
  assert.equal(out.sessionId, SESSION_ID);
  assert.equal(out.cwd, "/Users/tony/Desktop/fuzzy-brain");
  assert.equal(out.turns.length, 2);
  assert.equal(out.turns[0].speaker, "tony");
  assert.equal(out.turns[1].speaker, "assistant");
  const { raw, spans } = renderEpisode(out.turns);
  for (const s of spans) assert.equal(raw.slice(s.start, s.end), s.text);
});

test("developer messages and reasoning payloads never become conversation", () => {
  const text = [
    meta(),
    item({ type: "message", role: "developer", content: [{ type: "input_text", text: "injected instructions" }] }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "internal chain of thought" }] }),
    userMsg("a real ask"),
    assistantMsg("a real answer"),
  ].join("\n");
  const out = parseCodexSessionTurns(text);
  assert.equal(out.turns.length, 2);
  const { raw } = renderEpisode(out.turns);
  assert.ok(!raw.includes("injected instructions"));
  assert.ok(!raw.includes("internal chain of thought"));
});

test("tool calls collapse into omitted markers", () => {
  const text = [
    meta(),
    userMsg("do it"),
    item({ type: "function_call", name: "shell", arguments: "{}" }),
    item({ type: "custom_tool_call", name: "apply_patch", input: "" }),
    item({ type: "web_search_call", action: {} }),
    assistantMsg("done"),
  ].join("\n");
  const out = parseCodexSessionTurns(text);
  const { raw, spans } = renderEpisode(out.turns);
  assert.ok(raw.includes("[3 tool calls omitted]"));
  assert.equal(spans.length, 2);
});

test("injected instruction tags inside user text are stripped", () => {
  const text = [
    meta(),
    userMsg("<user_instructions>machine block</user_instructions> my actual words <environment_context>env stuff</environment_context>"),
    assistantMsg("ok"),
  ].join("\n");
  const out = parseCodexSessionTurns(text);
  assert.equal(out.turns[0].text, "my actual words");
});

test("a codex session with no real user turns parses to null", () => {
  const text = [meta(), assistantMsg("automation only")].join("\n");
  assert.equal(parseCodexSessionTurns(text), null);
});

test("tolerates malformed lines and unknown payload types", () => {
  const text = [
    "garbage {{{",
    meta(),
    item({ type: "totally_new_payload", something: 1 }),
    userMsg("still here"),
    assistantMsg("yep"),
  ].join("\n");
  const out = parseCodexSessionTurns(text);
  assert.equal(out.turns.length, 2);
});
