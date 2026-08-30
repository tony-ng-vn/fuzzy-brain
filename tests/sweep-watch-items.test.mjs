// Unit tests for the watch-items sweeper (pasted YouTube transcripts).
// Everything runs against injected deps -- no InsForge calls, no cloud
// writes -- matching the seams sweep-clippings' tests already use.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const {
  chunkTranscript,
  pendingWatchItemsSql,
  processWatchItems,
  renderWatchItem,
  resolveNpxPath,
  watchLocator,
  writeBackSql,
} = await import(pathToFileURL(join(root, "scripts", "sweep-watch-items.mjs")));
const { scrubSensitivePatterns } = await import(pathToFileURL(join(root, "scripts", "brain.mjs")));

const ITEM_ID = "11111111-2222-3333-4444-555555555555";
const EPISODE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function marker(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `[0:${m}:${s}]`;
}

function transcript(blocks, wordsEach) {
  let out = "";
  for (let i = 0; i < blocks; i++) out += `${marker(i * 5)} ${"word ".repeat(wordsEach).trim()}\n`;
  return out;
}

function assertCovers(text, spans) {
  assert.equal(spans.map((s) => s.text).join(""), text, "spans must cover the transcript with nothing lost");
  for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
}

test("chunkTranscript: splits at markers into spans inside the size band", () => {
  const text = transcript(80, 10);
  const spans = chunkTranscript(text);

  assert.ok(spans.length > 2, `expected several spans, got ${spans.length}`);
  assertCovers(text, spans);
  const sizes = spans.map((s) => s.end - s.start);
  // The ceiling is 1500, which only a folded-back tail may exceed, and
  // only by less than the floor it was folded to clear.
  for (const size of sizes) assert.ok(size >= 500 && size <= 2000, `span of ${size} chars is outside the band`);
  assert.ok(sizes.filter((size) => size > 1500).length <= 1);
  // Every span but the first opens on a marker, which is what lets a
  // reader jump back to the moment a quote came from.
  for (const span of spans.slice(1)) assert.match(span.text, /^\[\d+:\d{2}:\d{2}\]/);
});

test("chunkTranscript: tiny marker blocks merge instead of becoming their own spans", () => {
  const text = transcript(30, 2); // ~25 chars per block, well under the floor
  assert.ok(text.length < 1500);
  const spans = chunkTranscript(text);

  assert.equal(spans.length, 1, "30 tiny blocks belong in one span, not 30");
  assertCovers(text, spans);
});

test("chunkTranscript: a trailing fragment folds back into the span before it", () => {
  // 53 blocks fill one span and leave 180 characters over -- a fragment
  // too small to mean anything on its own.
  const spans = chunkTranscript(transcript(53, 10));
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => s.end - s.start), [1500, 1680]);
});

test("chunkTranscript: a markerless paste still breaks up, on whitespace", () => {
  const text = "word ".repeat(1400).trim(); // ~7000 chars, not one marker in it
  const spans = chunkTranscript(text);

  assert.ok(spans.length >= 4, `expected the oversized block to split, got ${spans.length}`);
  assertCovers(text, spans);
  // The ceiling is what keeps every span fully embedded; the fold-back can
  // push only the final span past it, and never near the 4000-char cap.
  for (const span of spans) assert.ok(span.end - span.start <= 2000);
  for (const span of spans) assert.doesNotMatch(span.text, /^\S*\s*$/);
});

test("chunkTranscript: a short markerless paste stays one span", () => {
  const spans = chunkTranscript("just a few words, no timestamps at all");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[0].text, "just a few words, no timestamps at all");
});

test("chunkTranscript: nothing in, nothing out", () => {
  assert.deepEqual(chunkTranscript(""), []);
  assert.deepEqual(chunkTranscript("   \n\n  "), []);
});

