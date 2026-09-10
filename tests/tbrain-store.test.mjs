import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { makeClient } from "../scripts/brain.mjs";
import { loadEnvLocal } from "../scripts/recall.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer, readReceipt, readArchive, readSource, searchArchive } from "../scripts/lib/tbrain-store.mjs";

loadEnvLocal();

test("portable archive transactions on isolated development schema", async t => {
  const database = await createTbrainTestDatabase();
  const client = database.client;
  const schema = "brain_dev";
  const sourceId = randomUUID();
  const opts = { authorized: true, allowedSourceIds: [sourceId] };
  const packet = () => fixture({ source_id: sourceId, source_key: randomUUID() });
  let first;
  const timings = [];
  try {
    await client.query("insert into brain_dev.sources(id,kind,label) values ($1,'tbrain_test',$2)", [sourceId, sourceId]);
    await t.test("unauthorized imports leave no record", async () => {
      await assert.rejects(importTransfer(client, schema, packet()), { code: "unauthorized" });
      await assert.rejects(importTransfer(client, schema, packet(), { authorized: true, allowedSourceIds: [] }), { code: "unauthorized" });
    });
    await t.test("capture commits a receipt and source without ratification", async () => {
      first = packet();
      const before = await client.query("select (select count(*) from brain_dev.nodes) as nodes, (select count(*) from brain_dev.edges) as edges");
      const start = performance.now();
      const r = await importTransfer(client, schema, first, opts); timings.push(performance.now() - start);
      assert.equal(r.state, "committed"); first.receipt = r;
      const after = await client.query("select (select count(*) from brain_dev.nodes) as nodes, (select count(*) from brain_dev.edges) as edges");
      assert.deepEqual(after.rows, before.rows);
      const view = await readArchive(client, schema, { id: r.id });
      assert.equal(view.messages[0].text, first.messages[0].text);
      assert.equal(view.reflection.author, "assistant");
      assert.equal(view.reflection.status, "provisional");
      assert.equal(view.messages[0].at, null);
    });
    await t.test("100 deliveries preserve one logical record and receipt", async () => {
      const { receipt, ...input } = first;
      for (let i = 0; i < 100; i++) {
        const r = await importTransfer(client, schema, input, opts);
        assert.equal(r.id, receipt.id); assert.equal(r.replayed, true);
      }
      const count = await client.query("select count(*)::int n from brain_dev.archive_records where source_id=$1 and source_key=$2", [sourceId, input.source_key]);
      assert.equal(count.rows[0].n, 1);
    });
    await t.test("same identity with conflicting text fails instead of overwriting", async () => {
      const { receipt, ...input } = structuredClone(first); input.messages[0].text = "Conflicting source text.";
      await assert.rejects(importTransfer(client, schema, input, opts), { code: "conflict" });
      assert.equal((await readArchive(client, schema, { id: receipt.id })).messages[0].text, first.messages[0].text);
    });
    await t.test("fresh connection reads the durable receipt", async () => {
      const fresh = makeClient({ connectionString: database.url }); await fresh.connect();
      try { assert.equal((await readReceipt(fresh, schema, first.receipt.id)).digest, first.receipt.digest); }
      finally { await fresh.end(); }
    });
    await t.test("older history is searchable before embedding", async () => {
      const p = packet(); p.messages[0].text = "I tried astrolabe pottery in 1998."; p.messages[0].at = "1998-05-02T01:00:00Z";
      await importTransfer(client, schema, p, opts);
      const start = performance.now(); const found = await searchArchive(client, schema, { query: "astrolabe" }); timings.push(performance.now() - start);
      assert.ok(found.hits.some(h => h.text.includes("astrolabe")));
      assert.equal(found.exhaustive, false);
    });
    await t.test("explicit dates restrict results without inventing dates", async () => {
      const result = await searchArchive(client, schema, { query: "astrolabe", from: "2026-01-01T00:00:00Z" });
      assert.equal(result.hits.length, 0); assert.equal(result.state, "no_matches");
    });
    await t.test("correction keeps earlier source and gives it a visible successor", async () => {
      const { receipt, ...p } = structuredClone(first); p.revision = "2";
      p.messages[0].text = "Correction: I meant sculpture.";
      p.relation = { receipt_id: receipt.id, kind: "correction", note: "User corrected the activity." };
      const r = await importTransfer(client, schema, p, opts);
      const old = await readArchive(client, schema, { id: receipt.id });
      assert.equal(old.messages[0].text, first.messages[0].text);
      assert.ok(old.related.some(x => x.id === r.id));
    });
    await t.test("new revision requires explicit structural lineage", async () => {
      const p = structuredClone(first); delete p.receipt; p.revision = "3";
      await assert.rejects(importTransfer(client, schema, p, opts), { code: "conflict" });
    });
    await t.test("unknown relation rolls back all inserts", async () => {
      const p = packet(); p.relation = { receipt_id: randomUUID(), kind: "supplements", note: "Unavailable parent" };
      await assert.rejects(importTransfer(client, schema, p, opts), { code: "not_found" });
      const rows = await client.query("select * from brain_dev.archive_records where source_key=$1", [p.source_key]); assert.equal(rows.rowCount, 0);
    });
    await t.test("source exclusions reject the entire packet including reflection", async () => {
      await client.query("update brain_dev.sources set exclusions=$2 where id=$1", [sourceId, JSON.stringify([{kind:"topic",value:"classified"}])]);
      const p = packet(); p.reflection.text = "classified";
      await assert.rejects(importTransfer(client, schema, p, opts), { code: "excluded" });
      await client.query("update brain_dev.sources set exclusions='[]' where id=$1", [sourceId]);
    });
    await t.test("exclusions match decoded quotes and line breaks", async () => {
      const value='private "quoted"\nmaterial';
      await client.query("update brain_dev.sources set exclusions=$2 where id=$1",[sourceId,JSON.stringify([{kind:"topic",value}])]);
      const p=packet();p.messages[0].text=value;
      await assert.rejects(importTransfer(client,schema,p,opts),{code:"excluded"});
      await client.query("update brain_dev.sources set exclusions='[]' where id=$1",[sourceId]);
    });
    await t.test("paging source context is bounded and preserves order", async () => {
      const view = await readArchive(client, schema, { id: first.receipt.id, offset: 1, limit: 1 });
      assert.equal(view.messages.length, 1); assert.equal(view.messages[0].role, "assistant");
      assert.equal(view.total_messages, 2);
    });
    await t.test("missing receipt is distinct from failed retrieval", async () => {
      await assert.rejects(readReceipt(client, schema, randomUUID()), { code: "not_found" });
    });
    await t.test("stored source and receipt reject direct mutation", async () => {
      await assert.rejects(client.query("update brain_dev.archive_records set revision='changed' where id=$1", [first.receipt.id]), /append-only/);
      await assert.rejects(client.query("update brain_dev.episodes set raw='changed' where id=$1", [first.receipt.episode_id]), /append-only/);
      await assert.rejects(client.query("update brain_dev.evidence set quote='changed' where id=$1", [first.receipt.evidence_ids[0]]), /append-only/);
    });
    await t.test("redacted export is safely replayable without restoring secrets", async () => {
      const p=packet();p.messages[0].text="SSN 123-45-6789";
      const receipt=await importTransfer(client,schema,p,opts);
      const row=(await client.query("select bundle from brain_dev.archive_records where id=$1",[receipt.id])).rows[0];
      const replay=await importTransfer(client,schema,row.bundle,opts);
      assert.equal(replay.id,receipt.id);
      p.messages[0].text="SSN 234-56-7890";
      await assert.rejects(importTransfer(client,schema,p,opts),{code:"conflict"});
    });
    await t.test("original source bytes can be inspected in bounded chunks", async () => {
      const p=packet();p.coverage.kind="source_export";p.original={media_type:"text/plain",text:"line 1\r\nline 2\n"};
      const receipt=await importTransfer(client,schema,p,opts);
      const source=await readSource(client,schema,{id:receipt.id,offset:6,limit:4});
      assert.equal(source.text,p.original.text.slice(6,10));
      assert.equal(source.origin,"provided_source_export");
    });
    await t.test("long message readback has explicit continuation", async () => {
      const p=packet();p.messages[0].text="a".repeat(16000);
      const receipt=await importTransfer(client,schema,p,opts);
      const view=await readArchive(client,schema,{id:receipt.id,limit:1,text_limit:1000});
      assert.equal(view.messages[0].text.length,1000);
      assert.equal(view.messages[0].next_text_offset,1000);
    });
    t.diagnostic(`Local PostgreSQL capture and lexical search ms: ${timings.map(x=>x.toFixed(2)).join(", ")}`);
  } finally {
    await database.close();
  }
});
