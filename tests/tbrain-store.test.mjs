import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { makeClient } from "../scripts/brain.mjs";
import { loadEnvLocal } from "../scripts/recall.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer, readReceipt, readArchive, searchArchive } from "../scripts/lib/tbrain-store.mjs";

loadEnvLocal();

test("portable archive transactions on isolated development schema", async t => {
  const client = makeClient({ connectionString: process.env.DATABASE_URL_DEV });
  await client.connect();
  const schema = "brain_dev";
  const sourceId = randomUUID();
  const opts = { authorized: true, allowedSourceIds: [sourceId] };
  const packet = () => fixture({ source_id: sourceId, source_key: randomUUID() });
  let first;
  const timings = [];
  try {
    await client.query("begin");
    await client.query("set local search_path to brain_dev, public");
    await client.query(readFileSync(new URL("../scripts/tbrain-schema.sql", import.meta.url), "utf8"));
    await client.query("commit");
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
      const fresh = makeClient({ connectionString: process.env.DATABASE_URL_DEV }); await fresh.connect();
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
      const { receipt: _receipt, ...p } = structuredClone(first); p.revision = "3";
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
    });
    t.diagnostic(`Local PostgreSQL capture and lexical search ms: ${timings.map(x=>x.toFixed(2)).join(", ")}`);
  } finally {
    // Synthetic rows live only in brain_dev; retained for restart and backup checks.
    await client.end();
  }
});
