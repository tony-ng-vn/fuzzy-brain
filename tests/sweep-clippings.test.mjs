// Unit tests for the clippings sweeper (Phase 5 source: share-sheet
// capture). Everything runs against temp inbox dirs with injected CLI
// deps -- no cloud writes. The DB-facing seams (ensureSource,
// listExisting, submitChunk) match ingest-sessions' test style exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { parseClipping, renderClipping, processClippings, clippingLocator, loadClippingsConfig } = await import(
  pathToFileURL(join(root, "scripts", "sweep-clippings.mjs"))
);

function tempInbox() {
  return mkdtempSync(join(tmpdir(), "fuzzy-clippings-"));
}

function fakeDeps(overrides = {}) {
  const submitted = [];
  return {
    submitted,
    deps: {
      ensureSource: () => ({ id: "source-clip-1", exclusions: [] }),
      listExisting: () => [],
      submitChunk: (chunk) => {
        submitted.push(...chunk);
        return chunk.map((e) => ({
          id: "ep-x",
          source_locator: e.source_locator,
          evidence_count: e.evidence.length,
        }));
      },
      ...overrides,
    },
  };
}

test("loadClippingsConfig: env override wins, default lands in iCloud Drive", () => {
  const saved = process.env.FUZZY_BRAIN_CLIPPINGS_DIR;
  try {
    process.env.FUZZY_BRAIN_CLIPPINGS_DIR = "/somewhere/else";
    assert.equal(loadClippingsConfig().inboxDir, "/somewhere/else");
    delete process.env.FUZZY_BRAIN_CLIPPINGS_DIR;
    const cfg = loadClippingsConfig();
    assert.ok(cfg.inboxDir.includes(join("com~apple~CloudDocs", "FuzzyBrain", "inbox")));
    assert.equal(cfg.sourceKind, "clipping");
    assert.equal(cfg.sourceLabel, "share-sheet");
  } finally {
    if (saved === undefined) delete process.env.FUZZY_BRAIN_CLIPPINGS_DIR;
    else process.env.FUZZY_BRAIN_CLIPPINGS_DIR = saved;
  }
});

test("parseClipping: shapes", async (t) => {
  await t.test("a JSON clip keeps its fields", () => {
    const payload = parseClipping(
      "a.json",
      JSON.stringify({
        url: "https://example.com/post",
        title: "A post",
        selection: "the highlighted bit",
        note: "why I saved it",
        app: "Safari",
        device: "iPhone",
        captured_at: "2026-07-21T18:00:00.000Z",
      }),
    );
    assert.equal(payload.url, "https://example.com/post");
    assert.equal(payload.note, "why I saved it");
    assert.equal(payload.captured_at, "2026-07-21T18:00:00.000Z");
  });

  await t.test("a plain text clip becomes a note, verbatim", () => {
    const payload = parseClipping("thought.txt", "a raw thought, typos adn all\n");
    assert.equal(payload.note, "a raw thought, typos adn all\n");
  });

  await t.test("a .json file with broken JSON still captures as a note", () => {
    const payload = parseClipping("broken.json", "{not json");
    assert.equal(payload.note, "{not json");
  });

  await t.test("blank content is nothing to keep", () => {
    assert.equal(parseClipping("empty.txt", "   \n"), null);
    assert.equal(parseClipping("empty.json", JSON.stringify({ url: "", note: " " })), null);
  });
});

test("renderClipping: raw carries every field and span offsets are exact", () => {
  const { raw, occurred_at, evidence } = renderClipping({
    url: "https://example.com/post",
    title: "A post",
    selection: "the highlighted bit",
    note: "why I saved it",
    app: "Safari",
    device: "iPhone",
    captured_at: "2026-07-21T18:00:00.000Z",
  });
  assert.ok(raw.includes("title: A post"));
  assert.ok(raw.includes("url: https://example.com/post"));
  assert.equal(occurred_at, "2026-07-21T18:00:00.000Z");
  assert.equal(evidence.length, 2);
  for (const span of evidence) {
    assert.equal(raw.slice(span.start_offset, span.end_offset), span.quote);
    assert.equal(span.occurred_at, "2026-07-21T18:00:00.000Z");
  }
  const note = evidence.find((s) => s.speaker === "Tony");
  assert.equal(note.quote, "why I saved it");
  const selection = evidence.find((s) => s.speaker === null);
  assert.equal(selection.quote, "the highlighted bit");
});

test("renderClipping: a note-only clip still renders, a link-only clip has no spans", () => {
  const noteOnly = renderClipping({ note: "just a thought", captured_at: "2026-07-21T18:00:00.000Z" });
  assert.equal(noteOnly.evidence.length, 1);
  assert.equal(noteOnly.raw.slice(noteOnly.evidence[0].start_offset, noteOnly.evidence[0].end_offset), "just a thought");
  const linkOnly = renderClipping({ url: "https://example.com", captured_at: "2026-07-21T18:00:00.000Z" });
  assert.equal(linkOnly.evidence.length, 0);
  assert.ok(linkOnly.raw.includes("https://example.com"));
});