test("renderWatchItem: header, transcript spans, and a notes span in Tony's name", () => {
  const body = transcript(40, 10);
  const { raw, occurred_at, evidence } = renderWatchItem({
    video_id: "abc123",
    url: "https://youtu.be/abc123",
    title: "How compilers work",
    channel: "Some Channel",
    transcript: body,
    notes: "the register allocation bit is the part I keep forgetting",
    completed_at: "2026-08-10T21:30:00.000Z",
  });

  assert.match(raw, /^title: How compilers work\nchannel: Some Channel\nurl: https:\/\/youtu\.be\/abc123\nwatched: 2026-08-10\n\n/);
  assert.equal(occurred_at, "2026-08-10T21:30:00.000Z");
  for (const span of evidence) {
    assert.equal(raw.slice(span.start_offset, span.end_offset), span.quote);
    assert.equal(span.occurred_at, "2026-08-10T21:30:00.000Z");
  }

  const notes = evidence.filter((s) => s.speaker !== null);
  assert.equal(notes.length, 1);
  // Lowercase exactly: recall.mjs boosts speaker === "tony" and nothing else.
  assert.equal(notes[0].speaker, "tony");
  assert.equal(notes[0].quote, "the register allocation bit is the part I keep forgetting");
  assert.ok(evidence.filter((s) => s.speaker === null).length > 1);
  assert.match(raw, /\n\nTony's notes:\n/);
});

test("renderWatchItem: no notes, no channel, and no watched date still renders", () => {
  const { raw, occurred_at, evidence } = renderWatchItem({
    video_id: "xyz",
    url: "https://youtu.be/xyz",
    transcript: "[0:00:00] hello there",
    notes: null,
    completed_at: null,
  });

  assert.equal(raw, "url: https://youtu.be/xyz\n\n[0:00:00] hello there");
  assert.equal(occurred_at, null);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].speaker, null);
  assert.equal(evidence[0].occurred_at, null);
  assert.equal(raw.slice(evidence[0].start_offset, evidence[0].end_offset), evidence[0].quote);
});

test("renderWatchItem: an empty transcript still produces a landable episode", () => {
  const { raw, evidence } = renderWatchItem({ video_id: "e", url: "https://youtu.be/e", transcript: "", notes: null });
  assert.ok(raw.trim().length > 0);
  assert.deepEqual(evidence, []);
});

test("renderWatchItem: scrubbed text keeps offsets exact and no span re-triggers the scrub", () => {
  const raw_notes = "he said his ssn is 123-45-6789 which I did not need";
  const item = {
    video_id: "s",
    url: "https://youtu.be/s",
    title: "Identity theft",
    transcript: `[0:00:00] the number 123-45-6789 came up on screen\n${transcript(30, 10)}`,
    notes: raw_notes,
    completed_at: "2026-08-10T21:30:00.000Z",
  };
  for (const key of ["title", "transcript", "notes"]) item[key] = scrubSensitivePatterns(item[key]).text;
  const { raw, evidence } = renderWatchItem(item);

  assert.ok(!raw.includes("123-45-6789"));
  assert.match(raw, /\[REDACTED:ssn_pattern\]/);
  for (const span of evidence) {
    assert.equal(raw.slice(span.start_offset, span.end_offset), span.quote);
    // brain.mjs re-scrubs every quote on insert and replaces the WHOLE
    // quote on a hit, so a span that still matches would silently stop
    // agreeing with its own offsets.
    assert.equal(scrubSensitivePatterns(span.quote).redactions.length, 0);
  }
});

test("pendingWatchItemsSql: pending means a transcript exists and no episode was stamped", () => {
  const sql = pendingWatchItemsSql();
  assert.match(sql, /where transcript is not null and brain_episode_id is null/);
  // The app's own queries never select transcript; this one has to.
  assert.match(sql, /select id, video_id, url, title, channel, transcript, notes, completed_at/);
});

