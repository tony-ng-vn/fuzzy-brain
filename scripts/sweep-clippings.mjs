// Phase 5 source: share-sheet clippings. Tony captures on purpose -- a
// Shortcut in the iOS/macOS share sheet drops a small file into an iCloud
// Drive inbox folder; this sweeper moves what he already chose to keep
// into the evidence store. Nothing here watches or captures on its own,
// and no allowlist gates admission: the act of sharing IS the admission
// decision. Writes go through scripts/brain.mjs's own verbs, so the
// sensitive-pattern scrub and the no-delete tripwire cover this pipeline
// automatically (one write path, always).
import { readFileSync, readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { scrubSensitivePatterns } from "./brain.mjs";
import { cli, ensureSource, listExistingLocators } from "./lib/brain-cli.mjs";

// Clips are share-sheet sized, so unlike ingest-sessions there is no
// byte-cap flush -- but batching still saves a TLS handshake per clip.
const CLIP_CHUNK_SIZE = 8;

export function loadClippingsConfig() {
  return {
    inboxDir:
      process.env.FUZZY_BRAIN_CLIPPINGS_DIR ||
      join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "FuzzyBrain", "inbox"),
    sourceKind: "clipping",
    sourceLabel: "share-sheet",
  };
}

// Content hash as the dedupe key: iCloud re-syncs and Shortcut re-shares
// produce byte-identical files, and the (source_id, source_locator)
// unique index makes retries idempotent, same as session ids do for
// ingest-sessions.
export function clippingLocator(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Forgiving on purpose: the Shortcut writes JSON, but a hand-dropped text
// file (or a Shortcut edit gone wrong) must still capture -- losing a clip
// to a parse error would break the "capture never fails" promise.
export function parseClipping(name, content) {
  let payload = null;
  if (name.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
    } catch {
      // fall through to the plain-text shape
    }
  }
  if (!payload) payload = { note: content };
  const hasSubstance = ["url", "title", "selection", "note"].some(
    (k) => typeof payload[k] === "string" && payload[k].trim(),
  );
  return hasSubstance ? payload : null;
}

// Builds the episode's raw plus evidence spans with exact offsets. The
// quotable layers are the selection (someone else's words, no speaker)
// and the note (Tony's own words); title and url are context lines only.
export function renderClipping(payload) {
  const { url, title, selection, note, app, device, captured_at } = payload;
  let header = "clipping";
  if (captured_at) header += ` at ${captured_at}`;
  if (app) header += ` from ${app}`;
  if (device) header += ` on ${device}`;
  let raw = header + "\n";
  if (title && title.trim()) raw += `title: ${title}\n`;
  if (url && url.trim()) raw += `url: ${url}\n`;
  const evidence = [];
  const appendSpan = (label, text, speaker) => {
    raw += `\n${label}:\n`;
    const start = raw.length;
    raw += text;
    evidence.push({ quote: text, start_offset: start, end_offset: raw.length, speaker, occurred_at: captured_at ?? null });
    raw += "\n";
  };
  if (selection && selection.trim()) appendSpan("selection", selection, null);
  if (note && note.trim()) appendSpan("note", note, "Tony");
  return { raw, occurred_at: captured_at ?? null, evidence };
}

// Archive under a locator-prefixed name so identical basenames from
// different days can never overwrite each other -- the folder is history,
// and history never loses a file here.
function archiveFile(dir, file, name, locator) {
  mkdirSync(dir, { recursive: true });
  renameSync(file, join(dir, `${locator.slice(0, 8)}-${name}`));
}

