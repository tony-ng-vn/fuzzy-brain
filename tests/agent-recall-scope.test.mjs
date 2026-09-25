import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

test("ranked recall applies explicit scope before candidate limits across retrieval paths", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const source = randomUUID(), other = randomUUID();
  const marker = `scope${randomUUID().replaceAll("-", "")}`;
  const at = "2026-09-15T12:00:00.000Z";
  for (const id of [source, other]) await db.query("insert into brain_dev.sources(id,kind,label) values($1,'codex_session',$2)", [id, id]);
  const episode = randomUUID();
  await db.query("insert into brain_dev.episodes(id,source_id,source_locator,raw,occurred_at) values($1,$2,'session-1',$3,$4)", [episode, source, marker.repeat(4), at]);
  let spanIndex = 0;
  async function passage(speaker, time, sourceId = source) {
    const ep = sourceId === source ? episode : randomUUID();
    if (ep !== episode) await db.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,$3)", [ep, sourceId, marker]);
    const id = randomUUID();
    const start = ep === episode ? spanIndex++ * marker.length : 0;
    await db.query("insert into brain_dev.evidence(id,episode_id,quote,speaker,start_offset,end_offset,occurred_at) values($1,$2,$3,$4,$5,$6,$7)", [id, ep, marker, speaker, start, start + marker.length, time]);
    return id;
  }
  for (let i = 0; i < 30; i++) await passage("assistant", at, other);
  const user = await passage("tony", at);
  const undated = await passage("tony", null);
  const assistant = await passage("assistant", at);
  const earlier = await passage("tony", "2026-09-14T12:00:00.000Z");
  const packet = fixture({ source_id: source, source_key: randomUUID() });
  packet.messages = [{ id: null, role: "user", speaker: "The speaker", at, fidelity: "verbatim", text: marker }];
  const receipt = await importTransfer(db, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
  const node = randomUUID();
  await db.query("insert into brain_dev.nodes(id,type,title,body,raw,created_at) values($1,'note',$2,$2,$2,$3)", [node, marker, at]);
  const base = { client: db, schema: "brain_dev", embedQuery: async () => null };
  const filters = { source_id: source.toUpperCase(), role: "user", from: at, until: at };
  const evidenceIds = result => result.hits.map(hit => hit.provenance?.evidence_id).sort();

  await t.test("source, role and exact timestamps select only matching evidence", async () => {
    const result = await recall(marker, { ...base, ...filters });
    assert.deepEqual(evidenceIds(result), [user, receipt.evidence_ids[0]].sort());
    assert.deepEqual(result.scope, { layer: "evidence", source_id: source, role: "user", from: at, until: at });
    assert.equal(result.date_filter.bounds, "[]");
    assert.equal(result.date_filter.evidence_basis, "message");
    assert.equal(result.degraded, false);
  });
  await t.test("explicit dates override inferred calendar ranges without inventing message times", async () => {
    const result = await recall(`${marker} in January 2026`, { ...base, ...filters });
    assert.deepEqual(evidenceIds(result), [user, receipt.evidence_ids[0]].sort());
    assert.equal(result.date_filter.from, at);
    assert.equal(result.date_filter.to, at);
    assert.ok(!evidenceIds(result).includes(undated));
    assert.ok(!evidenceIds(result).includes(earlier));
  });
  await t.test("layer filters separate approved nodes from source evidence", async () => {
    const nodes = await recall(marker, { ...base, layer: "nodes" });
    assert.deepEqual(nodes.hits.map(hit => hit.node_id), [node]);
    const evidence = await recall(marker, { ...base, layer: "evidence", source_id: source });
    assert.deepEqual(evidenceIds(evidence), [user, undated, assistant, earlier, receipt.evidence_ids[0]].sort());
  });
  await t.test("fallback queries preserve every explicit restriction", async () => {
    let rejected = false;
    const client = { async query(sql, values) {
      if (!rejected && / as lane\b/.test(sql)) { rejected = true; throw new Error("Synthetic fused query failure"); }
      return db.query(sql, values);
    } };
    const result = await recall(marker, { ...base, ...filters, client });
    assert.deepEqual(evidenceIds(result), [user, receipt.evidence_ids[0]].sort());
    assert.equal(result.degraded, true);
  });
  await t.test("missing archive role metadata does not widen the requested role", async () => {
    const client = { async query(sql, values) {
      if (/to_regclass/.test(sql)) return { rows: [{ ready: false }] };
      return db.query(sql, values);
    } };
    const result = await recall(marker, { ...base, ...filters, client });
    assert.deepEqual(evidenceIds(result), [user]);
    assert.equal(result.degraded, true);
    assert.match(result.note, /archive role metadata unavailable/);
  });
});

test("invalid scope fails before querying storage or loading the embedding model", async () => {
  for (const scope of [
    { source_id: "PRIVATE_BAD_ID" }, { role: "human" }, { layer: "messages" },
    { from: "PRIVATE_BAD_DATE" }, { from: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" },
    { layer: "nodes", source_id: randomUUID() }, { layer: "nodes", role: "user" },
    { from: "2026-09-24T12:00:00.123402Z", until: "2026-09-24T12:00:00.123401Z" },
    { from: "2026-09-24T12:00:00.1234567Z" },
  ]) {
    let calls = 0;
    await assert.rejects(recall("scope validation", { ...scope,
      client: { query() { calls++; throw new Error("should not reach storage"); } },
      embedQuery() { calls++; throw new Error("should not reach the model"); },
    }), error => {
      assert.equal(error.code, "invalid");
      assert.doesNotMatch(error.message, /PRIVATE_BAD/);
      return true;
    });
    assert.equal(calls, 0);
  }
});

test("explicit timestamp filters preserve database microseconds and timezone offsets", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const source = randomUUID();
  const marker = `precisescope${randomUUID().replaceAll("-", "")}`;
  await database.client.query("insert into brain_dev.sources(id,kind,label) values($1,'scope_precision',$2)", [source, source]);
  const packet = fixture({ source_id: source });
  packet.messages = ["123400", "123401", "123402"].map(fraction => ({ id: null, role: "user", speaker: null,
    at: `2026-09-24T12:00:00.${fraction}Z`, fidelity: "verbatim", text: marker }));
  const receipt = await importTransfer(database.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
  const result = await recall(marker, { client: database.client, schema: "brain_dev", embedQuery: async () => null,
    source_id: source, from: "2026-09-24T05:00:00.123401-07:00", until: "2026-09-24T12:00:00.123401Z" });
  assert.deepEqual(result.hits.map(hit => hit.provenance.evidence_id), [receipt.evidence_ids[1]]);
  assert.equal(result.scope.from, "2026-09-24T12:00:00.123401Z");
  assert.equal(result.scope.until, result.scope.from);
  assert.equal(result.hits[0].provenance.occurred_at, result.scope.from);
});