test("processClippings: ingests, archives, and reports", () => {
  const inbox = tempInbox();
  writeFileSync(join(inbox, "article.json"), JSON.stringify({ url: "https://example.com", note: "keep this" }));
  writeFileSync(join(inbox, "thought.txt"), "half-formed idea");
  writeFileSync(join(inbox, ".article.json.icloud"), "placeholder");
  mkdirSync(join(inbox, "processed"));
  const { deps, submitted } = fakeDeps();

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.scanned, 2);
  assert.equal(counts.ingested, 2);
  assert.equal(counts.evidenceRows, 2);
  assert.equal(counts.failed, 0);
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every((e) => e.source_id === "source-clip-1"));
  assert.ok(submitted.every((e) => e.occurred_at)); // mtime fallback fills it
  // inbox drained into processed/, the iCloud placeholder left alone
  const left = readdirSync(inbox).filter((n) => !n.startsWith("."));
  assert.deepEqual(left.sort(), ["processed"]);
  assert.equal(readdirSync(join(inbox, "processed")).length, 2);
});

test("processClippings: dedupes against the store and within a run", () => {
  const inbox = tempInbox();
  const content = JSON.stringify({ note: "same clip twice" });
  writeFileSync(join(inbox, "a.json"), content);
  writeFileSync(join(inbox, "b.json"), content);
  writeFileSync(join(inbox, "old.json"), JSON.stringify({ note: "already stored" }));
  const oldLocator = clippingLocator(JSON.stringify({ note: "already stored" }));
  const { deps, submitted } = fakeDeps({ listExisting: () => [oldLocator] });

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.scanned, 3);
  assert.equal(counts.ingested, 1);
  assert.equal(counts.alreadyIngested, 2);
  assert.equal(submitted.length, 1);
  // duplicates are archived, not left to retry forever
  assert.equal(readdirSync(inbox).filter((n) => !n.startsWith(".")).length, 1); // just processed/
  assert.equal(readdirSync(join(inbox, "processed")).length, 3);
});

test("processClippings: a failed submit leaves the file in the inbox for the next run", () => {
  const inbox = tempInbox();
  writeFileSync(join(inbox, "flaky.json"), JSON.stringify({ note: "try me again" }));
  const { deps } = fakeDeps({
    submitChunk: (chunk) => chunk.map((e) => ({ error: "connection died", source_locator: e.source_locator })),
  });

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.failed, 1);
  assert.equal(counts.ingested, 0);
  assert.ok(existsSync(join(inbox, "flaky.json")));
});

test("processClippings: a thrown submit counts the whole chunk failed and retries later", () => {
  const inbox = tempInbox();
  writeFileSync(join(inbox, "boom.json"), JSON.stringify({ note: "kaboom" }));
  const { deps } = fakeDeps({
    submitChunk: () => {
      throw new Error("EPIPE");
    },
  });

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.failed, 1);
  assert.ok(existsSync(join(inbox, "boom.json")));
});

test("processClippings: honors DB exclusions with a whole-episode skip", () => {
  const inbox = tempInbox();
  writeFileSync(join(inbox, "secret.json"), JSON.stringify({ note: "lunch with Voldemort next week" }));
  const { deps, submitted } = fakeDeps({
    ensureSource: () => ({ id: "source-clip-1", exclusions: [{ kind: "person", value: "voldemort" }] }),
  });

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.excluded, 1);
  assert.equal(submitted.length, 0);
  assert.ok(!existsSync(join(inbox, "secret.json")));
  assert.equal(readdirSync(join(inbox, "skipped")).length, 1);
});

test("processClippings: blank clips are set aside, not submitted", () => {
  const inbox = tempInbox();
  writeFileSync(join(inbox, "empty.txt"), "   \n");
  const { deps, submitted } = fakeDeps();

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.empty, 1);
  assert.equal(submitted.length, 0);
  assert.equal(readdirSync(join(inbox, "skipped")).length, 1);
});

test("processClippings: the sensitive-pattern scrub runs before offsets are computed", () => {
  const inbox = tempInbox();
  writeFileSync(join(inbox, "ssn.json"), JSON.stringify({ note: "my ssn is 123-45-6789 remember it" }));
  const { deps, submitted } = fakeDeps();

  processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(submitted.length, 1);
  const episode = submitted[0];
  assert.ok(!episode.raw.includes("123-45-6789"));
  assert.ok(episode.raw.includes("[REDACTED:ssn_pattern]"));
  const span = episode.evidence[0];
  assert.equal(episode.raw.slice(span.start_offset, span.end_offset), span.quote);
  assert.ok(!span.quote.includes("123-45-6789"));
});

test("processClippings: a missing inbox is created empty rather than erroring", () => {
  const inbox = join(tempInbox(), "not-there-yet", "inbox");
  const { deps, submitted } = fakeDeps();

  const counts = processClippings({ inboxDir: inbox, sourceKind: "clipping", sourceLabel: "share-sheet" }, deps);

  assert.equal(counts.scanned, 0);
  assert.equal(submitted.length, 0);
  assert.ok(existsSync(inbox));
});
