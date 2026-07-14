// Parses a Claude Code session transcript (JSONL) into the evidence-store
// shape: a conversation-only rendering (episodes.raw) plus one span per
// turn (evidence rows), offsets exact by construction.
//
// Two disciplines govern everything here:
// - Meaning integrity: nothing machine-injected may render as Tony's words.
//   Harness-injected blocks inside user entries are stripped; meta,
//   sidechain, compact-summary, and api-error entries are skipped whole;
//   tool results and images are not conversation.
// - Defensive parsing: the transcript format is vendor-warned unstable, so
//   unknown entry types and malformed lines are ignored, never fatal. The
//   archived original remains the durable artifact; this rendering can be
//   regenerated when the parser improves.

// Injected-content tags observed in real transcripts (2026-07-13 survey).
// Non-greedy paired strips first, then any orphan open/close tags.
const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

function stripInjected(text) {
  let out = text;
  for (const re of INJECTED_BLOCKS) out = out.replace(re, "");
  return out;
}

function userText(content) {
  if (typeof content === "string") return stripInjected(content);
  if (!Array.isArray(content)) return "";
  // Only text blocks are Tony's words; tool_result and image blocks are
  // machine payloads that happen to arrive under the user role.
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => stripInjected(b.text))
    .join("\n");
}

// Split on purpose: extraction and rendering are separate steps so the
// ingester can transform turn text between them (the sensitive-pattern
// scrub must run BEFORE offsets are computed, or every offset after a
// redaction would drift -- placeholder length differs from match length).
export function parseClaudeSessionTurns(jsonlText) {
  let sessionId = null;
  let cwd = null;
  const turns = [];
  let omittedToolCalls = 0;

  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // malformed line: never fatal
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary || entry.isApiErrorMessage) continue;

    sessionId = sessionId ?? entry.sessionId ?? null;
    cwd = cwd ?? entry.cwd ?? null;
    const content = entry.message?.content;

    if (entry.type === "user") {
      const text = userText(content).trim();
      if (!text) continue;
      turns.push({ speaker: "tony", text, ts: entry.timestamp ?? null });
    } else {
      if (!Array.isArray(content)) continue;
      // thinking blocks are internal reasoning, never conversation; tool_use
      // blocks collapse into a rendering marker between prose turns.
      omittedToolCalls += content.filter((b) => b && b.type === "tool_use").length;
      const text = content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) continue;
      turns.push({ speaker: "assistant", text, ts: entry.timestamp ?? null, omittedBefore: omittedToolCalls });
      omittedToolCalls = 0;
    }
  }

  // An episode exists only if Tony actually said something: pure automation
  // runs and assistant-only fragments are not life-capture.
  if (!turns.some((t) => t.speaker === "tony")) return null;

  const stamped = turns.filter((t) => t.ts);
  return {
    sessionId,
    cwd,
    occurredAt: stamped.length ? stamped[0].ts : null,
    occurredUntil: stamped.length ? stamped[stamped.length - 1].ts : null,
    turns,
  };
}

export function renderEpisode(turns) {
  let raw = "";
  const spans = [];
  for (const turn of turns) {
    if (turn.omittedBefore) {
      raw += `[${turn.omittedBefore} tool call${turn.omittedBefore === 1 ? "" : "s"} omitted]\n\n`;
    }
    const prefix = `${turn.speaker}:\n`;
    const start = raw.length + prefix.length;
    raw += prefix + turn.text + "\n\n";
    spans.push({ speaker: turn.speaker, text: turn.text, start, end: start + turn.text.length, ts: turn.ts });
  }
  return { raw: raw.trimEnd(), spans };
}

export function parseClaudeSession(jsonlText) {
  const parsed = parseClaudeSessionTurns(jsonlText);
  if (!parsed) return null;
  const { turns, ...meta } = parsed;
  return { ...meta, ...renderEpisode(turns) };
}

// Codex rollout tags observed injected into user text.
const CODEX_INJECTED_BLOCKS = [
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<environment_context>[\s\S]*?<\/environment_context>/g,
];

// Codex rollouts: {type, timestamp, payload} envelopes. Conversation lives
// in response_item payloads of type "message" with roles user/assistant;
// "developer" messages are injected instructions and "reasoning" payloads
// are internal chain-of-thought -- neither is conversation. Tool payloads
// (function_call, custom_tool_call, web_search_call) collapse into the
// same omitted-markers renderEpisode() already understands.
export function parseCodexSessionTurns(jsonlText) {
  let sessionId = null;
  let cwd = null;
  const turns = [];
  let omittedToolCalls = 0;

  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const p = entry.payload;
    if (!p || typeof p !== "object") continue;

    if (entry.type === "session_meta") {
      sessionId = sessionId ?? p.id ?? p.session_id ?? null;
      cwd = cwd ?? p.cwd ?? null;
      continue;
    }
    if (entry.type !== "response_item") continue;

    if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "web_search_call") {
      omittedToolCalls++;
      continue;
    }
    if (p.type !== "message") continue;

    if (p.role === "user") {
      let text = (p.content ?? [])
        .filter((b) => b && b.type === "input_text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      for (const re of CODEX_INJECTED_BLOCKS) text = text.replace(re, "");
      text = text.trim();
      if (!text) continue;
      turns.push({ speaker: "tony", text, ts: entry.timestamp ?? null });
    } else if (p.role === "assistant") {
      const text = (p.content ?? [])
        .filter((b) => b && b.type === "output_text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) continue;
      turns.push({ speaker: "assistant", text, ts: entry.timestamp ?? null, omittedBefore: omittedToolCalls });
      omittedToolCalls = 0;
    }
    // any other role (developer, system) is injected, never conversation
  }

  if (!turns.some((t) => t.speaker === "tony")) return null;

  const stamped = turns.filter((t) => t.ts);
  return {
    sessionId,
    cwd,
    occurredAt: stamped.length ? stamped[0].ts : null,
    occurredUntil: stamped.length ? stamped[stamped.length - 1].ts : null,
    turns,
  };
}
