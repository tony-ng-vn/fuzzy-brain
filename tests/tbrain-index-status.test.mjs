import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer, readReceipt } from "../scripts/lib/tbrain-store.mjs";
import { indexStatus } from "../scripts/lib/index-status.mjs";

test("index status separates committed sources from pending semantic search", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const client = database.client;
  const source = randomUUID();
  await client.query("insert into brain_dev.sources(id,kind,label) values($1,'index_test','Index test')", [source]);
  const empty = await indexStatus(client, "brain_dev", { source_id: source });
  assert.equal(empty.semantic_index.state, "empty");
  const receipt = await importTransfer(client, "brain_dev", fixture({ source_id: source }), { authorized: true, allowedSourceIds: [source] });
  const before = await readReceipt(client, "brain_dev", receipt.id);
  await client.query("insert into brain_dev.nodes(type,title,raw,body) values('note','Pending node','Same raw','Same raw')");
  const pending = await indexStatus(client, "brain_dev", { receipt_id: receipt.id });
  assert.deepEqual(pending.evidence, { total: 2, indexed: 0, pending: 2 });
  assert.equal(pending.nodes, null);
  assert.equal(pending.semantic_index.state, "pending");
  assert.equal(pending.text_search_available, true);
  assert.equal(pending.scope.receipt_id, receipt.id);
  assert.doesNotMatch(JSON.stringify(pending), /Maybe I could|Same raw/);
  const vector = `[${[1, ...Array(767).fill(0)].join(",")}]`;
  await client.query("update brain_dev.evidence set embedding=$1::vector where id=$2", [vector, receipt.evidence_ids[0]]);
  const partial = await indexStatus(client, "brain_dev", { source_id: source });
  assert.deepEqual(partial.evidence, { total: 2, indexed: 1, pending: 1 });
  assert.equal(partial.nodes, null);
  await client.query("update brain_dev.evidence set embedding=$1::vector where id=$2", [vector, receipt.evidence_ids[1]]);
  const complete = await indexStatus(client, "brain_dev", { receipt_id: receipt.id });
  assert.equal(complete.semantic_index.state, "complete");
  const all = await indexStatus(client, "brain_dev");
  assert.deepEqual(all.nodes, { total: 1, indexed: 0, pending: 1 });
  assert.equal(all.semantic_index.state, "pending");
  assert.deepEqual(await readReceipt(client, "brain_dev", receipt.id), before);
  await assert.rejects(indexStatus(client, "brain_dev", { receipt_id: randomUUID() }), { code: "not_found" });
  await assert.rejects(indexStatus(client, "brain_dev", { source_id: randomUUID() }), { code: "not_found" });
});

test("index filters reject ambiguity and invalid identifiers before database work", async () => {
  const client = { query() { throw new Error("database must not run"); } };
  for (const input of [{ source_id: "bad" }, { receipt_id: "bad" }, { source_id: randomUUID(), receipt_id: randomUUID() }, { typo: true }]) {
    await assert.rejects(indexStatus(client, "brain_dev", input), { code: "invalid" });
  }
});
