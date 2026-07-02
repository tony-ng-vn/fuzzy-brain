// Integration tests against the real database. Everything runs inside a
// rolled-back transaction so the brain itself is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

test("database schema and constraints", async (t) => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await t.test("connection is healthy", async () => {
      const { rows } = await client.query("select 1 as ok");
      assert.equal(rows[0].ok, 1);
    });

    await t.test("nodes and edges round-trip inside a transaction", async () => {
      await client.query("begin");
      try {
        const a = await client.query(
          "insert into nodes (type, title, body) values ('story', 'test a', 'body a') returning id",
        );
        const b = await client.query(
          "insert into nodes (type, title, body) values ('lesson', 'test b', 'body b') returning id",
        );
        const edge = await client.query(
          "insert into edges (source, target, why) values ($1, $2, 'a taught b') returning why",
          [a.rows[0].id, b.rows[0].id],
        );
        assert.equal(edge.rows[0].why, "a taught b");
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("edge without a why sentence is rejected", async () => {
      await client.query("begin");
      try {
        const a = await client.query(
          "insert into nodes (type, title) values ('story', 'test a') returning id",
        );
        const b = await client.query(
          "insert into nodes (type, title) values ('story', 'test b') returning id",
        );
        await assert.rejects(
          client.query("insert into edges (source, target, why) values ($1, $2, '   ')", [
            a.rows[0].id,
            b.rows[0].id,
          ]),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });
  } finally {
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
