import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

test("literal node titles survive common-word removal and keep recall restrictions", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  const id = randomUUID();
  await db.client.query("insert into brain_dev.nodes(id,type,title,raw,body,created_at) values($1,'note','here but not here','Original thought','A separate description','2026-09-01T00:00:00Z')", [id]);
  await db.client.query("insert into brain_dev.nodes(type,title,raw,body) values('note','Different title','here but not here','here but not here')");
  const base = { client: db.client, schema: "brain_dev", layer: "nodes", embedQuery: async () => null };
  for (const fallback of [false, true]) {
    await t.test(fallback ? "per-lane fallback" : "fused retrieval", async () => {
      const client = { query(sql, values) {
        if (fallback && / as lane\b/.test(sql)) throw new Error("Synthetic fused query failure");
        return db.client.query(sql, values);
      } };
      for (const question of ["here but not here", "HERE BUT NOT HERE", '"here but not here"']) {
        const result = await recall(question, { ...base, client });
        assert.equal(result.state, "supported");
        assert.deepEqual(result.hits.map(hit => hit.node_id), [id]);
        assert.equal(result.hits[0].match_strength, "strong");
        assert.equal(result.degraded, fallback);
      }
      const dated = await recall("here but not here", { ...base, client, from: "2026-09-02T00:00:00Z" });
      assert.equal(dated.hits.length, 0);
      const evidence = await recall("here but not here", { ...base, client, layer: "evidence" });
      assert.equal(evidence.hits.length, 0);
      const absent = await recall("the and", { ...base, client });
      assert.equal(absent.state, "missing");
    });
  }
});

test("an exact node title is admitted before many incidental body matches", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  const id = randomUUID();
  await db.client.query("insert into brain_dev.nodes(type,title,raw,body) select 'note','Other memory','walnut repair','walnut repair' from generate_series(1,32)");
  await db.client.query("insert into brain_dev.nodes(id,type,title,raw,body) values($1,'note','walnut repair',$2,$2)", [id, "A long unrelated description. ".repeat(3000)]);
  const result = await recall("walnut repair", { client: db.client, schema: "brain_dev", layer: "nodes", embedQuery: async () => null });
  assert.equal(result.hits[0].node_id, id);
});
