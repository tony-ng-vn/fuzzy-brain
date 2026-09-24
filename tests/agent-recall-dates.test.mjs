import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recall } from "../scripts/recall.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const september = "2026-09-01T00:00:00.000Z";
const october = "2026-10-01T00:00:00.000Z";

async function node(db, text, at) {
  const id = randomUUID();
  await db.query("insert into brain_dev.nodes(id,type,title,body,raw,created_at) values($1,'note',$2,$2,$2,$3)", [id, text, at]);
  return id;
}

async function edge(db, source, target, why, id = randomUUID()) {
  await db.query("insert into brain_dev.edges(id,source,target,why) values($1,$2,$3,$4)", [id, source, target, why]);
}

function fallbackClient(db) {
  let rejected = false;
  return { async query(sql, values) {
    if (!rejected && / as lane\b/.test(sql)) {
      rejected = true;
      throw new Error("Synthetic fused query failure");
    }
    return db.query(sql, values);
  } };
}

test("dated recall bounds direct connection matches and their node hydration", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const marker = `edgedate${randomUUID().replaceAll("-", "")}`;
  const question = `${marker} in September 2026`;
  const inside = await node(db, "A saved thought about paper boats", september);
  const outside = await node(db, "A saved thought about wooden blocks", "2026-08-31T23:59:59.999Z");
  await edge(db, outside, inside, question);
  for (const [mode, client] of [["fused", db], ["fallback", fallbackClient(db)]]) {
    await t.test(mode, async () => {
      const result = await recall(question, { client, schema: "brain_dev", embedQuery: async () => null });
      assert.deepEqual(result.hits.map(hit => hit.node_id), [inside]);
      assert.equal(result.degraded, mode === "fallback");
    });
  }
});

test("one-hop expansion keeps date boundaries while undated recall keeps its connections", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const marker = `hopdate${randomUUID().replaceAll("-", "")}`;
  const question = `${marker} in September 2026`;
  const anchor = await node(db, question, september);
  const inside = await node(db, "Related note inside the requested month", "2026-09-30T23:59:59.999Z");
  const before = await node(db, "Related note just before the requested month", "2026-08-31T23:59:59.999Z");
  const after = await node(db, "Related note at the next month boundary", october);
  for (const id of [inside, before, after]) await edge(db, anchor, id, "The user approved this connection between the saved thoughts.");
  for (const client of [db, fallbackClient(db)]) {
    const result = await recall(question, { client, schema: "brain_dev", embedQuery: async () => null });
    assert.deepEqual(result.hits.map(hit => hit.node_id).sort(), [anchor, inside].sort());
  }
  const unrestricted = await recall(marker, { client: db, schema: "brain_dev", embedQuery: async () => null });
  assert.deepEqual(unrestricted.hits.map(hit => hit.node_id).sort(), [anchor, inside, before, after].sort());
  assert.equal(unrestricted.date_filter, undefined);
});

test("out-of-range connection matches cannot consume the dated candidate limit", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const marker = `limitdate${randomUUID().replaceAll("-", "")}`;
  const question = `${marker} in September 2026`;
  const outside = await node(db, "Common endpoint from an earlier month", "2026-08-01T00:00:00Z");
  for (let i = 0; i < 35; i++) {
    const other = await node(db, `Earlier note number ${i}`, "2026-08-02T00:00:00Z");
    await edge(db, outside, other, question, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  }
  const inside = await node(db, "The relevant thought from the requested month", september);
  await edge(db, outside, inside, question, "ffffffff-ffff-4fff-8fff-ffffffffffff");
  const result = await recall(question, { client: db, schema: "brain_dev", embedQuery: async () => null });
  assert.deepEqual(result.hits.map(hit => hit.node_id), [inside]);
});

test("calendar date bounds do not shift with the database connection timezone", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const marker = `zonebound${randomUUID().replaceAll("-", "")}`;
  const question = `${marker} in September 2026`;
  const first = await node(db, question, september);
  const last = await node(db, question, "2026-09-30T23:59:59.999Z");
  await node(db, question, october);
  await node(db, question, "2026-08-31T23:59:59.999Z");
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    await db.query("select set_config('TimeZone',$1,false)", [zone]);
    const result = await recall(question, { client: db, schema: "brain_dev", embedQuery: async () => null });
    assert.deepEqual(result.hits.map(hit => hit.node_id).sort(), [first, last].sort(), zone);
    assert.deepEqual(result.date_filter, {
      from: september, to: october, timezone: "UTC", bounds: "[)",
      node_basis: "created_at", evidence_basis: "message_or_source_context",
      connection_context_may_be_outside_range: true,
    });
  }
});

test("one-sided date ranges remain open through connection retrieval", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const marker = `openbound${randomUUID().replaceAll("-", "")}`;
  const before = await node(db, "Older connected thought", "2025-12-31T23:59:59.999Z");
  const during = await node(db, "Connected thought inside the named year", "2026-06-01T00:00:00Z");
  const after = await node(db, "Newer connected thought", "2027-01-01T00:00:00Z");
  await edge(db, before, during, `${marker} before 2026`);
  await edge(db, during, after, `${marker} after 2026`);
  const options = { client: db, schema: "brain_dev", embedQuery: async () => null };
  const earlier = await recall(`${marker} before 2026`, options);
  assert.deepEqual(earlier.hits.map(hit => hit.node_id), [before]);
  assert.equal(earlier.date_filter.from, null);
  assert.equal(earlier.date_filter.to, "2026-01-01T00:00:00.000Z");
  const later = await recall(`${marker} after 2026`, options);
  assert.deepEqual(later.hits.map(hit => hit.node_id), [after]);
  assert.equal(later.date_filter.from, "2027-01-01T00:00:00.000Z");
  assert.equal(later.date_filter.to, null);
});
