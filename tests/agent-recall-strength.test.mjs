import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

test("strong meaning matches survive a shortlist crowded by overlapping fragment matches", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const client = database.client;
  const source = randomUUID(), episode = randomUUID(), evidence = randomUUID(), node = randomUUID();
  const query = [1, ...Array(767).fill(0)];
  const weak = JSON.stringify([0.6, 0.8, ...Array(766).fill(0)]);
  const strong = JSON.stringify(query);
  await client.query("insert into brain_dev.sources(id,kind,label) values($1,'recall_test','Strength test')", [source]);
  await client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'Synthetic text')", [episode, source]);
  for (let i = 0; i < 32; i++) {
    const text = i % 2 ? `release automation fragment ${i}` : `understanding fragment ${i}`;
    await client.query("insert into brain_dev.evidence(episode_id,quote,start_offset,end_offset,speaker,embedding) values($1,$2,$3,$4,'tony',$5::vector)",
      [episode, text, i * 100, i * 100 + text.length, weak]);
    await client.query("insert into brain_dev.nodes(type,title,raw,body,embedding) values('note','Fragment',$1,$1,$2::vector)", [text, weak]);
  }
  const text = "I want to know why a change works before handing the task to a machine.";
  await client.query("insert into brain_dev.evidence(id,episode_id,quote,start_offset,end_offset,speaker,embedding) values($1,$2,$3,4000,4000+length($3),'tony',$4::vector)",
    [evidence, episode, text, strong]);
  await client.query("insert into brain_dev.nodes(id,type,title,raw,body,embedding) values($1,'note','Knowing the work',$2,$2,$3::vector)", [node, text, strong]);
  const options = { client, schema: "brain_dev", embedQuery: async () => query };
  const result = await recall("release automation understanding", options);
  const ids = result.hits.slice(0, 2).map(hit => hit.node_id ?? hit.provenance?.evidence_id);
  assert.deepEqual(new Set(ids), new Set([evidence, node]), "weak overlap must not crowd out strong meaning matches before or after reranking");
  assert.equal(result.hits.length, 10, "fragments may still fill the remaining places");

  const lexicalOnly = await recall("release automation understanding", { ...options, embedQuery: async () => null });
  assert.equal(lexicalOnly.state, "partial");
  assert.ok(lexicalOnly.hits.length > 0, "fragment search must still work when there is no strong match");
});
