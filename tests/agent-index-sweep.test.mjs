import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { indexStatus } from "../scripts/lib/index-status.mjs";
import * as sweep from "../scripts/embed-sweep.mjs";

test("global index repair shares its row budget between nodes and archived passages", async t => {
  for (const scenario of [
    { evidence: 6, nodes: 6, limit: 4, expected: { evidence: 2, nodes: 2 } },
    { evidence: 6, nodes: 1, limit: 4, expected: { evidence: 3, nodes: 1 } },
    { evidence: 1, nodes: 6, limit: 4, expected: { evidence: 1, nodes: 3 } },
    { evidence: 6, nodes: 6, limit: 1, expected: { evidence: 0, nodes: 1 } },
    { evidence: 2, nodes: 2, limit: null, expected: { evidence: 2, nodes: 2 } },
  ]) {
    await t.test(JSON.stringify(scenario), async t => {
      const database = await createTbrainTestDatabase();
      t.after(() => database.close());
      const client = database.client;
      const source = randomUUID(), episode = randomUUID();
      await client.query("insert into brain_dev.sources(id,kind,label) values($1,'index_test','Budget test')", [source]);
      await client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'Synthetic passage')", [episode, source]);
      for (let i = 0; i < scenario.evidence; i++) {
        await client.query("insert into brain_dev.evidence(episode_id,quote,start_offset,end_offset) values($1,'Synthetic passage',$2,$3)", [episode, i * 20, i * 20 + 17]);
      }
      for (let i = 0; i < scenario.nodes; i++) {
        await client.query("insert into brain_dev.nodes(type,title,raw,body) values('note','Saved node','Original words','Original words')");
      }
      let embedded = 0;
      const embed = async texts => { embedded += texts.length; return texts.map(() => [1, ...Array(767).fill(0)]); };
      const result = await sweep.runEmbeddingSweep(client, { schema: "brain_dev", limit: scenario.limit, embed });
      assert.deepEqual(result, scenario.expected);
      assert.equal(embedded, result.evidence + result.nodes);
      if (scenario.limit !== null) assert.ok(embedded <= scenario.limit);
      const status = await indexStatus(client, "brain_dev");
      assert.equal(status.nodes.pending, scenario.nodes - result.nodes);
      assert.equal(status.evidence.pending, scenario.evidence - result.evidence);
    });
  }
});

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

test("an indexing time allowance spans both layers and commits a partial page before stopping", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const client = database.client;
  const source = randomUUID(), episode = randomUUID();
  await client.query("insert into brain_dev.sources(id,kind,label) values($1,'index_test','Timed sweep')", [source]);
  await client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'Original text')", [episode, source]);
  for (let i = 0; i < 5; i++) await client.query("insert into brain_dev.evidence(episode_id,quote,start_offset,end_offset) values($1,$2,$3,$4)", [episode, `Passage ${i}`, i * 20, i * 20 + 9]);
  for (let i = 0; i < 2; i++) await client.query("insert into brain_dev.nodes(type,title,raw,body) values('note','Original node','Original words','Original words')");
  const before = (await client.query("select id,quote,start_offset,end_offset from brain_dev.evidence order by id")).rows;
  let clock = 0, calls = 0;
  const embed = async texts => { calls++; clock += 10; return texts.map(() => [1, ...Array(767).fill(0)]); };
  const result = await sweep.runEmbeddingSweep(client, { schema: "brain_dev", limit: 6, maxDurationMs: 25, now: () => clock, embed });
  assert.deepEqual(result, { nodes: 2, evidence: 1, time_limit_reached: true });
  assert.equal(calls, 3);
  assert.equal((await indexStatus(client, "brain_dev")).evidence.pending, 4);
  assert.equal((await indexStatus(client, "brain_dev")).nodes.pending, 0);
  assert.deepEqual((await client.query("select id,quote,start_offset,end_offset from brain_dev.evidence order by id")).rows, before);
  clock = 0;
  const resumed = await sweep.runEmbeddingSweep(client, { schema: "brain_dev", limit: 6, maxDurationMs: 100, now: () => clock, embed });
  assert.deepEqual(resumed, { nodes: 0, evidence: 4, time_limit_reached: false });
  assert.equal(calls, 7, "resume must not recompute committed vectors");
});

test("an elapsed time allowance starts no model work and the row cap still applies", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const client = database.client;
  await client.query("insert into brain_dev.nodes(type,title,raw,body) values('note','Original node','Original words','Original words')");
  let clock = 0, embedded = 0;
  const delayed = { query: async (...args) => { const result = await client.query(...args); clock += 50; return result; } };
  const embed = async texts => { embedded++; return texts.map(() => [1, ...Array(767).fill(0)]); };
  assert.deepEqual(await sweep.runEmbeddingSweep(delayed, { schema: "brain_dev", limit: 4, maxDurationMs: 25, now: () => clock, embed }), {
    nodes: 0, evidence: 0, time_limit_reached: true,
  });
  assert.equal(embedded, 0);
  assert.equal((await indexStatus(client, "brain_dev")).nodes.pending, 1);
  assert.deepEqual(await sweep.runEmbeddingSweep(client, { schema: "brain_dev", limit: 1, maxDurationMs: 100, now: () => clock, embed }), {
    nodes: 1, evidence: 0, time_limit_reached: false,
  });
  assert.equal(embedded, 1);
});

test("indexing time arguments reject invalid allowances before reading the database", async () => {
  assert.deepEqual(sweep.parseSweepArgs(["--limit", "256", "--max-seconds", "30"]), { scope: {}, limit: 256, maxDurationMs: 30000 });
  const client = { query() { assert.fail("invalid time allowance must not read the database"); } };
  for (const maxDurationMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(sweep.runEmbeddingSweep(client, { maxDurationMs }), { code: "invalid" });
  }
  for (const args of [["--max-seconds"], ["--max-seconds", "0"], ["--max-seconds", "-1"], ["--max-seconds", "1.5"], ["--max-seconds", "Infinity"], ["--max-seconds", "1", "--max-seconds", "2"]]) {
    assert.throws(() => sweep.parseSweepArgs(args), { code: "invalid" });
  }
});
