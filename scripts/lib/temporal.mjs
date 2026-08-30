import * as chrono from "chrono-node";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

const DEADLINE_CUE = /\b(?:by|deadline|due|expires?|expiration|through|until|valid\s+until|lasts?\s+(?:for|until))\b/i;

export function normalizeTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error("timestamp must be an ISO 8601 instant with a timezone");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("timestamp must be a valid ISO 8601 instant");
  return date.toISOString();
}

function resultScore(result, source, referenceDate) {
  const before = source.slice(Math.max(0, result.index - 36), result.index);
  const around = source.slice(Math.max(0, result.index - 24), result.index + result.text.length + 12);
  let score = 0;
  if (DEADLINE_CUE.test(before)) score += 8;
  else if (DEADLINE_CUE.test(around)) score += 4;
  if (result.start.isCertain("year")) score += 2;
  if (result.start.date().getTime() >= referenceDate.getTime()) score += 1;
  return score;
}

function endOfDayWhenTimeIsImplied(result) {
  if (result.start.isCertain("hour")) return result.start.date();
  result.start.assign("hour", 23);
  result.start.assign("minute", 59);
  result.start.assign("second", 59);
  result.start.assign("millisecond", 999);
  return result.start.date();
}

export function inferDeadline({
  title = "",
  text = "",
  referenceDate = new Date(),
  timezone = DEFAULT_TIMEZONE,
}) {
  const source = [title, text].filter(Boolean).join("\n");
  const hasDeadlineCue = DEADLINE_CUE.test(source);
  if (!hasDeadlineCue) return null;

  const results = chrono.parse(source, { instant: referenceDate, timezone }, { forwardDate: false });
  if (results.length === 0) return null;
  const ranked = results
    .map((result) => ({ result, score: resultScore(result, source, referenceDate) }))
    .sort((a, b) => b.score - a.score || b.result.index - a.result.index);
  if (ranked[0].score <= 0) return null;

  const best = ranked[0].result;
  const dueAt = endOfDayWhenTimeIsImplied(best);
  if (dueAt.getTime() < referenceDate.getTime()) return null;
  return {
    dueAt: dueAt.toISOString(),
    matchedText: best.text,
    origin: "derived",
  };
}

export function formatLocalDate(value, timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function reminderLine(row) {
  const date = row.due_at
    ? `${formatLocalDate(row.due_at)} ${DEFAULT_TIMEZONE} (${new Date(row.due_at).toISOString()})`
    : "unscheduled";
  const origin = row.temporal_origin ? `, ${row.temporal_origin}` : "";
  return `- ${date}  ${row.title}  (${row.type || "untyped"}${origin})\n  ${row.node_id}`;
}

export function formatReminderSummary(rows, at = new Date()) {
  const active = rows.filter((row) => (row.status ?? "active") === "active" && row.due_at);
  const overdue = active.filter((row) => row.due_at && new Date(row.due_at) < at);
  const upcoming = active.filter((row) => new Date(row.due_at) >= at);
  const lines = [`REMINDERS  ${at.toISOString()}`, ""];
  lines.push(`OVERDUE (${overdue.length})`);
  lines.push(...(overdue.length > 0 ? overdue.map(reminderLine) : ["(none)"]));
  lines.push("", `UPCOMING (${upcoming.length})`);
  lines.push(...(upcoming.length > 0 ? upcoming.map(reminderLine) : ["(none)"]));
  return lines.join("\n");
}
