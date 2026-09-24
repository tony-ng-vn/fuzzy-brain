import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { makeClient } from "../scripts/brain.mjs";

function command(databaseUrl, verb, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["scripts/brain.mjs", verb, ...args, "--json-errors"], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_DEV: databaseUrl, BRAIN_SCHEMA: "brain_dev" },
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

test("approved memory writes have durable retry identities across processes", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const run = (verb, input, args) => command(database.url, verb, input, args);
  const requestId = randomUUID();
  const raw = "  remember this exact thought\nwith its original spacing  ";
  const input = { request_id: requestId, type: "note", title: "Synthetic retry", raw, body: raw };
  const first = await run("add-node", input);

  await t.test("the same request returns one original node and a verifiable receipt", async () => {
    const again = await run("add-node", input);
    assert.equal(again.id, first.id);
    assert.equal(again.replayed, true);
    assert.equal(again.state, "committed");
    assert.equal(again.request_id, requestId);
    const receipt = await run("read-write-receipt", undefined, [requestId]);
    assert.equal(receipt.id, first.id);
    assert.equal(receipt.request_id, requestId);
    assert.equal((await database.client.query("select count(*)::int n from brain_dev.nodes where raw=$1", [raw])).rows[0].n, 1);
    assert.equal((await run("get-node", undefined, [first.id])).raw, raw);
  });

  await t.test("same identity with changed content fails instead of creating a new node", async () => {
    const result = await run("add-node", { ...input, raw: raw + " changed" });
    assert.equal(result.error.code, "conflict");
    const original = await run("get-node", undefined, [first.id]);
    assert.equal(original.raw, raw);
  });

  await t.test("UUID letter casing does not change a request identity or completion targets", async () => {
    const packet = { ...input, request_id: randomUUID().toUpperCase(), title: "UUID normalization" };
    const saved = await run("add-node", packet);
    assert.equal(saved.state, "committed");
    assert.equal(saved.request_id, packet.request_id.toLowerCase());
    assert.equal((await run("add-node", { ...packet, request_id: packet.request_id.toLowerCase() })).id, saved.id);
    const completion = { request_id: randomUUID(), node_ids: [saved.id, saved.id.toUpperCase()], raw: "mark this complete" };
    const result = await run("mark-complete", completion);
    assert.equal(result.events.length, 1);
    assert.equal((await run("mark-complete", { ...completion, node_ids: [saved.id] })).replayed, true);
  });

  await t.test("invalid timestamps return input errors without creating a receipt", async () => {
    for (const deadline_at of ["tomorrow", "", "2026-99-99T00:00:00Z"]) {
      const packet = { ...input, request_id: randomUUID(), deadline_at };
      assert.equal((await run("add-node", packet)).error.code, "invalid");
      assert.equal((await run("read-write-receipt", undefined, [packet.request_id])).error.code, "not_found");
    }
  });

  await t.test("replay survives later approved readable and deadline changes", async () => {
    await run("set-readable", { body: "Newly approved readable layer", title: "A later approved title" }, [first.id]);
    await run("set-deadline", { due_at: "2031-05-02T00:00:00Z", raw: "set this deadline", origin: "explicit" }, [first.id]);
    const replay = await run("add-node", input);
    assert.equal(replay.id, first.id);
    assert.equal(replay.title, first.title);
    assert.equal((await run("get-node", undefined, [first.id])).body, "Newly approved readable layer");
  });

  await t.test("concurrent memory deliveries commit one identity", async () => {
    const packet = { ...input, request_id: randomUUID(), title: "Concurrent memory", raw: "remember a concurrent synthetic memory" };
    const results = await Promise.all(Array.from({ length: 5 }, () => run("add-node", packet)));
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    assert.equal(results.filter(result => !result.replayed).length, 1);
  });

  await t.test("completion receipts replay the first result and reject cross-operation identity reuse", async () => {
    const completion = { request_id: randomUUID(), node_ids: [first.id], raw: "mark this complete", occurred_at: "2026-09-24T01:00:00Z" };
    const completed = await run("mark-complete", completion);
    const replay = await run("mark-complete", completion);
    assert.deepEqual(replay.events, completed.events);
    assert.equal(replay.replayed, true);
    const conflict = await run("mark-complete", { ...completion, request_id: requestId });
    assert.equal(conflict.error.code, "conflict");
  });

  await t.test("failed completion rolls back its receipt and remains retryable", async () => {
    const missing = randomUUID(), request_id = randomUUID();
    const packet = { request_id, node_ids: [missing], raw: "mark this complete" };
    const result = await run("mark-complete", packet);
    assert.equal(result.error.code, "not_found");
    assert.equal((await run("read-write-receipt", undefined, [request_id])).error.code, "not_found");
    await database.client.query("insert into brain_dev.nodes(id,type,title,body,raw) values($1,'note','Synthetic late target','raw','raw')", [missing]);
    const retry = await run("mark-complete", packet);
    assert.equal(retry.state, "committed");
    assert.equal(retry.events.length, 1);
  });

  await t.test("receipt insertion failure rolls back the new node and inferred deadline", async () => {
    const packet = { request_id: randomUUID(), title: "Atomic write fixture", raw: "remember to finish this by tomorrow" };
    await database.client.query(`alter table brain_dev.memory_write_receipts add constraint reject_synthetic_request check (request_id <> '${packet.request_id}'::uuid)`);
    try {
      const result = await run("add-node", packet);
      assert.equal(result.error.code, "unavailable");
      assert.equal((await database.client.query("select count(*)::int n from brain_dev.nodes where title=$1", [packet.title])).rows[0].n, 0);
    } finally { await database.client.query("alter table brain_dev.memory_write_receipts drop constraint reject_synthetic_request"); }
    const retry = await run("add-node", packet);
    assert.equal(retry.state, "committed");
    assert.ok(retry.due_at);
    const again = await run("add-node", packet);
    assert.equal(again.due_at, retry.due_at);
    assert.equal(again.id, retry.id);
    assert.equal((await database.client.query("select count(*)::int n from brain_dev.node_temporal_events where node_id=$1", [retry.id])).rows[0].n, 1);
  });

  await t.test("receipt migration is replayable and committed receipts are append-only", async () => {
    const sql = await readFile(new URL("../scripts/memory-schema.sql", import.meta.url), "utf8");
    await database.client.query("begin");
    await database.client.query("set local search_path to brain_dev, public");
    await database.client.query(sql);
    await database.client.query("commit");
    await assert.rejects(database.client.query("update brain_dev.memory_write_receipts set result='{}' where request_id=$1", [requestId]), /append-only/);
    await assert.rejects(database.client.query("delete from brain_dev.memory_write_receipts where request_id=$1", [requestId]), /append-only/);
    await assert.rejects(database.client.query("truncate brain_dev.memory_write_receipts"), /append-only/);
    assert.equal((await run("read-write-receipt", undefined, [requestId])).id, first.id);
  });
});

test("unkeyed concurrent completion commands append only one event", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const node = await command(database.url, "add-node", { title: "Concurrency fixture", raw: "remember this test" });
  const blocker = makeClient({ connectionString: database.url });
  await blocker.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select id from brain_dev.nodes where id=$1 for update", [node.id]);
    const jobs = Array.from({ length: 5 }, () => command(database.url, "mark-complete", { node_ids: [node.id], raw: "mark this complete" }));
    let blocked = 0;
    try {
      for (let i = 0; i < 100; i++) {
        blocked = (await database.client.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")).rows[0].n;
        if (blocked === 5) break;
        await delay(50);
      }
    } finally { await blocker.query("commit"); }
    const results = await Promise.all(jobs);
    assert.equal(blocked, 5, "all processes reached the controlled lock before release");
    assert.equal(results.reduce((sum, result) => sum + result.events.length, 0), 1);
    const count = await database.client.query("select count(*)::int n from brain_dev.node_temporal_events where node_id=$1 and event_type='completed'", [node.id]);
    assert.equal(count.rows[0].n, 1);
  } finally { await blocker.end(); }
});
