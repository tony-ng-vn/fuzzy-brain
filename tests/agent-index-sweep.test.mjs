import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { indexStatus } from "../scripts/lib/index-status.mjs";
import * as sweep from "../scripts/embed-sweep.mjs";

test("a bounded index repair touches only missing vectors in the requested archive", async t => {
  assert.equal(typeof sweep.runEmbeddingSweep, "function");
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const client = database.client;
  const source = randomUUID();
  await client.query("insert into brain_dev.sources(id,kind,label) values($1,'index_test','Index test')", [source]);
  const opts = { authorized: true, allowedSourceIds: [source] };
  const first = await importTransfer(client, "brain_dev", fixture({ source_id: source }), opts);
  const other = await importTransfer(client, "brain_dev", fixture({ source_id: source, source_key: "other" }), opts);
  await client.query("insert into brain_dev.nodes(type,title,raw,body) values('note','Pending node','Same raw','Same raw')");
  const sourceBefore = await client.query("select id,quote,speaker from brain_dev.evidence order by id");
  let embedded = 0;
  const embed = async texts => { embedded += texts.length; return texts.map(() => [1, ...Array(767).fill(0)]); };
  const config = { schema: "brain_dev", scope: { receipt_id: first.id }, limit: 1, embed };
  assert.deepEqual(await sweep.runEmbeddingSweep(client, config), { evidence: 1, nodes: 0 });
  assert.equal((await indexStatus(client, "brain_dev", config.scope)).evidence.pending, 1);
  assert.deepEqual(await sweep.runEmbeddingSweep(client, config), { evidence: 1, nodes: 0 });
  assert.deepEqual(await sweep.runEmbeddingSweep(client, config), { evidence: 0, nodes: 0 });
  assert.equal(embedded, 2);
  assert.equal((await indexStatus(client, "brain_dev", { receipt_id: other.id })).evidence.pending, 2);
  assert.equal((await indexStatus(client, "brain_dev")).nodes.pending, 1);
  assert.deepEqual((await client.query("select id,quote,speaker from brain_dev.evidence order by id")).rows, sourceBefore.rows);
  assert.deepEqual(await sweep.runEmbeddingSweep(client, { ...config, scope: { source_id: source }, limit: 3 }), { evidence: 2, nodes: 0 });
  assert.deepEqual(await sweep.runEmbeddingSweep(client, { ...config, scope: {}, limit: 1 }), { evidence: 0, nodes: 1 });
});

test("index repair validates scope and row bounds before database work", async () => {
  assert.equal(typeof sweep.parseSweepArgs, "function");
  assert.deepEqual(sweep.parseSweepArgs(["--receipt-id", "11111111-1111-4111-8111-111111111111", "--limit", "4"]), {
    scope: { receipt_id: "11111111-1111-4111-8111-111111111111" }, limit: 4,
  });
  for (const args of [["--limt", "4"], ["--limit"], ["--limit", "0"], ["--limit", "-1"], ["--limit", "1.2"], ["--limit", "2", "--limit", "3"], ["--source-id", "bad"], ["--source-id", randomUUID(), "--receipt-id", randomUUID()]]) {
    assert.throws(() => sweep.parseSweepArgs(args), { code: "invalid" });
  }
  const client = { query() { throw new Error("database must not run"); } };
  await assert.rejects(sweep.runEmbeddingSweep(client, { schema: "brain_dev", limit: 0 }), { code: "invalid" });
});
