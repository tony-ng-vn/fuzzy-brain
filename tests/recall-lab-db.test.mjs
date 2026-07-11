import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lab = join(root, "experiments", "polygres-recall-lab");
loadEnvLocal();

test("recall lab evidence offsets exactly bound their quoted text", async () => {
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("begin");
  try {
    await client.query("set local search_path to brain_dev, public");
    await client.query(readFileSync(join(lab, "schema.sql"), "utf8"));
    await client.query(readFileSync(join(lab, "seed.sql"), "utf8"));
    const { rows } = await client.query(`
      select id, start_offset, end_offset, char_length(quote) as quote_length
      from brain_dev.recall_lab_evidence_spans
      where end_offset - start_offset <> char_length(quote)
      order by id
    `);
    assert.deepEqual(rows, []);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

function loadEnvLocal() {
  try {
    const text = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // No local env file; rely on the process environment.
  }
}
