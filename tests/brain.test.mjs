// Unit tests for the brain companion tool's pure formatters.
// No database: these exercise how the whole-brain index and the full-text
// view render, which is what Claude reads at the start of a talking session.
import test from "node:test";
import assert from "node:assert/strict";
import { formatIndex, formatShow, formatEvidence, scrubSensitivePatterns } from "../scripts/brain.mjs";

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

test("formatIndex renders deadlines as Los Angeles calendar dates", () => {
  const out = formatIndex([
    {
      ...nodes[0],
      status: "active",
      due_at: "2027-08-06T06:59:59.999Z",
    },
  ], [], null);
  assert.match(out, /\[due 2027-08-05\]/);
});

const episode = {
  id: "33333333-3333-3333-3333-333333333333",
  source_locator: "session-abc",
  occurred_at: "2026-07-10T09:00:00.000Z",
  occurred_until: null,
  raw: "the whole captured episode text",
};

const source = { label: "claude code sessions", kind: "claude_code_session" };

test("formatEvidence renders episode metadata and every evidence span", () => {
  const out = formatEvidence(episode, source, [
    { id: "e1", quote: "hello there", start_offset: 0, end_offset: 11, speaker: "tony", occurred_at: null, sender_deleted_at: null, redaction_reason: null },
    { id: "e2", quote: "general kenobi", start_offset: 12, end_offset: 27, speaker: null, occurred_at: null, sender_deleted_at: null, redaction_reason: null },
  ]);
  assert.ok(out.includes("claude code sessions"));
  assert.ok(out.includes("session-abc"));
  assert.match(out, /2026-07-10/);
  assert.ok(out.includes("the whole captured episode text"));
  assert.ok(out.includes("hello there"));
  assert.ok(out.includes("general kenobi"));
  assert.ok(out.includes("tony"));
});

test("formatEvidence marks redacted spans without ever printing sensitive content", () => {
  const out = formatEvidence(episode, source, [
    { id: "e3", quote: "[REDACTED:ssn_pattern]", start_offset: 0, end_offset: 11, speaker: null, occurred_at: null, sender_deleted_at: null, redaction_reason: "ssn_pattern" },
  ]);
  assert.ok(out.includes("[REDACTED:ssn_pattern]"));
  assert.ok(out.includes("ssn_pattern"));
  // The formatter must never print anything shaped like real sensitive data;
  // this only proves it doesn't invent a leak from some other rendered field.
  assert.doesNotMatch(out, /\d{3}-\d{2}-\d{4}/);
});

test("formatEvidence marks sender-deleted spans explicitly, keeping the quote visible", () => {
  const out = formatEvidence(episode, source, [
    {
      id: "e4",
      quote: "i regret going on this trip",
      start_offset: 0,
      end_offset: 28,
      speaker: null,
      occurred_at: null,
      sender_deleted_at: "2026-07-14T00:00:00.000Z",
      redaction_reason: null,
    },
  ]);
  assert.ok(out.includes("i regret going on this trip"));
  assert.match(out, /deleted/i);
});

test("formatEvidence handles an episode with no evidence spans yet", () => {
  const out = formatEvidence(episode, source, []);
  assert.ok(out.includes("session-abc"));
});

test("scrubSensitivePatterns redacts a dashed SSN, preserving surrounding text", () => {
  const { text, redactions } = scrubSensitivePatterns("my ssn is 123-45-6789 ok");
  assert.equal(text, "my ssn is [REDACTED:ssn_pattern] ok");
  assert.equal(redactions.length, 1);
  assert.equal(redactions[0].reason, "ssn_pattern");
});

test("scrubSensitivePatterns leaves ordinary text with no sensitive shapes untouched", () => {
  const { text, redactions } = scrubSensitivePatterns("the trip felt like two different lives, side by side");
  assert.equal(text, "the trip felt like two different lives, side by side");
  assert.deepEqual(redactions, []);
});

test("scrubSensitivePatterns redacts a Luhn-valid card number but ignores a Luhn-invalid same-length run", () => {
  const valid = scrubSensitivePatterns("card: 4111111111111111 thanks");
  assert.ok(valid.text.includes("[REDACTED:credit_card_pattern]"));
  assert.ok(!valid.text.includes("4111111111111111"));
  assert.equal(valid.redactions[0].reason, "credit_card_pattern");

  // Same length, last digit flipped -- breaks the Luhn checksum, so a
  // deterministic filter that only pattern-matched digit-length would
  // false-positive here; Luhn validation is what holds that down.
  const invalid = scrubSensitivePatterns("card: 4111111111111112 thanks");
  assert.equal(invalid.text, "card: 4111111111111112 thanks");
  assert.deepEqual(invalid.redactions, []);
});

test("scrubSensitivePatterns redacts multiple matches independently", () => {
  const { text, redactions } = scrubSensitivePatterns("ssn 123-45-6789 and card 4111111111111111 both here");
  assert.ok(text.includes("[REDACTED:ssn_pattern]"));
  assert.ok(text.includes("[REDACTED:credit_card_pattern]"));
  assert.equal(redactions.length, 2);
});
