// Unit tests for the brain companion tool's pure formatters.
// No database: these exercise how the whole-brain index and the full-text
// view render, which is what Claude reads at the start of a talking session.
import test from "node:test";
import assert from "node:assert/strict";
import { formatIndex, formatShow } from "../scripts/brain.mjs";

const nodes = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    type: "event",
    title: "Summer 2026 - Founder Split",
    body: "The split happened in June.\n\nIt still stings.",
    raw: "the split happend in june... it still stings",
    created_at: "2026-07-02T18:40:33.168Z",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    type: "quote",
    title: "Rejection is redirection",
    body: "A door closing is a hallway opening.",
    raw: "a door closing is a hallway opening",
    // A real Date, as Postgres returns it -- not an ISO string.
    created_at: new Date("2026-07-02T18:36:09.475Z"),
  },
];

const edges = [
  {
    source: "11111111-1111-1111-1111-111111111111",
    target: "22222222-2222-2222-2222-222222222222",
    why: "The split was the rejection that redirected him.",
    src_title: "Summer 2026 - Founder Split",
    tgt_title: "Rejection is redirection",
  },
];

test("formatIndex renders the whole brain compactly", () => {
  const out = formatIndex(nodes, edges, null);
  // Header carries the counts so the reader knows the shape at a glance.
  assert.match(out, /nodes=2/);
  assert.match(out, /edges=1/);
  // Every node shows date, type, title, and its full id (needed to act on it).
  assert.match(out, /2026-07-02\s+event\s+Summer 2026 - Founder Split/);
  assert.ok(out.includes("11111111-1111-1111-1111-111111111111"));
  // A Date-typed created_at must render as YYYY-MM-DD too, not "Thu Jul 02".
  assert.match(out, /2026-07-02\s+quote\s+Rejection is redirection/);
  // Edges read as title -> title, with the why sentence.
  assert.match(out, /Summer 2026 - Founder Split\s+->\s+Rejection is redirection/);
  assert.ok(out.includes("The split was the rejection that redirected him."));
  // The index is the gist only: neither layer's text belongs here.
  assert.ok(!out.includes("It still stings."));
  assert.ok(!out.includes("it still stings"));
});

test("formatIndex opens with the latest talk recap when one exists", () => {
  const out = formatIndex(nodes, edges, {
    recap: "shared the trip story; the bravery question stayed open",
    created_at: "2026-07-08T02:00:00.000Z",
  });
  assert.match(out, /LAST TALK\s+2026-07-08/);
  assert.ok(out.includes("the bravery question stayed open"));
  // Without a talk, the section is absent entirely.
  assert.ok(!formatIndex(nodes, edges, null).includes("LAST TALK"));
});

test("formatShow renders both layers, readable first", () => {
  const out = formatShow([nodes[0]]);
  assert.match(out, /Summer 2026 - Founder Split/);
  const readableAt = out.indexOf("READABLE");
  const rawAt = out.indexOf("RAW");
  assert.ok(readableAt !== -1 && rawAt !== -1 && readableAt < rawAt);
  // The whole readable, paragraph breaks and all, and the verbatim raw.
  assert.ok(out.includes("It still stings."));
  assert.ok(out.includes("the split happend in june... it still stings"));
});

test("formatIndex handles an empty brain without crashing", () => {
  const out = formatIndex([], [], null);
  assert.match(out, /nodes=0/);
  assert.match(out, /edges=0/);
});