test("watchLocator and writeBackSql: one episode per video, and only uuids reach SQL", () => {
  assert.equal(watchLocator("dQw4w9WgXcQ"), "https://youtu.be/dQw4w9WgXcQ");
  assert.match(writeBackSql(ITEM_ID, EPISODE_ID), /update public\.watch_items/);
  assert.match(writeBackSql(ITEM_ID, EPISODE_ID), /returning id/);
  assert.throws(() => writeBackSql("'; drop table watch_items; --", EPISODE_ID), /not a uuid/);
  assert.throws(() => writeBackSql(ITEM_ID, "not-a-uuid"), /not a uuid/);
});

test("resolveNpxPath: prefers a real executable over a bare name launchd cannot find", () => {
  const selected = resolveNpxPath({
    candidates: [undefined, "/opt/homebrew/bin/npx", "/usr/local/bin/npx"],
    isExecutable: (path) => path === "/opt/homebrew/bin/npx",
  });
  assert.equal(selected, "/opt/homebrew/bin/npx");
  assert.throws(() => resolveNpxPath({ candidates: ["/nope"], isExecutable: () => false }), /no executable npx/);
});

function fakeDeps({ rows = [], existing = [], exclusions = [], submitChunk } = {}) {
  const submitted = [];
  const updates = [];
  const source = { id: "source-yt-1", exclusions };
  return {
    submitted,
    updates,
    deps: {
      ensureSource: () => source,
      findSource: () => source,
      listExisting: () => existing,
      submitChunk:
        submitChunk ??
        ((chunk) => {
          submitted.push(...chunk);
          return chunk.map((e) => ({ id: EPISODE_ID, source_locator: e.source_locator, evidence_count: e.evidence.length }));
        }),
      query: (sql) => {
        if (sql.trimStart().startsWith("update")) {
          updates.push(sql);
          return { rows: [{ id: ITEM_ID }] };
        }
        return { rows };
      },
    },
  };
}

const PENDING_ROW = {
  id: ITEM_ID,
  video_id: "abc123",
  url: "https://youtu.be/abc123",
  title: "How compilers work",
  channel: "Some Channel",
  transcript: "[0:00:00] first thing\n[0:00:05] second thing",
  notes: "worth rewatching",
  completed_at: "2026-08-10T21:30:00.000Z",
};

test("processWatchItems: lands a pending item and stamps the row with its episode", () => {
  const { deps, submitted, updates } = fakeDeps({ rows: [PENDING_ROW] });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.pending, 1);
  assert.equal(counts.ingested, 1);
  assert.equal(counts.evidenceRows, 2);
  assert.equal(counts.failed, 0);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].source_locator, "https://youtu.be/abc123");
  assert.equal(submitted[0].source_id, "source-yt-1");
  assert.equal(submitted[0].occurred_at, "2026-08-10T21:30:00.000Z");
  assert.equal(updates.length, 1);
  assert.match(updates[0], new RegExp(`brain_episode_id = '${EPISODE_ID}'`));
  assert.match(updates[0], new RegExp(`where id = '${ITEM_ID}'`));
});

test("processWatchItems: an hour with nothing pasted does not touch the brain at all", () => {
  let brainCalls = 0;
  const { deps, submitted, updates } = fakeDeps({ rows: [] });
  deps.ensureSource = () => {
    brainCalls++;
    return { id: "source-yt-1", exclusions: [] };
  };

  const counts = processWatchItems({}, deps);

  assert.equal(counts.pending, 0);
  assert.equal(brainCalls, 0, "an idle run should not even register the source row");
  assert.equal(submitted.length, 0);
  assert.equal(updates.length, 0);
});

test("processWatchItems: an item already captured is stamped, not ingested twice", () => {
  const { deps, submitted, updates } = fakeDeps({
    rows: [PENDING_ROW],
    existing: [{ id: EPISODE_ID, source_locator: "https://youtu.be/abc123" }],
  });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.alreadyCaptured, 1);
  assert.equal(counts.ingested, 0);
  assert.equal(submitted.length, 0);
  assert.equal(updates.length, 1, "the missing half of an interrupted run is the write-back");
});

