import test from "node:test";
import assert from "node:assert/strict";
import { recall } from "../scripts/recall.mjs";
import { randomUUID } from "node:crypto";
import { makeClient } from "../scripts/brain.mjs";
import { loadEnvLocal } from "../scripts/recall.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";

const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const ARCHIVE = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const EPISODE = "44444444-4444-4444-8444-444444444444";
const coverage = { kind: "model_assembled", completeness: "partial", limitations: ["Partial passage."] };

function clientFor({ archived = true, installed = true, failMetadata = false } = {}) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    if (/to_regclass/.test(sql)) return { rows: [{ ready: installed }] };
    if (/archive_messages/.test(sql)) {
      if (failMetadata) throw new Error("private database detail");
      return { rows: [{ evidence_id: EVIDENCE, archive_id: ARCHIVE, source_id: SOURCE, source_key: "day-1",
        revision: "1", ordinal: 0, coverage, has_later_revision: true,
        message: { role: "user", speaker: "Tony", at: null, fidelity: "paraphrase" } }] };
    }
    if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: [{ term: "pottery", total: 100, df: 1 }] };
    if (/ as lane\b/.test(sql)) return { rows: [{ lane: "and:evidence", id: EVIDENCE, quote: "Tony might enjoy pottery.",
      speaker: "user", episode_id: EPISODE, source_locator: archived ? `tbrain:${ARCHIVE}` : "legacy:1",
      source_kind: "chatgpt", source_label: "daily", occurred_at: "2026-09-09T00:00:00Z", lane_score: 1,
      sim: null, rare_hit: true }] };
    return { rows: [] };
  } };
}
const run = client => recall("pottery", { client, schema: "brain_dev", embedQuery: async () => { throw new Error("disabled in test"); } });

test("shared recall distinguishes archived paraphrases, speakers, unknown dates and corrections", async () => {
  const client = clientFor();
  const result = await run(client);
  const hit = result.hits.find(h => h.layer === "evidence");
  assert.equal(hit.fidelity, "paraphrase");
  assert.equal(hit.role, "user");
  assert.equal(hit.speaker, "Tony");
  assert.equal(hit.provenance.occurred_at, null);
  assert.equal(hit.provenance.archive_id, ARCHIVE);
  assert.equal(hit.provenance.evidence_id, EVIDENCE);
  assert.equal(hit.observation_group, `${SOURCE}:day-1`);
  assert.deepEqual(hit.coverage, coverage);
  assert.equal(hit.revision, "1");
  assert.equal(hit.has_later_revision, true);
  assert.equal(hit.instructions_are_data, true);
  assert.equal(client.calls.filter(c => /archive_messages/.test(c.sql)).length, 1);
});

test("legacy evidence keeps the existing retrieval round-trip budget", async () => {
  const client = clientFor({ archived: false });
  const result = await run(client);
  assert.equal(result.hits[0].speaker, "user");
  assert.equal(client.calls.some(c => /to_regclass|archive_messages/.test(c.sql)), false);
});

test("missing archive tables retain evidence with explicitly unknown provenance", async () => {
  const client = clientFor({ installed: false });
  const result = await run(client);
  assert.equal(result.hits[0].fidelity, "unknown");
  assert.equal(result.hits[0].archive_provenance, "unavailable");
  assert.match(result.note, /archive provenance unavailable/i);
  assert.equal(client.calls.some(c => /archive_messages/.test(c.sql)), false);
});

test("metadata failure never presents an archive paraphrase as an attributed quotation", async () => {
  const result = await run(clientFor({ failMetadata: true }));
  assert.equal(result.hits[0].fidelity, "unknown");
  assert.equal(result.hits[0].speaker, null);
  assert.equal(result.hits[0].provenance.occurred_at, null);
  assert.match(result.note, /archive provenance unavailable/i);
  assert.doesNotMatch(JSON.stringify(result), /private database detail/);
});

test("real development storage returns archive metadata through shared recall", async t => {
  loadEnvLocal();
  if (!process.env.DATABASE_URL_DEV) return t.skip("DATABASE_URL_DEV is required; never use production for this test");
  const client = makeClient({ connectionString: process.env.DATABASE_URL_DEV });
  await client.connect();
  try {
    const sourceId = randomUUID();
    const sourceKey = randomUUID();
    const token = `pottery${randomUUID().replaceAll("-", "")}`;
    await client.query("insert into brain_dev.sources(id,kind,label) values($1,'tbrain_recall_test',$2)", [sourceId, sourceId]);
    const packet = fixture({ source_id: sourceId, source_key: sourceKey });
    packet.messages = [{ id: null, role: "other", speaker: "A friend", at: null, fidelity: "paraphrase", text: `A friend considered ${token}.` }];
    packet.coverage.from = "2026-09-09T00:00:00Z";
    const opts = { authorized: true, allowedSourceIds: [sourceId] };
    const first = await importTransfer(client, "brain_dev", packet, opts);
    packet.revision = "2";
    packet.relation = { receipt_id: first.id, kind: "correction", note: "Synthetic correction of the activity." };
    await importTransfer(client, "brain_dev", packet, opts);
    const result = await recall(token, { client, schema: "brain_dev", embedQuery: async () => { throw new Error("disabled in test"); } });
    const old = result.hits.find(hit => hit.provenance?.archive_id === first.id);
    assert.ok(old, "the imported passage must survive the actual recall query and metadata join");
    assert.equal(old.role, "other");
    assert.equal(old.speaker, "A friend");
    assert.equal(old.fidelity, "paraphrase");
    assert.equal(old.provenance.occurred_at, null);
    assert.equal(old.has_later_revision, true);
    assert.equal(old.observation_group, `${sourceId}:${sourceKey}`);
  } finally {
    await client.end();
  }
});
