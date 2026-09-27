import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { searchArchive } from "../scripts/lib/tbrain-store.mjs";

const exec = promisify(execFile);
test("archive search follows its own continuation beyond 100000 matches", async t => {
  const db = await createTbrainTestDatabase();
  const client = new Client({ name: "archive-page-test", version: "1" });
  t.after(async () => { await client.close(); await db.close(); });
  const source = randomUUID(), episode = randomUUID();
  await db.client.query("insert into brain_dev.sources(id,kind,label) values($1,'test','Search pagination')", [source]);
  await db.client.query("insert into brain_dev.episodes(id,source_id,raw) values($1,$2,'Search pagination')", [episode, source]);
  await db.client.query("insert into brain_dev.evidence(episode_id,quote,start_offset,end_offset) select $1,'paginationmarker',n*17,n*17+16 from generate_series(1,100023) n", [episode]);
  const env = { ...process.env, DATABASE_URL: db.url, DATABASE_URL_DEV: db.url, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE: "0" };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/tbrain-mcp.mjs"], env, stderr: "pipe" }));
  const readers = {
    storage: input => searchArchive(db.client, "brain_dev", input),
    mcp: async input => {
      const result = await client.callTool({ name: "search_archive", arguments: input });
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content[0].text);
    },
    cli: async input => JSON.parse((await exec(process.execPath, ["scripts/tbrain.mjs", "search", input.query, "--offset", String(input.offset), "--limit", String(input.limit)], { env, timeout: 20000 })).stdout),
  };
  for (const [name, read] of Object.entries(readers)) await t.test(name, async () => {
    const first = await read({ query: "paginationmarker", offset: 100000, limit: 20 });
    assert.equal(first.hits.length, 20);
    assert.equal(first.next_offset, 100020);
    const last = await read({ query: "paginationmarker", offset: first.next_offset, limit: 20 });
    assert.equal(last.hits.length, 3);
    assert.equal(last.next_offset, null);
    assert.equal(new Set([...first.hits, ...last.hits].map(hit => hit.id)).size, 23);
  });
  for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await client.callTool({ name: "search_archive", arguments: { query: "paginationmarker", offset } })).isError, true);
  }
});
