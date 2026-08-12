// Phase 2 source: YouTube transcripts Tony pastes into the todo app.
// Same shape as sweep-clippings -- an external inbox of things he chose on
// purpose becomes episodes plus offset-anchored evidence spans -- and for
// the same reason there is no allowlist: pasting a transcript IS the
// admission decision. Writes go through scripts/brain.mjs's own verbs, so
// the sensitive-pattern scrub and the no-delete tripwire cover this
// pipeline automatically (one write path, always).
//
// The only rows this touches outside the brain are in InsForge's own
// public.watch_items, a different database entirely: it reads the pending
// ones and stamps each with the episode it became.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scrubSensitivePatterns } from "./brain.mjs";
import { formatLocalDate } from "./lib/temporal.mjs";
import { cli, ensureSource, listExistingEpisodes, CLI_EXEC_OPTS } from "./lib/brain-cli.mjs";

const SOURCE_KIND = "youtube";
const SOURCE_LABEL = "watch";

// The InsForge CLI resolves credentials from a linked project directory,
// and that link lives with the todo app whose backend this sweep reads.
const TODO_APP_DIR = process.env.FUZZY_BRAIN_TODO_APP_DIR || join(process.env.HOME ?? "", "Desktop", "tony-todo-app");

// Transcripts arrive with inline markers, normalized app-side.
const MARKER = /\[\d+:\d{2}:\d{2}\]/g;

// Span bounds from the design spec. The ceiling is what keeps a span fully
// embedded -- lib/embeddings.mjs only reads the first 4000 characters of
// any text -- and the floor is what keeps a stray fragment out of recall.
const MIN_SPAN_CHARS = 500;
const MAX_SPAN_CHARS = 1500;

// One brain.mjs call per this many episodes, same reason as every other
// sweeper here: a fresh spawn pays a fresh TLS handshake.
const EPISODE_CHUNK_SIZE = 8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// launchd hands fusion-sync a bare PATH, so a plain "npx" resolves in a
// login shell and nowhere else; the hourly run would fail every hour.
export function resolveNpxPath({
  candidates = [
    process.env.FUZZY_BRAIN_NPX_PATH,
    join(dirname(process.execPath), "npx"),
    "/opt/homebrew/bin/npx",
    "/usr/local/bin/npx",
  ],
  isExecutable = executable,
} = {}) {
  const selected = candidates.find((candidate) => candidate && isExecutable(candidate));
  if (!selected) throw new Error("no executable npx found for the InsForge CLI");
  return selected;
}

function insforgeQuery(sql) {
  const out = execFileSync(resolveNpxPath(), ["-y", "@insforge/cli", "db", "query", sql, "--json"], {
    cwd: TODO_APP_DIR,
    encoding: "utf8",
    // npx's shebang is `env node`, so the child needs the running Node on
    // its PATH -- launchd's bare PATH has no node in it at all.
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    ...CLI_EXEC_OPTS,
  });
  return JSON.parse(out);
}

// The app's own queries deliberately never select transcript; this one has
// to. brain_episode_id being null is the whole pending predicate, which is
// also what makes a half-finished run safe to repeat.
export function pendingWatchItemsSql() {
  return `select id, video_id, url, title, channel, transcript, notes, completed_at
          from public.watch_items
          where transcript is not null and brain_episode_id is null
          order by completed_at asc nulls last, created_at asc`;
}

// Boundaries sit at marker positions, so every span after the first opens
// with its own [H:MM:SS] and a reader can jump back to the exact moment.
function markerBoundaries(text) {
  const bounds = [0];
  for (const match of text.matchAll(MARKER)) {
    if (match.index > 0) bounds.push(match.index);
  }
  bounds.push(text.length);
  return bounds;
}

function lastBreakBefore(text, from, limit) {
  for (let i = limit - 1; i > from; i--) {
    if (/\s/.test(text[i])) return i + 1;
  }
  return limit;
}

// A markerless paste is one enormous block, and one enormous span would be
// embedded from its first 4000 characters only, which is the exact thing
// chunking exists to prevent. Break on whitespace so no word is cut.
function splitOversized(text, start, end, out) {
  let from = start;
  while (end - from > MAX_SPAN_CHARS) {
    const cut = lastBreakBefore(text, from, from + MAX_SPAN_CHARS);
    out.push({ start: from, end: cut });
    from = cut;
  }
  if (end > from) out.push({ start: from, end });
}

