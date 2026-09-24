import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const parse = response => JSON.parse(response.content[0].text);

test("MCP memory requests survive a server restart and expose safe retry errors", async t => {
  const database = await createTbrainTestDatabase();
  const servers = [];
  t.after(async () => { for (const client of servers) await client.close(); await database.close(); });
  async function start() {
    const client = new Client({ name: "memory-retry-test", version: "1" });
    servers.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/fuzzy-brain-mcp.mjs", import.meta.url))],
      env: { PATH: process.env.PATH, DATABASE_URL: database.url, DATABASE_URL_DEV: database.url, BRAIN_SCHEMA: "brain_dev" }, stderr: "pipe" }));
    return client;
  }
  let client = await start();
  const requestId = randomUUID();
  const args = { raw: "remember this exact synthetic memory", request_id: requestId };
  const firstResponse = await client.callTool({ name: "remember", arguments: args });
  assert.notEqual(firstResponse.isError, true);
  const first = parse(firstResponse);
  await client.close();
  client = await start();

  await t.test("discovery explains optional request IDs and committed receipt readback", async () => {
    const { tools } = await client.listTools();
    const remember = tools.find(tool => tool.name === "remember");
    assert.ok(remember.inputSchema.properties.request_id);
    assert.equal(remember.annotations.idempotentHint, false, "unkeyed callers do not have replay protection");
    assert.ok(tools.some(tool => tool.name === "read_write_receipt"));
    assert.match(client.getInstructions(), /request_id/);
  });

  await t.test("fresh server replays one saved memory and verifies its receipt", async () => {
    const response = await client.callTool({ name: "remember", arguments: args });
    assert.notEqual(response.isError, true);
    const replay = parse(response);
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    const receipt = parse(await client.callTool({ name: "read_write_receipt", arguments: { request_id: requestId } }));
    assert.equal(receipt.state, "committed");
    assert.equal(receipt.id, first.id);
    const read = parse(await client.callTool({ name: "get_node", arguments: { id: first.id } }));
    assert.equal(read.raw, args.raw);
  });

  await t.test("changed instruction under the same ID returns a safe conflict", async () => {
    const response = await client.callTool({ name: "remember", arguments: { ...args, raw: "remember PRIVATE_CONFLICT_TEXT" } });
    assert.equal(response.isError, true);
    assert.equal(parse(response).error.code, "conflict");
    assert.deepEqual(response.structuredContent, parse(response));
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_CONFLICT_TEXT|postgresql|Users/);
  });

  await t.test("completion retry returns the same immutable events", async () => {
    const completion = { request_id: randomUUID(), node_ids: [first.id], raw: "please mark this complete" };
    const completed = parse(await client.callTool({ name: "mark_complete", arguments: completion }));
    const replay = parse(await client.callTool({ name: "mark_complete", arguments: completion }));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.events, completed.events);
  });

  await t.test("unknown receipt is not mistaken for a storage outage", async () => {
    const response = await client.callTool({ name: "read_write_receipt", arguments: { request_id: randomUUID() } });
    assert.equal(response.isError, true);
    assert.equal(parse(response).error.code, "not_found");
  });

  await t.test("a missing node reports not_found and a later valid read still succeeds", async () => {
    const response = await client.callTool({ name: "get_node", arguments: { id: randomUUID() } });
    assert.equal(response.isError, true);
    assert.equal(parse(response).error.code, "not_found");
    assert.deepEqual(response.structuredContent, parse(response));
    const known = await client.callTool({ name: "get_node", arguments: { id: first.id } });
    assert.notEqual(known.isError, true);
    assert.equal(parse(known).raw, args.raw);
  });
});
