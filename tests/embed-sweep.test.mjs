// Integration test for the embedding sweep, against brain_dev (rule 9).
// Seeds fixture rows with null embeddings, sweeps, and proves the fill is
// real and idempotent: a second run never rewrites a filled embedding and
// never touches any other column.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
loadEnvLocal();

const TEST_LABEL = "embed-sweep-test";
const NODE_TITLE = "embed-sweep-test-node";

test("embed-sweep: fills null embeddings in brain_dev, idempotently", async (t) => {
  // The sweep needs the model; if it cannot load, skip like embeddings.test.
  try {
    const { embedDocument } = await import("../scripts/lib/embeddings.mjs");
    await embedDocument("probe");
  } catch (err) {
    t.skip(`embedding model unavailable (${err.message}); run once online to cache the weights`);
    return;
  }

  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();

  const run = () =>
    execFileSync("node", [join(root, "scripts", "embed-sweep.mjs"), "--limit", "8"], {
      encoding: "utf8",
      env: { ...process.env, BRAIN_SCHEMA: "brain_dev" },
    });

  try {
    const src = await client.query(
      "insert into brain_dev.sources (kind, label) values ('x', $1) returning id",
      [TEST_LABEL],
    );
    const ep = await client.query(
      "insert into brain_dev.episodes (source_id, raw) values ($1, 'tony:\nhello sweep') returning id",
      [src.rows[0].id],
    );
    const evA = await client.query(
      "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker) values ($1, 'my girlfriend lives in arizona now', 0, 34, 'tony') returning id",
      [ep.rows[0].id],
    );
    const evB = await client.query(
      "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker) values ($1, 'the migration added an hnsw index', 40, 73, 'assistant') returning id",
      [ep.rows[0].id],
    );
    const node = await client.query(
      "insert into brain_dev.nodes (type, title, raw, body) values ('moment', $1, 'a raw thought for the sweep', 'a readable line') returning id",
      [NODE_TITLE],
    );
    const evidenceIds = [evA.rows[0].id, evB.rows[0].id];
    const nodeId = node.rows[0].id;

    const firstRun = run();

    await t.test("fixture evidence and node embeddings are filled with 768 dims", async () => {
      const ev = await client.query(
        "select id, vector_dims(embedding) as dims from brain_dev.evidence where id = any($1::uuid[]) order by start_offset",
        [evidenceIds],
      );
      assert.equal(ev.rows.length, 2);
      for (const r of ev.rows) assert.equal(r.dims, 768);
      const nd = await client.query("select vector_dims(embedding) as dims from brain_dev.nodes where id = $1", [
        nodeId,
      ]);
      assert.equal(nd.rows[0].dims, 768);
    });

    await t.test("the sweep reports what it filled", () => {
      assert.match(firstRun, /evidence/i);
      assert.match(firstRun, /nodes/i);
    });

    await t.test("a second run rewrites nothing: filled embeddings and content stay put", async () => {
      const before = await client.query(
        "select id, embedding::text as vec, quote, speaker from brain_dev.evidence where id = any($1::uuid[]) order by start_offset",
        [evidenceIds],
      );
      run();
      const after = await client.query(
        "select id, embedding::text as vec, quote, speaker from brain_dev.evidence where id = any($1::uuid[]) order by start_offset",
        [evidenceIds],
      );
      assert.deepEqual(after.rows, before.rows);
      const nodeAfter = await client.query(
        "select embedding is not null as filled, raw, body, title from brain_dev.nodes where id = $1",
        [nodeId],
      );
      assert.equal(nodeAfter.rows[0].filled, true);
      assert.equal(nodeAfter.rows[0].raw, "a raw thought for the sweep");
      assert.equal(nodeAfter.rows[0].body, "a readable line");
    });
  } finally {
    // brain_dev-only cleanup, restrict-ordered: evidence -> episodes -> source.
    await client.query(
      `delete from brain_dev.evidence v using brain_dev.episodes e, brain_dev.sources s
       where v.episode_id = e.id and e.source_id = s.id and s.label = $1`,
      [TEST_LABEL],
    );
    await client.query(
      `delete from brain_dev.episodes e using brain_dev.sources s where e.source_id = s.id and s.label = $1`,
      [TEST_LABEL],
    );
    await client.query("delete from brain_dev.sources where label = $1", [TEST_LABEL]);
    await client.query("delete from brain_dev.nodes where title = $1", [NODE_TITLE]);
    await client.end();
  }
});

function loadEnvLocal() {
  try {
    const text = readFileSync(join(here, "..", ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // no .env.local; rely on the environment
  }
}
