// The closed-world date parser: a finite list of templates, and nothing else.
// No general natural-language date parsing, ever -- a question either matches
// one of the shapes below or carries no date signal at all.
//
// Shared by scripts/recall.mjs and experiments/recall-bench/engine.mjs.
//
// cfg.dates.referenceIso pins "last <Month>" and friends to a fixed anchor
// instead of wall-clock time; the bench sets it so a template resolves the
// same way regardless of when the bench runs. The product leaves it null and
// resolves against real "now", which is what a person asking the question
// means. cfg.dates.templates, when present, is the allowlist of template
// kinds: the product drops "bare-month" because "may" and "march" are
// ordinary English words long before they are dates.

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const SEASON_MONTHS = {
  spring: [3, 4, 5], summer: [6, 7, 8], fall: [9, 10, 11],
  autumn: [9, 10, 11], winter: [12, 1, 2],
};
const MONTH_ALT = MONTHS.join("|");
const SEASON_ALT = Object.keys(SEASON_MONTHS).join("|");

export const DATE_PATTERNS = [
  { kind: "in-month-year", re: new RegExp(`\\bin\\s+(${MONTH_ALT})\\s+(\\d{4})\\b`, "i") },
  { kind: "that-season-of-year", re: new RegExp(`\\bthat\\s+(${SEASON_ALT})\\s+of\\s+(\\d{4})\\b`, "i") },
  { kind: "before-year", re: /\bbefore\s+(\d{4})\b/i },
  { kind: "after-year", re: /\bafter\s+(\d{4})\b/i },
  { kind: "in-year", re: /\bin\s+(\d{4})\b/i },
  { kind: "last-month", re: new RegExp(`\\blast\\s+(${MONTH_ALT})\\b`, "i") },
  { kind: "around-month", re: new RegExp(`\\baround\\s+(${MONTH_ALT})\\b`, "i") },
  { kind: "bare-month", re: new RegExp(`\\b(${MONTH_ALT})\\b`, "i") },
];

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthRange(year, month1to12) {
  return { from: isoDate(Date.UTC(year, month1to12 - 1, 1)), to: isoDate(Date.UTC(year, month1to12, 1)) };
}

function yearRange(year) {
  return { from: isoDate(Date.UTC(year, 0, 1)), to: isoDate(Date.UTC(year + 1, 0, 1)) };
}

function seasonRange(season, year) {
  const months = SEASON_MONTHS[season];
  if (season === "winter") {
    return { from: isoDate(Date.UTC(year, 11, 1)), to: isoDate(Date.UTC(year + 1, 2, 1)) };
  }
  const first = months[0];
  const last = months[months.length - 1];
  return { from: isoDate(Date.UTC(year, first - 1, 1)), to: isoDate(Date.UTC(year, last, 1)) };
}

function referenceDate(cfg) {
  const iso = cfg?.dates?.referenceIso;
  return iso ? new Date(iso) : new Date();
}

// A month with no year in the text ("last <Month>", a bare month name) rolls
// back a year whenever the target month's index is >= the reference month's
// index -- >=, not >, so at the reference month itself the year still rolls
// back. This matches the bench corpus generator's own rule exactly.
function lastOccurrenceYear(month1to12, reference) {
  const refYear = reference.getUTCFullYear();
  const refMonth = reference.getUTCMonth() + 1;
  return month1to12 >= refMonth ? refYear - 1 : refYear;
}

// The named month plus the one before and after: a fixed 3-calendar-month
// window, not a day-count pad.
function aroundMonthRange(year, month1to12) {
  return { from: isoDate(Date.UTC(year, month1to12 - 2, 1)), to: isoDate(Date.UTC(year, month1to12 + 1, 1)) };
}

export function parseDateRange(lowerText, cfg) {
  const allowed = cfg?.dates?.templates ?? null;
  for (const { kind, re } of DATE_PATTERNS) {
    if (allowed && !allowed.includes(kind)) continue;
    const m = lowerText.match(re);
    if (!m) continue;
    const reference = referenceDate(cfg);
    switch (kind) {
      case "in-month-year":
        return monthRange(Number(m[2]), MONTHS.indexOf(m[1].toLowerCase()) + 1);
      case "that-season-of-year":
        return seasonRange(m[1].toLowerCase(), Number(m[2]));
      case "before-year":
        return { from: null, to: yearRange(Number(m[1])).from };
      case "after-year":
        return { from: yearRange(Number(m[1]) + 1).from, to: null };
      case "in-year":
        return yearRange(Number(m[1]));
      case "last-month": {
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        return monthRange(lastOccurrenceYear(month, reference), month);
      }
      case "around-month": {
        // The text carries no year ("around march"), so this is the same
        // last-occurrence guess the bare-month and last-month cases make. A
        // wrong guess here is a known, accepted cost of a closed-world
        // parser reading only the words it was given.
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        return aroundMonthRange(lastOccurrenceYear(month, reference), month);
      }
      case "bare-month": {
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        return monthRange(lastOccurrenceYear(month, reference), month);
      }
      default:
        return { from: null, to: null };
    }
  }
  return { from: null, to: null };
}
