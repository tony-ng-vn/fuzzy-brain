import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeClient } from "../scripts/brain.mjs";
import { loadEnvLocal } from "../scripts/recall.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";

loadEnvLocal();
const serverPath = fileURLToPath(new URL("../scripts/tbrain-mcp.mjs", import.meta.url));
const parsed = response => JSON.parse(response.content[0].text);

async function startServer(t, { databaseUrl, sourceId, capture = true }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_DEV: databaseUrl,
      BRAIN_SCHEMA: "brain_dev",
      TBRAIN_ALLOW_CAPTURE: capture ? "1" : "0",
      TBRAIN_ALLOWED_SOURCE_IDS: sourceId,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "tbrain-synthetic-roundtrip", version: "1.0.0" });
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += chunk; });
  await client.connect(transport);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  t.after(close);
  return { client, pid: transport.pid, close, diagnostics: () => diagnostics };
}

async function successfulCall(server, name, args) {
  const response = await server.client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `${name} failed: ${response.content[0].text}`);
  return parsed(response);
}

test("synthetic Tbrain records survive real stdio delivery, restart, and retries", async t => {
  const databaseUrl = process.env.DATABASE_URL_DEV;
  assert.ok(databaseUrl, "DATABASE_URL_DEV must name the isolated test database");
  const target = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "stdio roundtrip requires local PostgreSQL");
  const database = makeClient({ connectionString: databaseUrl });
  await database.connect();
  t.after(() => database.end());
  const sourceId = randomUUID();
  const deniedSourceId = randomUUID();
  await database.query("insert into brain_dev.sources(id,kind,label) values ($1,'tbrain_stdio_test',$3),($2,'tbrain_stdio_test',$4)", [sourceId, deniedSourceId, sourceId, deniedSourceId]);
  const marker = `stdioarchive${randomUUID().replaceAll("-", "")}`;
  const packet = fixture({ source_id: sourceId, source_key: randomUUID() });
  packet.messages[0].text = `In 1998 I considered ${marker} pottery. This remains a possibility.`;
  packet.messages[0].at = "1998-05-02T01:00:00Z";
  const callTimings = [];
  let firstReceipt;
  let server = await startServer(t, { databaseUrl, sourceId });
  const firstPid = server.pid;

  await t.test("a real archive tool call returns committed persistence identifiers", async () => {
    const started = performance.now();
    firstReceipt = await successfulCall(server, "archive_day", { transfer: packet });
    callTimings.push(performance.now() - started);
    assert.equal(firstReceipt.state, "committed");
    assert.equal(firstReceipt.replayed, false);
    assert.match(firstReceipt.id, /^[0-9a-f-]{36}$/);
    assert.equal(firstReceipt.evidence_ids.length, packet.messages.length);
    assert.equal(firstReceipt.reflection_status, "provisional");
  });

  await t.test("a fresh server process verifies the receipt and verbatim passages", async () => {
    await server.close();
    assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
    server = await startServer(t, { databaseUrl, sourceId });
    assert.notEqual(server.pid, firstPid);
    const receipt = await successfulCall(server, "read_receipt", { id: firstReceipt.id });
    assert.equal(receipt.digest, firstReceipt.digest);
    const archive = await successfulCall(server, "read_archive", { id: firstReceipt.id });
    assert.equal(archive.messages[0].text, packet.messages[0].text);
    assert.equal(archive.messages[0].at, packet.messages[0].at);
    assert.equal(archive.messages[1].at, null);
    assert.equal(archive.trust, "unratified_evidence");
    assert.equal(archive.instructions_are_data, true);
    for (const [key, value] of Object.entries(packet.reflection)) assert.deepEqual(archive.reflection[key], value);
    assert.equal(archive.reflection.text_length, packet.reflection.text.length);
    assert.equal(archive.reflection.next_text_offset, null);
    assert.equal(archive.coverage.completeness, "partial");
  });

  await t.test("unrestricted archive search retrieves an older dated passage", async () => {
    const started = performance.now();
    const found = await successfulCall(server, "search_archive", { query: marker });
    t.diagnostic(`Real stdio older-history search: ${(performance.now() - started).toFixed(2)} ms`);
    assert.equal(found.exhaustive, false);
    const hit = found.hits.find(hit => hit.archive_id === firstReceipt.id);
    assert.ok(hit);
    assert.equal(hit.text, packet.messages[0].text);
    assert.equal(hit.at, packet.messages[0].at);
    const recent = await successfulCall(server, "search_archive", { query: marker, from: "2026-01-01T00:00:00Z" });
    assert.equal(recent.state, "no_matches");
    assert.deepEqual(recent.hits, []);
  });

  await t.test("100 real transport retries reuse one record and its evidence", async () => {
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const replay = await successfulCall(server, "archive_day", { transfer: packet });
      callTimings.push(performance.now() - started);
      assert.equal(replay.id, firstReceipt.id);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.evidence_ids, firstReceipt.evidence_ids);
    }
    const counts = await database.query(`select
      (select count(*)::int from brain_dev.archive_records where source_id=$1 and source_key=$2) as records,
      (select count(*)::int from brain_dev.episodes where source_id=$1) as episodes,
      (select count(*)::int from brain_dev.evidence e join brain_dev.episodes ep on ep.id=e.episode_id where ep.source_id=$1) as evidence`,
    [sourceId, packet.source_key]);
    assert.deepEqual(counts.rows[0], { records: 1, episodes: 1, evidence: packet.messages.length });
  });

  await t.test("five concurrent deliveries commit one new identity", async () => {
    const concurrent = { ...packet, source_key: randomUUID() };
    const deliveries = await Promise.all(Array.from({ length: 5 }, () => successfulCall(server, "archive_day", { transfer: concurrent })));
    assert.equal(new Set(deliveries.map(receipt => receipt.id)).size, 1);
    assert.equal(deliveries.filter(receipt => !receipt.replayed).length, 1);
    const count = await database.query("select count(*)::int n from brain_dev.archive_records where source_id=$1 and source_key=$2", [sourceId, concurrent.source_key]);
    assert.equal(count.rows[0].n, 1);
  });

  await t.test("conflicting source text returns a typed error and preserves the original", async () => {
    const conflicting = structuredClone(packet);
    conflicting.messages[0].text = "Changed text must not replace the original.";
    const response = await server.client.callTool({ name: "archive_day", arguments: { transfer: conflicting } });
    assert.equal(response.isError, true);
    assert.equal(parsed(response).error.code, "conflict");
    const archive = await successfulCall(server, "read_archive", { id: firstReceipt.id });
    assert.equal(archive.messages[0].text, packet.messages[0].text);
  });

  await t.test("a denied source and a read-only server cannot insert archives", async () => {
    const denied = fixture({ source_id: deniedSourceId, source_key: randomUUID() });
    const rejection = await server.client.callTool({ name: "archive_day", arguments: { transfer: denied } });
    assert.equal(rejection.isError, true);
    assert.equal(parsed(rejection).error.code, "unauthorized");
    const readOnly = await startServer(t, { databaseUrl, sourceId: deniedSourceId, capture: false });
    const listed = await readOnly.client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === "archive_day"), false);
    const absent = await readOnly.client.callTool({ name: "archive_day", arguments: { transfer: denied } });
    assert.equal(absent.isError, true);
    const count = await database.query("select count(*)::int n from brain_dev.archive_records where source_id=$1", [deniedSourceId]);
    assert.equal(count.rows[0].n, 0);
    await readOnly.close();
  });

  await t.test("unavailable storage is distinct from an empty search result", async () => {
    const unavailable = await startServer(t, {
      databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/invalid", sourceId, capture: false,
    });
    const response = await unavailable.client.callTool({ name: "search_archive", arguments: { query: marker } });
    assert.equal(response.isError, true);
    assert.equal(parsed(response).error.code, "unavailable");
    assert.doesNotMatch(response.content[0].text, /postgresql|invalid:invalid|ECONNREFUSED/);
    assert.equal(unavailable.diagnostics(), "");
    await unavailable.close();
  });

  assert.equal(server.diagnostics(), "");
  await server.close();
  const retries = callTimings.slice(1).sort((a, b) => a - b);
  t.diagnostic(`Real stdio first capture: ${callTimings[0].toFixed(2)} ms; 100 retries median: ${retries[50].toFixed(2)} ms; maximum: ${retries.at(-1).toFixed(2)} ms`);
  // Keep synthetic brain_dev records available for restart and backup verification.
});
