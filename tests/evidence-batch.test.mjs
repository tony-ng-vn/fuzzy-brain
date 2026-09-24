import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { syncSession } from "../scripts/lib/session-sync.mjs";
import { renderEpisode } from "../scripts/lib/session-parser.mjs";

function packet(sourceId, turns) {
  const rendered = renderEpisode(turns);
  return { source_id: sourceId, source_locator: randomUUID(), file_mtime_ms: 1,
    file_size: Buffer.byteLength(rendered.raw), raw: rendered.raw,
    evidence: rendered.spans.map(span => ({ quote: span.text, speaker: span.speaker,
      start_offset: span.start, end_offset: span.end, occurred_at: span.ts })) };
}

async function fixture(t) {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  const source = (await db.client.query("insert into brain_dev.sources(kind,label) values('claude_code_session',$1) returning id", [randomUUID()])).rows[0];
  return { ...db, sourceId: source.id };
}

test("500 session messages commit with fewer than 20 database round trips", async t => {
  const db = await fixture(t);
  const turns = Array.from({ length: 500 }, (_, i) => ({
    speaker: i % 2 ? "assistant" : "tony", text: `Synthetic throughput fixture message ${i}`,
    ts: i % 3 ? null : "2026-09-24T00:00:00.000Z",
  }));
  let calls = 0;
  const measured = { query: (...args) => { calls++; return db.client.query(...args); } };
  const started = performance.now();
  const result = await syncSession(measured, "brain_dev", packet(db.sourceId, turns));
  t.diagnostic(JSON.stringify({ messages: 500, databaseCalls: calls, localElapsedMs: Number((performance.now() - started).toFixed(2)) }));
  assert.equal(result.evidence_count, 500);
  const rows = (await db.client.query("select quote,speaker,occurred_at from brain_dev.evidence where episode_id=$1 order by start_offset", [result.id])).rows;
  assert.equal(rows.length, 500);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].quote, turns[i].text);
    assert.equal(rows[i].speaker, turns[i].speaker);
    assert.equal(rows[i].occurred_at?.toISOString() ?? null, turns[i].ts);
  }
  assert.ok(calls < 20, `capture used ${calls} database round trips`);
});

test("a failure after successful evidence writes rolls back the full episode and checkpoint", async t => {
  const db = await fixture(t);
  await db.client.query("alter table brain_dev.evidence add constraint reject_fixture check (quote <> 'database rejection sentinel')");
  const turns = Array.from({ length: 1201 }, (_, i) => ({ speaker: "tony", text: i === 1200 ? "database rejection sentinel" : `Synthetic rollback message ${i}`, ts: null }));
  let successfulEvidenceWrites = 0;
  const measured = { query: async (...args) => {
    const result = await db.client.query(...args);
    if (/insert into .*evidence\b/i.test(args[0])) successfulEvidenceWrites++;
    return result;
  } };
  await assert.rejects(syncSession(measured, "brain_dev", packet(db.sourceId, turns)), error => error.code === "23514");
  assert.ok(successfulEvidenceWrites > 0, "failure happened after an earlier evidence write succeeded");
  for (const table of ["episodes", "evidence", "session_ingest_checkpoints"]) {
    assert.equal((await db.client.query(`select count(*)::int n from brain_dev.${table}`)).rows[0].n, 0);
  }
});

test("evidence batches bound encoded bytes without splitting a large message", async t => {
  const db = await fixture(t);
  const text = '\u00e9"\\\n'.repeat(200000);
  const turns = Array.from({ length: 3 }, (_, i) => ({ speaker: "tony", text: `${i} ${text}`, ts: null }));
  turns.push({ speaker: "tony", text: "one intact oversized message " + "x ".repeat(2300000) + "end", ts: null });
  const writes = [];
  const measured = { query: async (...args) => {
    const result = await db.client.query(...args);
    if (/insert into .*evidence\b/i.test(args[0])) {
      const bytes = (args[1] ?? []).reduce((sum, value) => sum + Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null)), 0);
      writes.push({ bytes, rows: result.rowCount });
    }
    return result;
  } };
  const saved = await syncSession(measured, "brain_dev", packet(db.sourceId, turns));
  assert.equal(saved.evidence_count, turns.length);
  assert.ok(writes.every(write => write.bytes <= 4 * 1024 * 1024 || write.rows === 1));
  assert.ok(writes.some(write => write.bytes > 4 * 1024 * 1024 && write.rows === 1));
  const rows = (await db.client.query("select e.raw,v.quote,v.start_offset,v.end_offset from brain_dev.evidence v join brain_dev.episodes e on e.id=v.episode_id where e.id=$1 order by v.start_offset", [saved.id])).rows;
  assert.deepEqual(rows.map(row => row.quote), turns.map(turn => turn.text));
  for (const row of rows) assert.equal(row.raw.slice(row.start_offset, row.end_offset), row.quote);
});
