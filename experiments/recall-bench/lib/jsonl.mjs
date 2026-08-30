// lib/jsonl.mjs -- streaming read/write for the corpus's JSONL artifacts
// (DESIGN.md section 2). Both functions are streaming so the 10M tier's
// memory stream (which load.mjs --stream consumes straight from the
// generator, per section 3.3) never has to sit fully in memory just to be
// written or read back.
//
// Contract note: bench-recall.mjs (a sibling file) already landed against
// `readJsonl(filePath)` as an async-iterable line reader and
// `writeJsonl(filePath, records)` as a writer taking any iterable/async-
// iterable of records -- see its "ASSUMED" comment. This file matches that
// usage exactly.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

// Async generator over one JSON object per non-blank line. Backed by a
// readline interface over a read stream, so memory use stays flat regardless
// of file size.
export async function* readJsonl(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (line.trim() === '') continue;
      try {
        yield JSON.parse(line);
      } catch (err) {
        throw new Error(`${filePath}:${lineNo}: invalid JSON (${err.message})`);
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

// Writes `records` (a sync or async iterable of plain objects) to `filePath`
// as one JSON object per line, creating the parent directory if needed.
// Backpressure-aware so a 10M-record stream cannot outrun the disk. Returns
// the number of records written.
export async function writeJsonl(filePath, records) {
  await mkdir(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  let count = 0;
  let writeErr = null;
  stream.on('error', (err) => {
    writeErr = err;
  });
  try {
    for await (const record of records) {
      if (writeErr) throw writeErr;
      const line = JSON.stringify(record) + '\n';
      if (!stream.write(line)) {
        await once(stream, 'drain');
      }
      count++;
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((err) => (err || writeErr ? reject(err ?? writeErr) : resolve()));
    });
  }
  return count;
}
