import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
const run = promisify(execFile);

test("both memory connections and the portable command explain pending archive indexing", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const source = randomUUID();
  await database.client.query("insert into brain_dev.sources(id,kind,label) values($1,'index_test','Index test')", [source]);
  const receipt = await importTransfer(database.client, "brain_dev", fixture({ source_id: source }), { authorized: true, allowedSourceIds: [source] });
  const env = { ...process.env, DATABASE_URL: database.url, DATABASE_URL_DEV: database.url, BRAIN_SCHEMA: "brain_dev", TBRAIN_TRACE: "0" };
  for (const script of ["fuzzy-brain-mcp.mjs", "tbrain-mcp.mjs"]) {
    await t.test(script, async () => {
      const client = new Client({ name: "index-test", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath,
          args: [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], env, stderr: "pipe" }));
        const tool = (await client.listTools()).tools.find(tool => tool.name === "index_status");
        assert.ok(tool, "callers need index_status");
        assert.equal(tool.annotations.readOnlyHint, true);
        const result = await client.callTool({ name: "index_status", arguments: { receipt_id: receipt.id } });
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.evidence.pending, 2);
        assert.equal(result.structuredContent.semantic_index.state, "pending");
        assert.equal((await client.callTool({ name: "index_status", arguments: { source_id: source, receipt_id: receipt.id } })).isError, true);
        assert.equal((await client.callTool({ name: "index_status", arguments: { receipt_id: randomUUID() } })).structuredContent.error.code, "not_found");
      } finally { await client.close(); }
    });
  }
  const script = fileURLToPath(new URL("../scripts/tbrain.mjs", import.meta.url));
  const output = await run(process.execPath, [script, "index-status", "--receipt-id", receipt.id], { env });
  assert.equal(JSON.parse(output.stdout).evidence.pending, 2);
  await assert.rejects(run(process.execPath, [script, "index-status", "--limit", "4"], { env }), error => JSON.parse(error.stderr).error.code === "invalid");
});
