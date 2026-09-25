import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { readSource } from "../scripts/lib/tbrain-store.mjs";

const exec = promisify(execFile);

test("long source continuation positions remain readable through storage, MCP, and CLI", async t => {
  const db = await createTbrainTestDatabase();
  const client = new Client({ name: "tbrain-long-read-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await db.close(); });
  const env = { ...process.env, DATABASE_URL: db.url, DATABASE_URL_DEV: db.url, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE: "0" };
  const source = randomUUID();
  await db.client.query("insert into brain_dev.sources(id,kind,label) values($1,'test','Long read test')", [source]);
  const episode = randomUUID(), original = "source ".repeat(720000) + "source ending";
  await db.client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,$3)", [episode, source, original]);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/tbrain-mcp.mjs"], env, stderr: "pipe" }));
  const mcp = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.notEqual(reply.isError, true);
    return JSON.parse(reply.content[0].text);
  };
  const cli = async args => JSON.parse((await exec(process.execPath, ["scripts/tbrain.mjs", ...args], { env, timeout: 20000 })).stdout);
  const callers = {
    storage: { source: args => readSource(db.client, "brain_dev", args) },
    mcp: { source: args => mcp("read_source", args) },
    cli: {
      source: args => cli(["source", args.id, "--offset", String(args.offset), "--limit", "12000"]),
    },
  };
  for (const [name, reader] of Object.entries(callers)) await t.test(name, async () => {
    let offset = 5000000, joined = "";
    do {
      const page = await reader.source({ id: episode, offset, limit: 12000 });
      assert.ok(page.text.length <= 12000);
      assert.equal(page.text, original.slice(offset, offset + 12000));
      joined += page.text; offset = page.next_offset;
    } while (offset !== null);
    assert.equal(joined, original.slice(5000000));
  });
  for (const args of [{ id: episode, offset: -1 }, { id: episode, offset: Number.MAX_SAFE_INTEGER + 1 }, { id: episode, limit: 12001 }]) {
    assert.equal((await client.callTool({ name: "read_source", arguments: args })).isError, true);
  }
});
