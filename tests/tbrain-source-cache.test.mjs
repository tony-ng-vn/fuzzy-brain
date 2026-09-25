import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { productionTbrainServices } from "../scripts/tbrain-mcp.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { SourceTextCache } from "../scripts/lib/source-text-cache.mjs";

test("source cache bounds retained text and evicts the least recently used entry", () => {
  const cache = new SourceTextCache({ maxBytes: 12, maxEntries: 2 });
  cache.set("a", "a1", "aaa");
  cache.set("b", "b1", "bbb");
  assert.equal(cache.get("a").text, "aaa");
  cache.set("c", "c1", "ccc");
  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a").fingerprint, "a1");
  cache.set("a", "a2", "aaaaa");
  assert.equal(cache.get("c"), null);
  assert.equal(cache.get("a").text, "aaaaa");
  cache.set("a", "a3", "too long");
  assert.equal(cache.get("a"), null);
  cache.set("a", "a4", "a");
  cache.set("b", "b2", "b");
  cache.set("c", "c2", "c");
  assert.equal(cache.get("a"), null);
  cache.clear();
  assert.equal(cache.get("c"), null);
  for (const options of [{ maxBytes: 0 }, { maxEntries: 0 }]) {
    const disabled = new SourceTextCache(options);
    disabled.set("key", "hash", "text");
    assert.equal(disabled.get("key"), null);
  }
  assert.throws(() => new SourceTextCache({ maxBytes: -1 }), RangeError);
});

test("resident source reads reuse text only after checking current storage", async t => {
  const db = await createTbrainTestDatabase();
  const oldSchema = process.env.BRAIN_SCHEMA;
  process.env.BRAIN_SCHEMA = "brain_dev";
  t.after(async () => {
    if (oldSchema === undefined) delete process.env.BRAIN_SCHEMA;
    else process.env.BRAIN_SCHEMA = oldSchema;
    await db.close();
  });
  const source = randomUUID(), episode = randomUUID();
  const original = "source \u{1f600} ".repeat(20000);
  await db.client.query("insert into brain_dev.sources(id,kind,label) values($1,'test','Cache test')", [source]);
  await db.client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,$3)", [episode, source, original]);
  let unavailable = false;
  const transfers = [];
  const pool = { close: async () => {}, withClient: fn => fn({ query: async (...args) => {
    if (unavailable) throw new Error("database unavailable");
    const result = await db.client.query(...args);
    transfers.push(Buffer.byteLength(JSON.stringify(result.rows)));
    return result;
  } }) };
  const services = productionTbrainServices({ allowCapture: false, allowedSourceIds: [] }, { pool });
  t.after(() => services.close());
  const read = (offset = 0, id = episode) => services.readSource({ id, offset, limit: 80 });

  await t.test("successive pages check once without downloading the full text again", async () => {
    assert.equal((await read()).text, original.slice(0, 80));
    assert.equal((await read(79, episode.toUpperCase())).text, original.slice(79, 159));
    assert.equal(transfers.length, 2);
    assert.ok(transfers[0] > 200000);
    assert.ok(transfers[1] < 2000, `second page downloaded ${transfers[1]} bytes`);
  });
  await t.test("same-length changes replace cached text and metadata stays current", async () => {
    const updated = original.replaceAll("source", "edited");
    await db.client.query("update brain_dev.episodes set raw=$2 where id=$1", [episode, updated]);
    assert.equal((await read()).text, updated.slice(0, 80));
    assert.ok(transfers.at(-1) > 200000);
    await db.client.query("update brain_dev.sources set label='Current label' where id=$1", [source]);
    const page = await read();
    assert.equal(page.source.label, "Current label");
    assert.equal(page.total_characters, updated.length);
    assert.ok(transfers.at(-1) < 2000);
  });
  await t.test("failed checks cannot serve cached content", async () => {
    unavailable = true;
    await assert.rejects(read(), /database unavailable/);
    unavailable = false;
  });
  await t.test("provided source exports retain their exact text and provenance", async () => {
    const packet = fixture({ source_id: source, source_key: randomUUID() });
    packet.coverage.kind = "source_export";
    packet.original = { text: original, media_type: "text/plain" };
    const receipt = await importTransfer(db.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
    const first = await read(79, receipt.id), next = await read(159, receipt.id);
    assert.equal(first.origin, "provided_source_export");
    assert.equal(first.text, original.slice(79, 159));
    assert.equal(next.text, original.slice(159, 239));
    assert.deepEqual(next.coverage, packet.coverage);
    assert.ok(transfers.at(-1) < 2000);
  });
  await t.test("closing releases stored text", async () => {
    await services.close();
    await read();
    assert.ok(transfers.at(-1) > 200000);
  });
});