test("processWatchItems: a duplicate-key result recovers the episode id and still stamps", () => {
  let listed = 0;
  const { deps, updates } = fakeDeps({
    rows: [PENDING_ROW],
    submitChunk: () => [{ error: 'duplicate key value violates unique constraint "episodes_source_locator_idx"' }],
  });
  deps.listExisting = () => (listed++ === 0 ? [] : [{ id: EPISODE_ID, source_locator: "https://youtu.be/abc123" }]);

  const counts = processWatchItems({}, deps);

  assert.equal(counts.alreadyCaptured, 1);
  assert.equal(counts.failed, 0);
  assert.equal(updates.length, 1);
});

test("processWatchItems: a real failure leaves the row pending for the next run", () => {
  const { deps, updates } = fakeDeps({
    rows: [PENDING_ROW],
    submitChunk: () => [{ error: "connection died" }],
  });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.failed, 1);
  assert.equal(counts.ingested, 0);
  assert.equal(updates.length, 0, "an unstamped row is what makes the retry happen");
});

test("processWatchItems: a thrown submit fails the whole chunk without stamping anything", () => {
  const { deps, updates } = fakeDeps({
    rows: [PENDING_ROW],
    submitChunk: () => {
      throw new Error("EPIPE");
    },
  });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.failed, 1);
  assert.equal(updates.length, 0);
});

test("processWatchItems: a row deleted mid-run fails loudly instead of silently no-oping", () => {
  const { deps } = fakeDeps({ rows: [PENDING_ROW] });
  deps.query = (sql) => (sql.trimStart().startsWith("update") ? { rows: [] } : { rows: [PENDING_ROW] });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.ingested, 1, "the episode did land in the brain");
  assert.equal(counts.failed, 1, "but the stamp did not, so the run reports it");
});

test("processWatchItems: a dry run writes nothing at all", () => {
  const { deps, submitted, updates } = fakeDeps({
    rows: [PENDING_ROW],
    existing: [{ id: EPISODE_ID, source_locator: "https://youtu.be/other" }],
  });

  const counts = processWatchItems({ dryRun: true }, deps);

  assert.equal(counts.pending, 1);
  assert.equal(counts.ingested, 1);
  assert.equal(counts.evidenceRows, 2);
  assert.equal(submitted.length, 0);
  assert.equal(updates.length, 0);
});

test("processWatchItems: a DB exclusion skips the whole episode, zero rows", () => {
  const { deps, submitted, updates } = fakeDeps({
    rows: [PENDING_ROW],
    exclusions: [{ kind: "topic", value: "compilers" }],
  });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.excluded, 1);
  assert.equal(counts.ingested, 0);
  assert.equal(submitted.length, 0);
  assert.equal(updates.length, 0);
});

test("processWatchItems: an empty transcript still lands so the row leaves the queue", () => {
  const { deps, submitted, updates } = fakeDeps({
    rows: [{ ...PENDING_ROW, transcript: "", notes: null }],
  });

  const counts = processWatchItems({}, deps);

  assert.equal(counts.ingested, 1);
  assert.equal(submitted[0].evidence.length, 0);
  assert.ok(submitted[0].raw.includes("https://youtu.be/abc123"));
  assert.equal(updates.length, 1);
});

test("processWatchItems: the scrub runs before offsets, so stored spans stay exact", () => {
  const { deps, submitted } = fakeDeps({
    rows: [{ ...PENDING_ROW, transcript: "[0:00:00] the number 123-45-6789 was on screen", notes: "ssn 123-45-6789" }],
  });

  processWatchItems({}, deps);

  const episode = submitted[0];
  assert.ok(!episode.raw.includes("123-45-6789"));
  for (const span of episode.evidence) {
    assert.equal(episode.raw.slice(span.start_offset, span.end_offset), span.quote);
    assert.equal(scrubSensitivePatterns(span.quote).redactions.length, 0);
  }
});
