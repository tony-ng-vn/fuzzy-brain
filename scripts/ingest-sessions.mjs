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
//   3. the sensitive-pattern scrub (inside the verbs, and pre-render here
//      so span offsets stay exact -- placeholder length differs from the
//      matched text, so scrubbing after rendering would drift offsets).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { parseClaudeSessionTurns, parseCodexSessionTurns, renderEpisode } from "./lib/session-parser.mjs";
import { scrubSensitivePatterns } from "./brain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const brainCli = join(here, "brain.mjs");

// One brain.mjs call per this many episodes, not one call per session: a
// fresh spawn pays a fresh TLS handshake, which dominated cost on a
// degraded link (2026-07-16, ~512 episodes in, hours left at that rate).
const EPISODE_CHUNK_SIZE = 8;

// Even 8-per-chunk can still overwhelm one call: a handful of giant codex
// episodes together blew execFileSync's maxBuffer and the child died
// mid-exchange (EPIPE, 2026-07-16). Flush early once pending raw bytes
// would cross this, so giant episodes travel 1-2 per call instead of 8.
const CHUNK_MAX_RAW_BYTES = 4 * 1024 * 1024;

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
  return {
    allowlist: cfg.allowlist,
    settledHours: cfg.settledHours ?? 24,
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

function cli(verb, extraArgs = [], input) {
  const out = execFileSync("node", [brainCli, verb, ...extraArgs], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: process.env,
    // add-episode echoes the whole stored raw back; a pasted meeting
    // transcript already blew the 1MB default and killed a real backfill.
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
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

function ensureSource(kind, label) {
  const sources = cli("list-sources");
  const found = sources.find((s) => s.kind === kind && s.label === label);
  if (found) return found;
  return cli("add-source", [], { kind, label });
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

function listExistingLocators(sourceId) {
  return cli("list-episodes", [sourceId]).map((e) => e.source_locator).filter(Boolean);
}

// The shared tail of every source's pipeline: scrub each turn BEFORE
// rendering (so offsets are computed against the exact text that gets
// stored), then enforce DB exclusions (a match means ZERO rows --
// conservative whole-episode skip, never a partial ingest of an excluded
// subject). Pure and local: no cli() call here -- the actual write is
// batched, later, in flushChunk, so this is the one place that decides
// whether an episode is submitted at all.
function prepareEpisode(source, exclusions, locator, parsed, threadHaystack, counts) {
  const scrubbedTurns = parsed.turns.map((t) => ({ ...t, text: scrubSensitivePatterns(t.text).text }));
  const { raw, spans } = renderEpisode(scrubbedTurns);

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
    evidence: spans.map((s) => ({
      quote: s.text,
      start_offset: s.start,
      end_offset: s.end,
      speaker: s.speaker,
      occurred_at: s.ts,
    })),
  };
}

// Submits one full chunk in a single brain.mjs call -- one process, one
// connection, many episodes. brain.mjs commits each episode in its own
// transaction, so a mid-chunk failure only ever costs its own slot; it
// lands in the same `failed` counter a per-session failure always used.
// A crash of the CALL itself (the connection died before any per-episode
// result came back) leaves every episode in the chunk unresolved -- all
// count as failed, and source_locator's uniqueness makes the next run's
// idempotency safe to retry every one of them.
function flushChunk(buffer, submitChunk, counts) {
  if (buffer.length === 0) return;
  const chunk = buffer.splice(0, buffer.length);
  let results;
  try {
    results = submitChunk(chunk);
  } catch (err) {
    counts.failed += chunk.length;
    console.error(`  failed chunk of ${chunk.length}: ${String(err.message).split("\n")[0]}`);
    return;
  }
  for (const r of results) {
    if (r && r.error) {
      counts.failed++;
      console.error(`  failed ${r.source_locator}: ${r.error}`);
    } else {
      counts.ingested++;
      counts.evidenceRows += r.evidence_count;
    }
  }
}

export function processClaudeSessions(cfg, settledBefore, deps = {}) {
  const source = (deps.ensureSource ?? ensureSource)(cfg.sourceKind, cfg.sourceLabel);
  const exclusions = source.exclusions ?? [];
  const existing = new Set((deps.listExisting ?? listExistingLocators)(source.id));
  const prepare = deps.prepare ?? prepareEpisode;
  const submitChunk = deps.submitChunk ?? ((chunk) => cli("add-episode", [], chunk));
  const counts = newCounts();
  const buffer = [];

  for (const [sessionId, cand] of gatherCandidates(cfg)) {
    counts.scanned++;
    if (cand.mtimeMs > settledBefore) {
      counts.notSettled++;
      continue;
    }
    if (existing.has(sessionId)) {
      counts.alreadyIngested++;
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
      console.error(`  failed ${sessionId}: ${String(err.message).split("\n")[0]}`);
      continue;
    }
    if (payload) {
      buffer.push(payload);
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
  const existing = new Set((deps.listExisting ?? listExistingLocators)(source.id));
  const prepare = deps.prepare ?? prepareEpisode;
  const submitChunk = deps.submitChunk ?? ((chunk) => cli("add-episode", [], chunk));
  const counts = newCounts();
  const buffer = [];

  for (const [sessionId, cand] of gatherCodexCandidates(cfg)) {
    counts.scanned++;
    if (cand.mtimeMs > settledBefore) {
      counts.notSettled++;
      continue;
    }
    if (existing.has(sessionId)) {
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
      console.error(`  failed ${sessionId}: ${String(err.message).split("\n")[0]}`);
      continue;
    }
    if (payload) {
      buffer.push(payload);
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

function main() {
  const cfg = loadConfig();
  const settledBefore = Date.now() - cfg.settledHours * 3600 * 1000;
  printSummary(cfg.sourceLabel, processClaudeSessions(cfg, settledBefore));
  printSummary(cfg.codexSourceLabel, processCodexSessions(cfg, settledBefore));
}

// Only ingest when run directly; importing for tests must not (brain.mjs pattern).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
