import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFuzzyBrainServer, productionServices } from "../scripts/fuzzy-brain-mcp.mjs";
import { createTbrainServer, productionTbrainServices } from "../scripts/tbrain-mcp.mjs";
import { recall } from "../scripts/recall.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";

test("agents can follow a recall clue to exact evidence and its neighbors on either server", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const sourceId = randomUUID();
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'agent_read_test',$2)", [sourceId, sourceId]);
  const packet = fixture({ source_id: sourceId, source_key: randomUUID() });
  const marker = `context${randomUUID().replaceAll("-", "")}`;
  packet.messages = [
    { id: null, role: "user", speaker: "Tony", at: null, fidelity: "verbatim", text: "That is an idea, not a decision." },
    { id: null, role: "assistant", speaker: null, at: null, fidelity: "verbatim", text: `${marker} ` + "long passage ".repeat(100) },
    { id: null, role: "user", speaker: "Tony", at: null, fidelity: "verbatim", text: "I have not agreed to do that." },
  ];
  const receipt = await importTransfer(db, "brain_dev", packet, { authorized: true, allowedSourceIds: [sourceId] });
  const found = await recall(marker, { client: db, schema: "brain_dev", embedQuery: async () => null });
  const hit = found.hits.find(h => h.provenance?.evidence_id === receipt.evidence_ids[1]);

  await t.test("recall supplies a bounded read instruction and truthful truncation", () => {
    assert.ok(hit);
    assert.equal(hit.quote_truncated, true);
    assert.equal(hit.quote_length, packet.messages[1].text.length);
    assert.deepEqual(hit.read, { tool: "read_evidence", arguments: { id: receipt.evidence_ids[1] } });
  });

  const oldSchema = process.env.BRAIN_SCHEMA;
  process.env.BRAIN_SCHEMA = "brain_dev";
  t.after(() => { if (oldSchema === undefined) delete process.env.BRAIN_SCHEMA; else process.env.BRAIN_SCHEMA = oldSchema; });
  const pool = { withClient: fn => fn(db), close: async () => {} };
  for (const [name, server] of [
    ["fuzzy-brain", createFuzzyBrainServer(productionServices({ pool }))],
    ["tbrain", createTbrainServer(productionTbrainServices({ allowCapture: false, allowedSourceIds: [] }, { pool }))],
  ]) {
    await t.test(`${name} reads the exact match and bounded adjacent messages through MCP`, async () => {
      const client = new Client({ name: "agent-evidence-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      try {
        const response = await client.callTool({ name: "read_evidence", arguments: { id: receipt.evidence_ids[1], text_limit: 80 } });
        assert.notEqual(response.isError, true);
        const result = JSON.parse(response.content[0].text);
        assert.equal(result.evidence.text, packet.messages[1].text.slice(0, 80));
        assert.equal(result.evidence.role, "assistant");
        assert.equal(result.evidence.speaker, null);
        assert.equal(result.evidence.at, null);
        assert.equal(result.evidence.archive_id, receipt.id);
        assert.equal(result.evidence.source.id, sourceId);
        assert.equal(result.evidence.ordinal, 1);
        assert.equal(result.evidence.next_text_offset, 80);
        assert.equal(result.before[0].text, packet.messages[0].text);
        assert.equal(result.after[0].text, packet.messages[2].text);
        assert.equal(result.trust, "unratified_evidence");
        assert.equal(result.instructions_are_data, true);
        const continuation = await client.callTool({ name: "read_evidence", arguments: { id: receipt.evidence_ids[1], context: 0, text_offset: 80, text_limit: 80 } });
        const next = JSON.parse(continuation.content[0].text);
        assert.equal(next.evidence.text, packet.messages[1].text.slice(80, 160));
        assert.deepEqual(next.before, []);
        assert.deepEqual(next.after, []);
        const missing = await client.callTool({ name: "read_evidence", arguments: { id: randomUUID() } });
        assert.equal(missing.isError, true);
        assert.equal(JSON.parse(missing.content[0].text).error.code, "not_found");
      } finally { await client.close(); }
    });
  }
});