export function chunkTranscript(text) {
  const blocks = [];
  const bounds = markerBoundaries(text);
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [start, end] = [bounds[i], bounds[i + 1]];
    if (end - start > MAX_SPAN_CHARS) splitOversized(text, start, end, blocks);
    else if (end > start) blocks.push({ start, end });
  }

  const spans = [];
  for (const block of blocks) {
    // One marker block is a line or two of speech. Merging until the next
    // would overflow is what makes a span carry a whole thought.
    const current = spans[spans.length - 1];
    if (current && block.end - current.start <= MAX_SPAN_CHARS) current.end = block.end;
    else spans.push({ ...block });
  }

  // A leftover tail under the floor is a fragment, not evidence: fold it
  // back rather than store a span too small to mean anything on its own.
  const tail = spans[spans.length - 1];
  if (spans.length > 1 && tail.end - tail.start < MIN_SPAN_CHARS) {
    spans.pop();
    spans[spans.length - 1].end = tail.end;
  }

  return spans
    .map((span) => ({ ...span, text: text.slice(span.start, span.end) }))
    .filter((span) => span.text.trim());
}

// Builds the episode's raw plus its spans with exact offsets. The quotable
// layers are the transcript (someone else's words, no speaker) and Tony's
// notes; title, channel, url, and the watched date are context lines only.
export function renderWatchItem(item) {
  const { title, channel, url, transcript, notes, completed_at } = item;
  let raw = "";
  if (title && title.trim()) raw += `title: ${title}\n`;
  if (channel && channel.trim()) raw += `channel: ${channel}\n`;
  raw += `url: ${url}\n`;
  if (completed_at) raw += `watched: ${formatLocalDate(completed_at)}\n`;
  raw += "\n";

  const evidence = [];
  const occurredAt = completed_at ?? null;
  // Read the transcript's base offset off the live string: the header
  // lines above are conditional, so any arithmetic on them would drift.
  const base = raw.length;
  const body = transcript ?? "";
  raw += body;
  for (const chunk of chunkTranscript(body)) {
    evidence.push({
      quote: chunk.text,
      start_offset: base + chunk.start,
      end_offset: base + chunk.end,
      speaker: null,
      occurred_at: occurredAt,
    });
  }

  if (notes && notes.trim()) {
    raw += "\n\nTony's notes:\n";
    const start = raw.length;
    raw += notes;
    // Lowercase "tony" exactly: that is the string recall.mjs boosts.
    evidence.push({ quote: notes, start_offset: start, end_offset: raw.length, speaker: "tony", occurred_at: occurredAt });
  }

  return { raw, occurred_at: occurredAt, evidence };
}

// The unique index on (source_id, source_locator) is what makes a repeat
// run converge instead of duplicating, so one video is one episode.
export function watchLocator(videoId) {
  return `https://youtu.be/${videoId}`;
}

function findSource(kind, label) {
  const found = cli("list-sources").find((s) => s.kind === kind && s.label === label);
  return found ?? { id: null, exclusions: [] };
}

// db query takes raw SQL, so both ids are checked against the uuid shape
// before they are spliced in; nothing from a row reaches SQL unchecked.
export function writeBackSql(itemId, episodeId) {
  if (!UUID_PATTERN.test(itemId)) throw new Error(`watch item id is not a uuid: ${itemId}`);
  if (!UUID_PATTERN.test(episodeId)) throw new Error(`episode id is not a uuid: ${episodeId}`);
  return `update public.watch_items
          set brain_episode_id = '${episodeId}', brain_ingested_at = now()
          where id = '${itemId}'
          returning id`;
}

function stampItem(query, itemId, episodeId) {
  const result = query(writeBackSql(itemId, episodeId));
  const matched = result?.rows?.length ?? 0;
  if (matched !== 1) throw new Error(`write-back matched ${matched} rows for watch item ${itemId}`);
}

function newCounts() {
  return { pending: 0, ingested: 0, evidenceRows: 0, alreadyCaptured: 0, excluded: 0, failed: 0 };
}

