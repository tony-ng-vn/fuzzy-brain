// Phase 2 walking skeleton: agent-session ingestion (issue #12).
// Sweeps the local session archive plus the live transcripts directory,
// parses settled sessions into conversation renderings, and writes them
// into the evidence store -- by shelling out to scripts/brain.mjs's own
// verbs, so the sensitive-pattern scrub and the no-delete tripwire cover
// this pipeline automatically (one write path, always).
//
// The exposure boundary is HERE, not at capture: archiving is a local
// copy of already-local files; this script is what moves text to the
// cloud database. Three guards run before any insert, in order:
//   1. the allowlist (machine-local config: only named projects ingest),
//   2. DB exclusions on the source row (thread skips by project; person/
//      topic skip the whole episode -- zero rows, per ADR 0002),
//   3. the sensitive-pattern scrub inside the controlled writer, before
//      rendering stored spans so their offsets remain exact.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { parseClaudeSessionTurns, parseCodexSessionTurns, renderEpisode, SESSION_PARSER_VERSION } from "./lib/session-parser.mjs";
import { cli, ensureSource } from "./lib/brain-cli.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";
import { runTracedCli } from "./lib/operation-cli.mjs";
import { safeErrorCode } from "./lib/operation-metadata.mjs";
import { loadEnvLocal } from "./recall.mjs";

// One brain.mjs call per this many episodes, not one call per session: a
// fresh spawn pays a fresh TLS handshake, which dominated cost on a
// degraded link (2026-07-16, ~512 episodes in, hours left at that rate).
const EPISODE_CHUNK_SIZE = 8;

// Even 8-per-chunk can still overwhelm one call: a handful of giant codex
// episodes together blew execFileSync's maxBuffer and the child died
// mid-exchange (EPIPE, 2026-07-16). Flush early once pending raw bytes
// would cross this, so giant episodes travel 1-2 per call instead of 8.
const CHUNK_MAX_RAW_BYTES = 4 * 1024 * 1024;
const DEFAULT_INGEST_LOCK_PATH = join(tmpdir(), "fuzzy-brain-ingest-sessions.lock");

export function acquireIngestLock(lockPath = process.env.FUZZY_BRAIN_INGEST_LOCK || DEFAULT_INGEST_LOCK_PATH) {
  return acquireProcessLock(lockPath, "session ingestion");
}

function chunkRawBytes(buffer) {
  return buffer.reduce((total, p) => total + Buffer.byteLength(p.raw, "utf8"), 0);
}

export function loadConfig() {
  const path = process.env.FUZZY_BRAIN_INGEST_CONFIG || join(homedir(), ".fuzzy-brain", "ingest.json");
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`no ingest config at ${path}; create it with at least {"allowlist": [...]}`);
  }
  // No allowlist means no cloud writes, full stop -- refusing is the safe
  // default, never "ingest everything because config was missing". The one
  // way to open the gate wide is the exact string "*": a deliberate,
  // human-written wildcard, never an inferred or defaulted one.
  const wildcard = cfg.allowlist === "*";
  if (!wildcard && (!Array.isArray(cfg.allowlist) || cfg.allowlist.length === 0)) {
    throw new Error('ingest config needs a non-empty allowlist (or the explicit wildcard "*"); nothing ingests without one');
  }
  if (!wildcard && cfg.allowlist.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error("every ingest allowlist entry must be a non-blank string");
  }
  const settledHours = cfg.settledHours ?? 24;
  if (typeof settledHours !== "number" || !Number.isFinite(settledHours) || settledHours < 0) {
    throw new Error("settledHours must be a finite, non-negative number");
  }
  return {
    allowlist: wildcard ? "*" : cfg.allowlist.map((entry) => entry.trim()),
    settledHours,
    sourceKind: cfg.sourceKind ?? "claude_code_session",
    sourceLabel: cfg.sourceLabel ?? "claude-code",
    codexSourceLabel: cfg.codexSourceLabel ?? "codex",
    archiveRoot: cfg.archiveRoot ?? join(homedir(), ".fuzzy-brain", "session-archive"),
    liveProjectsDir: cfg.liveProjectsDir ?? join(homedir(), ".claude", "projects"),
    codexSessionsDir: cfg.codexSessionsDir ?? join(homedir(), ".codex", "sessions"),
  };
}

