import test from "node:test";
import assert from "node:assert/strict";
import {
  formatReminderSummary,
  formatLocalDate,
  inferDeadline,
  normalizeTimestamp,
} from "../scripts/lib/temporal.mjs";

test("inferDeadline treats an explicit future-until date as a reminder deadline", () => {
  const result = inferDeadline({
    type: "startup",
    title: "Stripe Atlas offer",
    text: "Right now it is Aug 6 so lets say i have this until Aug 5 2027 to get it",
    referenceDate: new Date("2026-08-06T12:00:00-07:00"),
  });

  assert.ok(result);
  assert.equal(result.matchedText, "Aug 5 2027");
  assert.equal(result.dueAt, "2027-08-06T06:59:59.999Z");
  assert.equal(result.origin, "derived");
});

test("inferDeadline does not turn an ordinary historical date into a reminder", () => {
  const result = inferDeadline({
    type: "note",
    title: "Yosemite memory",
    text: "We came back from Yosemite on July 4, 2026.",
    referenceDate: new Date("2026-08-06T12:00:00-07:00"),
  });
  assert.equal(result, null);
});

test("a goal label alone does not turn a past event date into a deadline", () => {
  const result = inferDeadline({
    type: "goal",
    title: "Finished accelerator application",
    text: "I submitted it on July 4, 2026.",
    referenceDate: new Date("2026-08-06T12:00:00-07:00"),
  });
  assert.equal(result, null);
});

test("a goal label alone does not turn a future date into a deadline", () => {
  const result = inferDeadline({
    type: "goal",
    title: "Write about today",
    text: "I wrote this goal today Aug 6 2026.",
    referenceDate: new Date("2026-08-05T12:00:00-07:00"),
  });
  assert.equal(result, null);
});

test("historical deadline language does not create a new overdue reminder", () => {
  const result = inferDeadline({
    type: "note",
    title: "Old launch",
    text: "The application was due July 4 2025.",
    referenceDate: new Date("2026-08-06T12:00:00-07:00"),
  });
  assert.equal(result, null);
});

test("a same-day deadline remains valid until local end of day", () => {
  const result = inferDeadline({
    type: "goal",
    title: "Submit today",
    text: "Submit this by Aug 6 2026.",
    referenceDate: new Date("2026-08-06T12:00:00-07:00"),
  });
  assert.equal(result?.dueAt, "2026-08-07T06:59:59.999Z");
});

test("formatLocalDate renders an end-of-day instant in Tony's timezone", () => {
  assert.equal(formatLocalDate("2027-08-06T06:59:59.999Z"), "2027-08-05");
});

test("normalizeTimestamp rejects ambiguous values and preserves real instants", () => {
  assert.equal(normalizeTimestamp("2027-08-06T06:59:59.999Z"), "2027-08-06T06:59:59.999Z");
  assert.throws(() => normalizeTimestamp("next summer"), /ISO 8601/i);
});

test("formatReminderSummary groups overdue and upcoming active nodes and omits completed nodes", () => {
  const out = formatReminderSummary(
    [
      {
        node_id: "a",
        type: "goal",
        title: "Past goal",
        status: "active",
        due_at: "2026-08-05T06:00:00.000Z",
        temporal_origin: "explicit",
      },
      {
        node_id: "b",
        type: "startup",
        title: "Stripe Atlas offer",
        status: "active",
        due_at: "2027-08-06T06:59:59.999Z",
        temporal_origin: "derived",
      },
      {
        node_id: "c",
        type: "goal",
        title: "Finished goal",
        status: "completed",
        due_at: "2026-08-05T06:00:00.000Z",
        temporal_origin: "explicit",
      },
    ],
    new Date("2026-08-06T12:00:00.000Z"),
  );

  assert.match(out, /OVERDUE/);
  assert.match(out, /Past goal/);
  assert.match(out, /UPCOMING/);
  assert.match(out, /Stripe Atlas offer/);
  assert.match(out, /2027-08-05 America\/Los_Angeles/);
  assert.doesNotMatch(out, /Finished goal/);
});
