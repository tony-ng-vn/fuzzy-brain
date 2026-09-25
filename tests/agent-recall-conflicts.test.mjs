import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { recall } from "../scripts/recall.mjs";
import { getNode, schemaTables } from "../scripts/brain.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFuzzyBrainServer } from "../scripts/fuzzy-brain-mcp.mjs";
import { createTbrainServer } from "../scripts/tbrain-mcp.mjs";

test("recall claims a conflict only for an explicit link between returned nodes", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  const first = randomUUID(), second = randomUUID();
  await db.client.query(`insert into brain_dev.nodes(id,type,title,raw,body,created_at) values
    ($1,'moment','Copper orchard meeting','The copper orchard meeting is Monday.','The copper orchard meeting is Monday.','2026-09-20'),
    ($2,'moment','Copper orchard schedule','The copper orchard meeting is Tuesday.','The copper orchard meeting is Tuesday.','2026-09-10')`, [first, second]);
  const edge = (await db.client.query("insert into brain_dev.edges(source,target,why) values($1,$2,'These memories do not contradict each other.') returning id", [first, second])).rows[0].id;
  const read = filters => recall("copper orchard", { client: db.client, schema: "brain_dev", embedQuery: async () => null, layer: "nodes", ...filters });

  await t.test("a free-form mention or negation is not an explicit conflict label", async () => {
    for (const why of ["These memories do not contradict each other.", "The earlier claim was called contradictory, but Tony has not agreed."]) {
      await db.client.query("update brain_dev.edges set why=$2 where id=$1", [edge, why]);
      const result = await read();
      assert.equal(result.hits.filter(hit => hit.layer === "node").length, 2);
      assert.equal(result.state, "supported");
      assert.ok(result.hits.some(hit => hit.edges.some(link => link.why === why)));
    }
  });
  await t.test("an explicit contradiction preserves both sides", async () => {
    await db.client.query("update brain_dev.edges set why='contradicts: the meeting dates disagree.' where id=$1", [edge]);
    const result = await read();
    assert.equal(result.state, "conflicting");
    assert.deepEqual(new Set(result.hits.filter(hit => hit.layer === "node").map(hit => hit.node_id)), new Set([first, second]));
  });
  await t.test("a date-excluded node cannot count as a shown side of a conflict", async () => {
    const result = await read({ from: "2026-09-15T00:00:00Z" });
    assert.deepEqual(result.hits.map(hit => hit.node_id), [first]);
    assert.equal(result.state, "supported");
    assert.ok(result.hits[0].edges.some(link => link.target_title === "Copper orchard schedule"));
  });
  await t.test("either server can open the other end of a returned connection", async () => {
    const result = await read({ from: "2026-09-15T00:00:00Z" });
    const link = result.hits[0].edges[0];
    assert.equal(link.source_id, first);
    assert.equal(link.target_id, second);
    assert.deepEqual(link.read, { tool: "get_node", arguments: { id: second } });
    for (const create of [createFuzzyBrainServer, createTbrainServer]) {
      const server = create({ getNode: id => getNode(db.client, schemaTables("brain_dev"), id) });
      const client = new Client({ name: "connection-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      try {
        const reply = await client.callTool({ name: link.read.tool, arguments: link.read.arguments });
        assert.notEqual(reply.isError, true);
        const node = JSON.parse(reply.content[0].text);
        assert.equal(node.id, second);
        assert.equal(node.raw, "The copper orchard meeting is Tuesday.");
      } finally { await client.close(); }
    }
    const both = await read();
    const reverse = both.hits.find(hit => hit.node_id === second).edges[0];
    assert.deepEqual(reverse.read, { tool: "get_node", arguments: { id: first } });
  });
});