// One admission predicate for every source's gate, so the wildcard and the
// substring form can never drift apart between pipelines.
export function admits(allowlist, value) {
  if (allowlist === "*") return true;
  return allowlist.some((a) => value.includes(a));
}

// Candidate session files by session id; on duplicates (archived AND still
// live) the larger file wins -- it holds more of the conversation.
function gatherCandidates(cfg) {
  const candidates = new Map();
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const slug of readdirSync(dir)) {
      const projectDir = join(dir, slug);
      let entries;
      try {
        entries = readdirSync(projectDir);
      } catch {
        continue; // not a directory
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(projectDir, name);
        const sessionId = basename(name, ".jsonl");
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        // Larger file wins (holds more conversation); on a size tie the
        // later-scanned live file wins, so settledness is judged by the
        // live transcript's real last-write time, not an archive copy's.
        const existing = candidates.get(sessionId);
        if (!existing || st.size >= existing.size) {
          candidates.set(sessionId, { file, slug, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
  };
  scan(join(cfg.archiveRoot, "claude-code"));
  scan(cfg.liveProjectsDir);
  return candidates;
}

// Codex rollouts live under date-partitioned dirs with no project slug in
// the path, so allowlisting happens after parse, on the session's cwd.
function gatherCodexCandidates(cfg) {
  const candidates = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(path);
      } else if (name.endsWith(".jsonl")) {
        const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
        const sessionId = m ? m[1] : basename(name, ".jsonl");
        const existing = candidates.get(sessionId);
        if (!existing || st.size >= existing.size) {
          candidates.set(sessionId, { file: path, slug: "codex", size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
  };
  walk(cfg.codexSessionsDir);
  return candidates;
}

function newCounts() {
  return {
    scanned: 0,
    notSettled: 0,
    allowlistSkipped: 0,
    excluded: 0,
    noTonyTurns: 0,
    alreadyIngested: 0,
    unparseable: 0,
    failed: 0,
    ingested: 0,
    evidenceRows: 0,
  };
}

// Check exclusions against the original local rendering. The controlled writer
// rechecks current exclusions, then scrubs and renders the spans before storing them.
function prepareEpisode(source, exclusions, locator, parsed, threadHaystack, counts) {
  const { raw, spans } = renderEpisode(parsed.turns);

  const rawLower = raw.toLowerCase();
  const hit = exclusions.find((x) =>
    x.kind === "thread"
      ? threadHaystack.toLowerCase().includes(String(x.value).toLowerCase())
      : rawLower.includes(String(x.value).toLowerCase()),
  );
  if (hit) {
    counts.excluded++;
    return null;
  }

  return {
    source_id: source.id,
    source_locator: locator,
    raw,
    occurred_at: parsed.occurredAt,
    occurred_until: parsed.occurredUntil,
    thread_context: threadHaystack,
    evidence: spans.map((s, index) => ({
      quote: s.text,
      start_offset: s.start,
      end_offset: s.end,
      speaker: s.speaker,
      occurred_at: s.ts,
      omitted_before: parsed.turns[index].omittedBefore ?? 0,
    })),
  };
}

export function sessionFileIsUnchanged(checkpoints, sessionId, mtimeMs, size) {
  return checkpoints.some(checkpoint => checkpoint.session_key === sessionId
    && checkpoint.parser_version === SESSION_PARSER_VERSION
    && checkpoint.file_mtime_ms === mtimeMs && checkpoint.file_size === size);
}

function listCheckpoints(sourceId) {
  return cli("list-session-checkpoints", [sourceId]);
}

export function logCaptureFailure(stage, error, count = 1) {
  console.error(JSON.stringify({ event: "session_capture.failed",
    stage: ["prepare", "batch", "claude", "codex", "startup"].includes(stage) ? stage : "unknown",
    error_code: safeErrorCode(error?.code), count: Number.isSafeInteger(count) && count >= 0 ? count : 1 }));
}

// Reconcile a batch through one process and connection, with one transaction per session.
// A failed reply leaves its checkpoint available to the identical retry.
function flushChunk(buffer, submitChunk, counts) {
  if (buffer.length === 0) return;
  const chunk = buffer.splice(0, buffer.length);
  let results;
  try {
    results = submitChunk(chunk);
  } catch (err) {
    counts.failed += chunk.length;
    logCaptureFailure("batch", err, chunk.length);
    return;
  }
  for (const r of results) {
    if (r?.error === "excluded") {
      counts.excluded++;
    } else if (r && r.error) {
      counts.failed++;
      logCaptureFailure("batch", { code: r.error });
    } else if (r.replayed || (r.state === "committed" && r.evidence_count === 0)) {
      counts.alreadyIngested++;
    } else {
      counts.ingested++;
      counts.evidenceRows += r.evidence_count;
    }
  }
}

export function processClaudeSessions(cfg, settledBefore, deps = {}) {
  const source = (deps.ensureSource ?? ensureSource)(cfg.sourceKind, cfg.sourceLabel);
  const exclusions = source.exclusions ?? [];
  const existing = (deps.listExisting ?? listCheckpoints)(source.id);
  const prepare = deps.prepare ?? prepareEpisode;
  const submitChunk = deps.submitChunk ?? ((chunk) => cli("sync-session", [], chunk));
  const counts = newCounts();
  const buffer = [];

  for (const [sessionId, cand] of gatherCandidates(cfg)) {
    counts.scanned++;
    if (cand.mtimeMs > settledBefore) {
      counts.notSettled++;
      continue;
    }
    // Allowlist gates on the project slug BEFORE the file is ever read:
    // the slug encodes the session's working directory, and reading plus
    // parsing hundreds of megabytes of non-allowlisted transcripts every
    // run is pure waste (found the hard way: the first live run timed out).
    if (!admits(cfg.allowlist, cand.slug)) {
      counts.allowlistSkipped++;
      continue;
    }
    if (sessionFileIsUnchanged(existing, sessionId, cand.mtimeMs, cand.size)) {
      counts.alreadyIngested++;
      continue;
    }
    let parsed;
    try {
      parsed = parseClaudeSessionTurns(readFileSync(cand.file, "utf8"));
    } catch {
      counts.unparseable++;
      continue;
    }
    if (!parsed) {
      counts.noTonyTurns++;
      continue;
    }
    // A session's own preparation failing (e.g. a parser edge case) costs
    // only that session, same as a submission failure below.
    let payload;
    try {
      payload = prepare(source, exclusions, sessionId, parsed, `${cand.slug} ${parsed.cwd ?? ""}`, counts);
    } catch (err) {
      counts.failed++;
      logCaptureFailure("prepare", err);
      continue;
    }
    if (payload) {
      buffer.push({ ...payload, file_mtime_ms: cand.mtimeMs, file_size: cand.size });
      if (buffer.length >= EPISODE_CHUNK_SIZE || chunkRawBytes(buffer) >= CHUNK_MAX_RAW_BYTES) {
        flushChunk(buffer, submitChunk, counts);
      }
    }
  }
  flushChunk(buffer, submitChunk, counts); // the trailing partial chunk
  return counts;
}

export function processCodexSessions(cfg, settledBefore, deps = {}) {
  const source = (deps.ensureSource ?? ensureSource)("codex_session", cfg.codexSourceLabel);
  const exclusions = source.exclusions ?? [];
  const existing = (deps.listExisting ?? listCheckpoints)(source.id);
  const prepare = deps.prepare ?? prepareEpisode;
  const submitChunk = deps.submitChunk ?? ((chunk) => cli("sync-session", [], chunk));
  const counts = newCounts();
  const buffer = [];

  for (const [sessionId, cand] of gatherCodexCandidates(cfg)) {
    counts.scanned++;
    if (cand.mtimeMs > settledBefore) {
      counts.notSettled++;
      continue;
    }
    if (sessionFileIsUnchanged(existing, sessionId, cand.mtimeMs, cand.size)) {
      counts.alreadyIngested++;
      continue;
    }
    let parsed;
    try {
      parsed = parseCodexSessionTurns(readFileSync(cand.file, "utf8"));
    } catch {
      counts.unparseable++;
      continue;
    }
    if (!parsed) {
      counts.noTonyTurns++;
      continue;
    }
    // No project slug in codex paths: the allowlist gate is the parsed cwd.
    if (!admits(cfg.allowlist, parsed.cwd ?? "")) {
      counts.allowlistSkipped++;
      continue;
    }
    let payload;
    try {
      payload = prepare(source, exclusions, sessionId, parsed, parsed.cwd ?? "codex", counts);
    } catch (err) {
      counts.failed++;
      logCaptureFailure("prepare", err);
      continue;
    }
    if (payload) {
      buffer.push({ ...payload, file_mtime_ms: cand.mtimeMs, file_size: cand.size });
      if (buffer.length >= EPISODE_CHUNK_SIZE || chunkRawBytes(buffer) >= CHUNK_MAX_RAW_BYTES) {
        flushChunk(buffer, submitChunk, counts);
      }
    }
  }
  flushChunk(buffer, submitChunk, counts);
  return counts;
}

function printSummary(label, counts) {
  // Never silent: every skip class is reported, every run, counts only --
  // no excluded content or names ever appear in this output.
  console.log(
    [
      `ingest-sessions summary (${label})`,
      `  scanned          ${counts.scanned}`,
      `  ingested         ${counts.ingested} (${counts.evidenceRows} evidence rows)`,
      `  already ingested ${counts.alreadyIngested}`,
      `  not settled yet  ${counts.notSettled}`,
      `  allowlist skips  ${counts.allowlistSkipped}`,
      `  excluded         ${counts.excluded}`,
      `  no tony turns    ${counts.noTonyTurns}`,
      `  unparseable      ${counts.unparseable}`,
      `  failed           ${counts.failed}`,
    ].join("\n"),
  );
}

export function runSessionCapture(cfg, {
  claude = processClaudeSessions, codex = processCodexSessions, onError = logCaptureFailure,
} = {}) {
  const settledBefore = Date.now() - cfg.settledHours * 3600 * 1000;
  const capture_sources = {}, failed_sources = [];
  for (const [source, capture] of [["claude", claude], ["codex", codex]]) {
    try {
      const counts = capture(cfg, settledBefore);
      capture_sources[source] = counts;
      if (counts.failed > 0) failed_sources.push(source);
    } catch (error) {
      failed_sources.push(source);
      try { onError(source, error); } catch { /* The result still records the failed source. */ }
    }
  }
  const ok = failed_sources.length === 0;
  return { ok, capture_sources, failed_sources,
    ...(!ok ? { error: { code: "unavailable", message: "Some sessions did not save; completed sessions remain saved." } } : {}) };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !["--help", "-h"].includes(args[0]))) {
    throw Object.assign(new Error("Unknown session capture option."), { code: "invalid" });
  }
  if (args.length) {
    const help = { state: "help", commands: ["Run without arguments to capture settled sessions from configured sources."],
      note: "Capture uses the configured allowlist and source exclusions. Failed saves return a nonzero exit status." };
    console.log(JSON.stringify(help, null, 2));
    return help;
  }
  const releaseLock = acquireIngestLock();
  try {
    const cfg = loadConfig();
    const result = runSessionCapture(cfg);
    for (const [source, counts] of Object.entries(result.capture_sources)) {
      printSummary(source === "claude" ? cfg.sourceLabel : cfg.codexSourceLabel, counts);
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  } finally {
    releaseLock();
  }
}

// Only ingest when run directly; importing for tests must not (brain.mjs pattern).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnvLocal();
  const operation = ["--help", "-h"].includes(process.argv[2]) ? "help" : "session_capture";
  runTracedCli("ingest_cli", operation, process.argv.slice(2), main).catch(error => {
    logCaptureFailure("startup", error);
    process.exitCode = 1;
  });
}
