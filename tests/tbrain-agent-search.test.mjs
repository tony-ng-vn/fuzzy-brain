import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";
import { importTransfer, searchArchive } from "../scripts/lib/tbrain-store.mjs";

function cli(args, extra = {}) {
  return JSON.parse(execFileSync(process.execPath, ["scripts/tbrain.mjs", ...args], {
    encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: "postgresql://127.0.0.1:1/unavailable", ...extra },
  }));
}

test("CLI help and invalid argument feedback work without a reachable database", () => {
  const help = cli(["--help"]);
  assert.equal(help.state, "help");
  assert.match(JSON.stringify(help), /evidence|--offset/);
  for (const args of [["unknown"], ["search", "clue", "--limit", "0"], ["search", "clue", "--invented", "x"]]) {
    assert.throws(() => cli(args), error => /invalid/.test(error.stderr) && !/unavailable/.test(error.stderr));
  }
});

test("portable validation explains which field failed without echoing its value", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-"));
  try {
    const path = join(dir, "transfer.json");
    const packet = fixture();
    packet.messages[0].at = "PRIVATE_BAD_DATE";
    writeFileSync(path, JSON.stringify(packet), { mode: 0o600 });
    assert.throws(() => cli(["validate", path]), error => {
      const result = JSON.parse(error.stderr);
      assert.equal(result.saved, false);
      assert.ok(result.issues.some(issue => issue.path === "messages.0.at"));
      assert.doesNotMatch(error.stderr, /PRIVATE_BAD_DATE/);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agents can narrow search by source and speaker role, then follow a hit through the CLI", async t => {
  const database = await createTbrainTestDatabase();
  t.after(() => database.close());
  const db = database.client;
  const source = randomUUID();
  const marker = `search${randomUUID().replaceAll("-", "")}`;
  await db.query("insert into brain_dev.sources(id,kind,label) values($1,'agent_search_test',$2)", [source, source]);
  const packet = fixture({ source_id: source, source_key: randomUUID() });
  packet.messages = [
    { id: null, role: "user", speaker: "Tony", text: `${marker} from the human`, at: null, fidelity: "verbatim" },
    { id: null, role: "assistant", speaker: null, text: `${marker} from the assistant`, at: null, fidelity: "verbatim" },
  ];
  const receipt = await importTransfer(db, "brain_dev", packet, { authorized: true, allowedSourceIds: [source] });
  const result = await searchArchive(db, "brain_dev", { query: marker, source_id: source, role: "user" });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].role, "user");
  assert.equal(result.hits[0].source.id, source);
  assert.deepEqual(result.hits[0].read, { tool: "read_evidence", arguments: { id: receipt.evidence_ids[0] } });
  assert.equal((await searchArchive(db, "brain_dev", { query: marker, source_id: randomUUID() })).hits.length, 0);
  const env = { DATABASE_URL: database.url, BRAIN_SCHEMA: "brain_dev" };
  const page = cli(["search", marker, "--source-id", source, "--role", "assistant", "--limit", "1"], env);
  assert.equal(page.hits.length, 1);
  assert.equal(page.hits[0].role, "assistant");
  const read = cli(["evidence", page.hits[0].id, "--context", "0", "--text-offset", "3", "--text-limit", "8"], env);
  assert.equal(read.evidence.text, packet.messages[1].text.slice(3, 11));
  const beyond = cli(["search", marker, "--offset", "2"], env);
  assert.equal(beyond.hits.length, 0);
});
