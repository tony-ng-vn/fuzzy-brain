// Shared console rendering for both benches (DESIGN.md section 2).
//
// Kept deliberately plain: fixed-width columns, ASCII rules, no colour and no
// terminal detection. Bench output gets pasted into reports and diffed between
// runs, and escape codes make that worse.

function cell(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

// printTable(title, headers, rows) -- rows are arrays of cells, one per header.
export function printTable(title, headers, rows) {
  const body = rows.map((row) => headers.map((_, i) => cell(row[i])));
  const widths = headers.map((h, i) => Math.max(cell(h).length, ...body.map((r) => r[i].length), 0));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');

  console.log('');
  console.log(title);
  console.log(line(headers.map(cell)));
  console.log(rule);
  for (const row of body) console.log(line(row));
  if (body.length === 0) console.log('(no rows)');
}

// Every bench writes its numbers to JSON as well as the console: the table is
// for reading, the file is what a later run gets compared against.
export function renderJson(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
