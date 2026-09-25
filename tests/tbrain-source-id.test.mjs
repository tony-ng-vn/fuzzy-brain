import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTbrainServer, productionTbrainServices, tbrainRuntimeConfig } from "../scripts/tbrain-mcp.mjs";
import { importTransfer, readReceipt } from "../scripts/lib/tbrain-store.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const SOURCE = "abcdefab-abcd-4abc-8abc-abcdefabcdef";

test("capture recognizes the same source UUID in either letter case", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await db.client.query("insert into brain_dev.sources(id,kind,label) values($1,'test','Identifier case test')", [SOURCE]);
  const packet = fixture({ source_id: SOURCE.toUpperCase(), source_key: randomUUID() });
  let first;
  await t.test("storage authorization accepts the same identifier without changing source bytes", async () => {
    first = await importTransfer(db.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [SOURCE] });
    assert.equal(first.state, "committed");
    assert.equal(first.source_id, packet.source_id);
    assert.equal((await readReceipt(db.client, "brain_dev", first.id)).digest, first.digest);
    const replay = await importTransfer(db.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [SOURCE] });
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
  });
  await t.test("an uppercase source can append a revision to its own saved record", async () => {
    const original = await importTransfer(db.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [packet.source_id] });
    const changed = { ...packet, revision: "2", relation: { receipt_id: original.id.toUpperCase(), kind: "supplements", note: "A supplied follow-up." } };
    const next = await importTransfer(db.client, "brain_dev", changed, { authorized: true, allowedSourceIds: [packet.source_id] });
    assert.equal(next.state, "committed");
    assert.notEqual(next.id, original.id);
  });
  await t.test("MCP preparation and capture honor configured identity rather than casing", async () => {
    const seen = [];
    const services = productionTbrainServices({ allowCapture: true, allowedSourceIds: [SOURCE] }, {
      pool: { withClient: fn => fn(db.client), close: async () => {} },
      run: async (_script, _args, input) => { seen.push(input); return { state: "committed" }; },
    });
    const server = createTbrainServer(services, { allowCapture: true, allowedSourceIds: [SOURCE] });
    const client = new Client({ name: "source-id-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const prepared = await client.callTool({ name: "prepare_capture", arguments: {
        source_id: packet.source_id, source_key: "case-test", revision: "1", platform: "test", messages: [{ role: "user", text: "Supplied words." }],
      } });
      assert.notEqual(prepared.isError, true);
      const saved = await client.callTool({ name: "archive_day", arguments: { transfer: packet } });
      assert.notEqual(saved.isError, true);
      assert.deepEqual(seen, [packet]);
      const denied = await client.callTool({ name: "archive_day", arguments: { transfer: { ...packet, source_id: randomUUID() } } });
      assert.equal(denied.isError, true);
      assert.equal(seen.length, 1);
    } finally { await client.close(); await services.close(); }
  });
});

test("runtime configuration advertises one canonical UUID for duplicate case variants", () => {
  const config = tbrainRuntimeConfig({ TBRAIN_ALLOW_CAPTURE: "1", TBRAIN_ALLOWED_SOURCE_IDS: `${SOURCE},${SOURCE.toUpperCase()}` });
  assert.deepEqual(config.allowedSourceIds, [SOURCE]);
});