export function processClippings(cfg, deps = {}) {
  const source = (deps.ensureSource ?? ensureSource)(cfg.sourceKind, cfg.sourceLabel);
  const exclusions = source.exclusions ?? [];
  const existing = new Set((deps.listExisting ?? listExistingLocators)(source.id));
  const submitChunk = deps.submitChunk ?? ((chunk) => cli("add-episode", [], chunk));
  const counts = { scanned: 0, ingested: 0, evidenceRows: 0, alreadyIngested: 0, empty: 0, excluded: 0, failed: 0 };
  const processedDir = join(cfg.inboxDir, "processed");
  const skippedDir = join(cfg.inboxDir, "skipped");

  // First run bootstraps the folder so the Shortcut has a target to save
  // into before the sweeper has ever ingested anything.
  mkdirSync(cfg.inboxDir, { recursive: true });

  const pending = [];
  for (const name of readdirSync(cfg.inboxDir).sort()) {
    // Dotfiles cover both hidden junk and iCloud's undownloaded
    // ".name.icloud" placeholders; those become real files on their own.
    if (name.startsWith(".")) continue;
    const file = join(cfg.inboxDir, name);
    const st = statSync(file);
    if (st.isDirectory()) continue;
    counts.scanned++;
    const content = readFileSync(file, "utf8");
    const locator = clippingLocator(content);
    if (existing.has(locator)) {
      counts.alreadyIngested++;
      archiveFile(processedDir, file, name, locator);
      continue;
    }
    const payload = parseClipping(name, content);
    if (!payload) {
      counts.empty++;
      archiveFile(skippedDir, file, name, locator);
      continue;
    }
    // Scrub each field BEFORE rendering so span offsets are computed
    // against the exact text that gets stored (ingest-sessions pattern:
    // placeholder length differs from the match, scrubbing after would
    // drift offsets).
    for (const k of ["url", "title", "selection", "note", "app", "device"]) {
      if (typeof payload[k] === "string") payload[k] = scrubSensitivePatterns(payload[k]).text;
    }
    payload.captured_at ??= st.mtime.toISOString();
    const { raw, occurred_at, evidence } = renderClipping(payload);
    // Exclusions are a whole-episode skip, zero rows (ADR 0002). Every
    // exclusion kind gates by substring here: clippings have no thread
    // structure to scope a narrower rule to.
    const rawLower = raw.toLowerCase();
    if (exclusions.some((x) => rawLower.includes(String(x.value).toLowerCase()))) {
      counts.excluded++;
      archiveFile(skippedDir, file, name, locator);
      continue;
    }
    existing.add(locator); // in-run dedupe: byte-identical twins submit once
    pending.push({ file, name, locator, episode: { source_id: source.id, source_locator: locator, raw, occurred_at, evidence } });
  }

  for (let i = 0; i < pending.length; i += CLIP_CHUNK_SIZE) {
    const chunk = pending.slice(i, i + CLIP_CHUNK_SIZE);
    let results;
    try {
      results = submitChunk(chunk.map((p) => p.episode));
    } catch (err) {
      // The call itself died: every clip stays in the inbox and the
      // locator makes the next run's retry idempotent.
      counts.failed += chunk.length;
      console.error(`  failed chunk of ${chunk.length}: ${String(err.message).split("\n")[0]}`);
      continue;
    }
    results.forEach((r, j) => {
      if (r && r.error) {
        counts.failed++;
        console.error(`  failed ${chunk[j].name}: ${r.error}`);
      } else {
        counts.ingested++;
        counts.evidenceRows += r.evidence_count;
        archiveFile(processedDir, chunk[j].file, chunk[j].name, chunk[j].locator);
      }
    });
  }
  return counts;
}

function printSummary(counts) {
  // Counts only, never content: same reporting discipline as ingest-sessions.
  console.log(
    [
      "sweep-clippings summary",
      `  scanned          ${counts.scanned}`,
      `  ingested         ${counts.ingested} (${counts.evidenceRows} evidence rows)`,
      `  already ingested ${counts.alreadyIngested}`,
      `  empty            ${counts.empty}`,
      `  excluded         ${counts.excluded}`,
      `  failed           ${counts.failed}`,
    ].join("\n"),
  );
}

// Only sweep when run directly; importing for tests must not (brain.mjs pattern).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  printSummary(processClippings(loadClippingsConfig()));
}
