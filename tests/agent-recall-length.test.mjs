import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

test("long pasted text cannot crowd a focused passage out of lexical recall", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const client = database.client;
  const source = randomUUID(), episode = randomUUID();
  await client.query("insert into brain_dev.sources(id,kind,label) values($1,'recall_test','Length test')", [source]);
  await client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'Synthetic text')", [episode, source]);
  for (const layer of ["evidence", "nodes"]) {
    await t.test(layer, async () => {
      const query = layer === "evidence" ? "writing corrections" : "budget reminder";
      const focused = randomUUID();
      const text = `My ${query} are specific to this short note.`;
      const noise = `An unrelated pasted document. ${`${query} `.repeat(40)}${"unrelated background material about weather and vehicles ".repeat(1500)}`;
      if (layer === "evidence") {
        await client.query("insert into brain_dev.evidence(episode_id,quote,start_offset,end_offset,speaker) select $1,$2,i*100000,i*100000+length($2),'tony' from generate_series(1,32) i", [episode, noise]);
        await client.query("insert into brain_dev.evidence(id,episode_id,quote,start_offset,end_offset,speaker) values($1,$2,$3,0,length($3),'tony')", [focused, episode, text]);
      } else {
        await client.query("insert into brain_dev.nodes(type,title,raw,body) select 'note','Synthetic pasted document',$1,$1 from generate_series(1,32)", [noise]);
        await client.query("insert into brain_dev.nodes(id,type,title,raw,body) values($1,'note','Synthetic focused note',$2,$2)", [focused, text]);
      }
      const result = await recall(query, { client, schema: "brain_dev", layer, embedQuery: async () => null });
      const first = result.hits[0];
      assert.equal(layer === "evidence" ? first.provenance.evidence_id : first.node_id, focused);
    });
  }
  const unique = randomUUID();
  const longText = `${"unrelated material ".repeat(1500)}I visited the zephyrloom workshop.`;
  await client.query("insert into brain_dev.evidence(id,episode_id,quote,start_offset,end_offset,speaker) values($1,$2,$3,4000000,4000000+length($3),'tony')", [unique, episode, longText]);
  const found = await recall("zephyrloom", { client, schema: "brain_dev", embedQuery: async () => null });
  assert.equal(found.hits[0].provenance.evidence_id, unique, "long sources remain retrievable when they carry the match");
  assert.equal((await client.query("select quote from brain_dev.evidence where id=$1", [unique])).rows[0].quote, longText);
});
