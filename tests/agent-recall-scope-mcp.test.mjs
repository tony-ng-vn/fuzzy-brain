import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { productionServices } from "../scripts/fuzzy-brain-mcp.mjs";

test("both memory servers advertise and enforce the same ranked recall filters", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const source = randomUUID();
  const marker = `scopetransport${randomUUID().replaceAll("-", "")}`;
  const at = "2026-09-24T02:00:00.000Z";
  await database.client.query("insert into brain_dev.sources(id,kind,label) values($1,'scope_test',$2)", [source, source]);
  const packet = fixture({ source_id: source });
  packet.messages = ["user", "assistant"].map(role => ({ id: null, role, speaker: null, at, fidelity: "verbatim", text: marker }));
  const receipt = await importTransfer(database.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
  await database.client.query("insert into brain_dev.nodes(type,title,body,raw) values('note',$1,$1,$1)", [marker]);
  for (const script of ["fuzzy-brain-mcp.mjs", "tbrain-mcp.mjs"]) {
    await t.test(script, async () => {
      const client = new Client({ name: "scope-transport-test", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath,
          args: [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))],
          env: { PATH: process.env.PATH, DATABASE_URL: database.url, DATABASE_URL_DEV: database.url, BRAIN_SCHEMA: "brain_dev" }, stderr: "pipe" }));
        const tool = (await client.listTools()).tools.find(tool => tool.name === "recall");
        for (const key of ["question", "source_id", "role", "layer", "from", "until"]) assert.ok(tool.inputSchema.properties[key], key);
        const response = await client.callTool({ name: "recall", arguments: {
          question: marker, source_id: source, role: "user", from: at, until: at,
        } });
        assert.notEqual(response.isError, true);
        const result = JSON.parse(response.content[0].text);
        assert.deepEqual(response.structuredContent, result);
        assert.deepEqual(result.hits.map(hit => hit.provenance.evidence_id), [receipt.evidence_ids[0]]);
        assert.equal(result.scope.layer, "evidence");
        assert.equal(result.scope.source_id, source);
        const invalid = await client.callTool({ name: "recall", arguments: { question: marker, layer: "nodes", role: "user" } });
        assert.equal(invalid.isError, true);
        assert.equal(JSON.parse(invalid.content[0].text).error.code, "invalid");
      } finally { await client.close(); }
    });
  }
});

test("contradictory scope is rejected before the resident service opens storage", async () => {
  let accesses = 0;
  const services = productionServices({ pool: { async withClient() { accesses++; throw new Error("unavailable test storage"); } } });
  await assert.rejects(async () => services.recall("a question", { layer: "nodes", role: "user" }), error => error.code === "invalid");
  assert.equal(accesses, 0);
});