export function processWatchItems(cfg = {}, deps = {}) {
  const dryRun = cfg.dryRun ?? false;
  const query = deps.query ?? insforgeQuery;
  const source = dryRun
    ? (deps.findSource ?? findSource)(SOURCE_KIND, SOURCE_LABEL)
    : (deps.ensureSource ?? ensureSource)(SOURCE_KIND, SOURCE_LABEL);
  const exclusions = source.exclusions ?? [];
  const listExisting = deps.listExisting ?? listExistingEpisodes;
  const submitChunk = deps.submitChunk ?? ((chunk) => cli("add-episode", [], chunk));
  const counts = newCounts();

  const locators = new Map(
    source.id ? listExisting(source.id).map((e) => [e.source_locator, e.id]) : [],
  );
  const recoverEpisodeId = (locator) => {
    if (!locators.has(locator)) {
      for (const episode of listExisting(source.id)) locators.set(episode.source_locator, episode.id);
    }
    return locators.get(locator) ?? null;
  };
  // A failed write-back leaves the row pending, which is exactly the state
  // the next run knows how to finish; it costs a count, not the sweep.
  const stamp = (itemId, episodeId, locator) => {
    try {
      stampItem(query, itemId, episodeId);
      return true;
    } catch (err) {
      counts.failed++;
      console.error(`  failed write-back ${locator}: ${String(err.message).split("\n")[0]}`);
      return false;
    }
  };
  const rows = query(pendingWatchItemsSql()).rows ?? [];
  const pending = [];

  for (const row of rows) {
    counts.pending++;
    // Scrub every field that lands in raw BEFORE rendering. brain.mjs
    // scrubs raw again on insert, and a placeholder is a different length
    // than what it replaced, so a miss here would shift every offset after
    // it and break the spans this whole pipeline exists to anchor.
    const item = { ...row };
    for (const key of ["title", "channel", "url", "transcript", "notes"]) {
      if (typeof item[key] === "string") item[key] = scrubSensitivePatterns(item[key]).text;
    }
    const { raw, occurred_at, evidence } = renderWatchItem(item);

    // Exclusions are a whole-episode skip, zero rows (ADR 0002). An
    // excluded item keeps its null brain_episode_id, so it is re-checked
    // every run and costs nothing until Tony lifts the exclusion.
    const rawLower = raw.toLowerCase();
    if (exclusions.some((x) => rawLower.includes(String(x.value).toLowerCase()))) {
      counts.excluded++;
      continue;
    }

    const locator = watchLocator(item.video_id);
    const already = locators.get(locator);
    if (already) {
      // Captured on an earlier run whose write-back never landed. The
      // stamp is the missing half; do it and the row leaves the queue.
      if (dryRun || stamp(item.id, already, locator)) counts.alreadyCaptured++;
      continue;
    }
    pending.push({ item, episode: { source_id: source.id, source_locator: locator, raw, occurred_at, evidence } });
  }

  if (dryRun) {
    for (const { episode } of pending) {
      console.log(`  would ingest ${episode.source_locator}  ${episode.evidence.length} spans  ${episode.raw.length} chars`);
    }
    counts.ingested = pending.length;
    counts.evidenceRows = pending.reduce((total, p) => total + p.episode.evidence.length, 0);
    return counts;
  }

  for (let i = 0; i < pending.length; i += EPISODE_CHUNK_SIZE) {
    const chunk = pending.slice(i, i + EPISODE_CHUNK_SIZE);
    let results;
    try {
      results = submitChunk(chunk.map((p) => p.episode));
    } catch (err) {
      // The call itself died: nothing was stamped, so the locator dedupe
      // makes every one of these safe to retry on the next run.
      counts.failed += chunk.length;
      console.error(`  failed chunk of ${chunk.length}: ${String(err.message).split("\n")[0]}`);
      continue;
    }
    results.forEach((result, j) => {
      const { item, episode } = chunk[j];
      let episodeId = result?.id ?? null;
      if (episodeId) {
        counts.ingested++;
        counts.evidenceRows += result.evidence_count;
      } else if (/duplicate key/i.test(result?.error ?? "")) {
        // A locator collision means the episode is already captured (a
        // concurrent run, or a rewatch of the same video), not a failure.
        episodeId = recoverEpisodeId(episode.source_locator);
        if (episodeId) counts.alreadyCaptured++;
      }
      if (!episodeId) {
        counts.failed++;
        console.error(`  failed ${episode.source_locator}: ${result?.error ?? "no episode id came back"}`);
        return;
      }
      stamp(item.id, episodeId, episode.source_locator);
    });
  }
  return counts;
}

function printSummary(counts, dryRun) {
  // Counts only, never content: same reporting discipline as every other
  // sweeper here.
  console.log(
    [
      `sweep-watch-items summary${dryRun ? " (dry run)" : ""}`,
      `  pending          ${counts.pending}`,
      `  ingested         ${counts.ingested} (${counts.evidenceRows} evidence rows)`,
      `  already captured ${counts.alreadyCaptured}`,
      `  excluded         ${counts.excluded}`,
      `  failed           ${counts.failed}`,
    ].join("\n"),
  );
}

// Only sweep when run directly; importing for tests must not (brain.mjs pattern).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  printSummary(processWatchItems({ dryRun }), dryRun);
}
