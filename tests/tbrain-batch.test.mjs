import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer, readArchive, readReceipt } from "../scripts/lib/tbrain-store.mjs";

async function setup(t, count) {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  const source = (await db.client.query("insert into brain_dev.sources(kind,label) values('archive_test',$1) returning id", [randomUUID()])).rows[0];
  const packet = fixture({ source_id: source.id, source_key: randomUUID(), reflection: null,
    messages: Array.from({ length: count }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? "assistant" : "user",
      speaker: i % 2 ? null : "Synthetic speaker", text: `Synthetic archive message ${i}`,
      at: i % 3 ? null : "2026-09-24T00:00:00.000Z", fidelity: "verbatim" })) });
  return { db, packet, options: { authorized: true, allowedSourceIds: [source.id] } };
}

test("500 portable archive messages commit and read back with fewer than 20 database calls", async t => {
  const { db, packet, options } = await setup(t, 500);
  let calls = 0;
  const measured = { query: (...args) => { calls++; return db.client.query(...args); } };
  const start = performance.now();
  const saved = await importTransfer(measured, "brain_dev", packet, options);
  t.diagnostic(JSON.stringify({ messages: 500, databaseCalls: calls, localElapsedMs: Number((performance.now() - start).toFixed(2)) }));
  assert.equal(saved.message_count, 500);
  const rows = (await db.client.query("select m.ordinal,v.id,v.quote,v.speaker,v.occurred_at from brain_dev.archive_messages m join brain_dev.evidence v on v.id=m.evidence_id where m.archive_id=$1 order by m.ordinal", [saved.id])).rows;
  assert.deepEqual(rows.map(row => row.id), saved.evidence_ids);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].ordinal, i);
    assert.equal(rows[i].quote, packet.messages[i].text);
    assert.equal(rows[i].speaker, packet.messages[i].role);
    assert.equal(rows[i].occurred_at?.toISOString() ?? null, packet.messages[i].at);
  }
  const read = await readArchive(db.client, "brain_dev", { id: saved.id, offset: 490, limit: 10 });
  assert.deepEqual(read.messages.map(message => message.text), packet.messages.slice(490).map(message => message.text));
  assert.deepEqual(read.messages.map(message => message.evidence_id), saved.evidence_ids.slice(490));
  assert.equal((await readReceipt(db.client, "brain_dev", saved.id)).digest, saved.digest);
  assert.equal((await importTransfer(db.client, "brain_dev", packet, options)).id, saved.id);
  assert.ok(calls < 20, `archive used ${calls} database round trips`);
});

test("archive association failure rolls back every earlier evidence batch and receipt", async t => {
  const { db, packet, options } = await setup(t, 1201);
  await db.client.query("alter table brain_dev.archive_messages add constraint reject_fixture check (ordinal <> 1200)");
  let evidenceWritten = 0;
  const measured = { query: async (...args) => {
    const result = await db.client.query(...args);
    if (/insert into .*evidence\b/i.test(args[0])) evidenceWritten += result.rowCount;
    return result;
  } };
  await assert.rejects(importTransfer(measured, "brain_dev", packet, options), error => error.code === "23514");
  assert.equal(evidenceWritten, 1201);
  for (const table of ["episodes", "evidence", "archive_records", "archive_messages"]) {
    assert.equal((await db.client.query(`select count(*)::int n from brain_dev.${table}`)).rows[0].n, 0);
  }
});