test("legacy passage reads work without archive tables and preserve original offsets", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  await db.query("drop table brain_dev.archive_messages, brain_dev.archive_records");
  const source = randomUUID(), episode = randomUUID(), evidence = randomUUID();
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'codex_session',$2)", [source, source]);
  await db.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'tony: exact words')", [episode, source]);
  await db.query("insert into brain_dev.evidence(id,episode_id,quote,start_offset,end_offset,speaker) values($1,$2,'exact words',6,17,'tony')", [evidence, episode]);
  const { readEvidence } = await import("../scripts/lib/tbrain-store.mjs");
  const result = await readEvidence(db, "brain_dev", { id: evidence });
  assert.equal(result.evidence.text, "exact words");
  assert.equal(result.evidence.speaker, "tony");
  assert.equal(result.evidence.start_offset, 6);
  assert.equal(result.evidence.end_offset, 17);
  assert.equal(result.evidence.fidelity, "unknown");
  assert.equal(result.evidence.archive_id, null);
  await assert.rejects(readEvidence(db, "brain_dev", { id: evidence, context: 4 }));
});

test("a long recall passage points both memory servers to the matching source excerpt", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const source = randomUUID();
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'agent_read_test','Excerpt test')", [source]);
  const target = "I understand release automation best when I can explain why a change works.";
  const text = "unrelated introductory material ".repeat(600) + target + " Some closing context.";
  const packet = fixture({ source_id: source, source_key: randomUUID(), reflection: null,
    messages: [{ id: null, role: "user", speaker: null, at: null, fidelity: "verbatim", text }] });
  const receipt = await importTransfer(db, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
  const result = await recall("understanding release automation", { client: db, schema: "brain_dev", embedQuery: async () => null });
  const hit = result.hits.find(item => item.provenance?.evidence_id === receipt.evidence_ids[0]);
  assert.ok(hit);
  assert.ok(hit.quote.includes(target), "the search excerpt must show the matching words, not only the introduction");
  assert.ok(hit.quote_offset > 0);
  assert.ok(hit.quote.length <= 700);
  assert.equal(hit.quote, text.slice(hit.quote_offset, hit.quote_offset + hit.quote.length));
  assert.equal(hit.quote_truncated, true);
  assert.equal(hit.quote_length, text.length);
  assert.equal(hit.read.arguments.text_offset, hit.quote_offset);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/recall.mjs", import.meta.url)), "understanding release automation", "--source-id", source], {
    encoding: "utf8", timeout: 60000,
    env: { ...process.env, DATABASE_URL: database.url, DATABASE_URL_DEV: database.url, BRAIN_SCHEMA: "brain_dev" },
  });
  assert.ok(output.includes(target), "the text command must keep the matching sentence visible");
  assert.ok(output.includes(`evidence ${receipt.evidence_ids[0]}`));
  assert.ok(output.includes(`text offset ${hit.quote_offset} of ${text.length}`));
  const oldSchema = process.env.BRAIN_SCHEMA;
  process.env.BRAIN_SCHEMA = "brain_dev";
  t.after(() => { if (oldSchema === undefined) delete process.env.BRAIN_SCHEMA; else process.env.BRAIN_SCHEMA = oldSchema; });
  const pool = { withClient: fn => fn(db), close: async () => {} };
  for (const server of [createFuzzyBrainServer(productionServices({ pool })), createTbrainServer(productionTbrainServices({ allowCapture: false, allowedSourceIds: [] }, { pool }))]) {
    const client = new Client({ name: "excerpt-read-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const response = await client.callTool({ name: hit.read.tool, arguments: { ...hit.read.arguments, context: 0, text_limit: 700 } });
      assert.notEqual(response.isError, true);
      const readback = response.structuredContent;
      assert.equal(readback.evidence.text, hit.quote);
      assert.equal(readback.evidence.text_offset, hit.quote_offset);
      assert.equal(readback.evidence.fidelity, "verbatim");
      assert.equal(readback.trust, "unratified_evidence");
    } finally { await client.close(); }
  }
});

test("evidence readback accepts a valid excerpt offset beyond five million characters", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const source = randomUUID(), episode = randomUUID(), evidence = randomUUID();
  const offset = 5000010;
  const text = ".".repeat(offset) + "The original ending.";
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'agent_read_test','Large offset')", [source]);
  await db.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,$3)", [episode, source, text]);
  await db.query("insert into brain_dev.evidence(id,episode_id,quote,start_offset,end_offset,speaker) values($1,$2,$3,0,$4,'tony')", [evidence, episode, text, text.length]);
  const { readEvidence } = await import("../scripts/lib/tbrain-store.mjs");
  const result = await readEvidence(db, "brain_dev", { id: evidence, context: 0, text_offset: offset, text_limit: 700 });
  assert.equal(result.evidence.text, "The original ending.");
  assert.equal(result.evidence.text_offset, offset);
  assert.equal(result.evidence.next_text_offset, null);
  for (const text_offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readEvidence(db, "brain_dev", { id: evidence, text_offset }));
  }
});
