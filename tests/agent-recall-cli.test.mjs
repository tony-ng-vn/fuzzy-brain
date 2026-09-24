import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { importTransfer } from "../scripts/lib/tbrain-store.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";

function cli(args, env = {}) {
  return execFileSync(process.execPath, ["scripts/recall.mjs", ...args], {
    encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: "postgresql://127.0.0.1:1/unavailable", ...env },
  });
}

test("recall help and invalid filters work before connecting to storage", () => {
  const help = JSON.parse(cli(["--help"]));
  assert.equal(help.state, "help");
  assert.match(help.usage, /--source-id.*--role.*--from.*--until/);
  for (const args of [
    ["question", "--invented", "PRIVATE_VALUE"], ["question", "--role"],
    ["question", "--role", "user", "--role", "assistant"], ["question", "unexpected"],
    ["question", "--layer", "nodes", "--source-id", randomUUID()],
    ["question", "--from", "2026-09-24T00:00:00Z", "--until", "2026-09-23T00:00:00Z"],
  ]) assert.throws(() => cli(args), error => {
    assert.match(error.stderr, /invalid recall/i);
    assert.doesNotMatch(error.stderr, /ECONNREFUSED|PRIVATE_VALUE/);
    return true;
  });
});

test("the recall CLI forwards explicit filters into ranked retrieval", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const source = randomUUID();
  const marker = `scopecli${randomUUID().replaceAll("-", "")}`;
  const at = "2026-09-24T01:00:00.000Z";
  await database.client.query("insert into brain_dev.sources(id,kind,label) values($1,'cli_scope',$2)", [source, source]);
  const packet = fixture({ source_id: source });
  packet.messages = ["user", "assistant"].map(role => ({ id: null, role, speaker: null, at, fidelity: "verbatim", text: marker }));
  const receipt = await importTransfer(database.client, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
  const result = JSON.parse(cli([marker, "--json", "--source-id", source, "--role", "user", "--from", at, "--until", at],
    { DATABASE_URL: database.url, BRAIN_SCHEMA: "brain_dev" }));
  assert.deepEqual(result.hits.map(hit => hit.provenance.evidence_id), [receipt.evidence_ids[0]]);
  assert.equal(result.scope.layer, "evidence");
  assert.equal(result.scope.role, "user");
  assert.equal(result.date_filter.bounds, "[]");
});
