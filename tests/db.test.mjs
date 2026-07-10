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
  // Tests always run in the brain_dev sandbox so the real brain is untouchable,
  // on top of the per-test transactions that roll back.
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("set search_path to brain_dev");

  try {
    await t.test("the brain_dev sandbox exists", async () => {
      const { rows } = await client.query("select current_schema() as s");
      assert.equal(rows[0].s, "brain_dev", "run npm run db:migrate to create the sandbox schema");
    });

    await t.test("connection is healthy", async () => {
      const { rows } = await client.query("select 1 as ok");
      assert.equal(rows[0].ok, 1);
    });

    await t.test("nodes and edges round-trip inside a transaction", async () => {
      await client.query("begin");
      try {
        const a = await client.query(
          "insert into nodes (type, title, body, raw) values ('story', 'test a', 'body a', 'raw a') returning id, raw",
        );
        assert.equal(a.rows[0].raw, "raw a");
        const b = await client.query(
          "insert into nodes (type, title, body, raw) values ('lesson', 'test b', 'body b', 'raw b') returning id",
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
          "insert into nodes (type, title, raw) values ('story', 'test a', 'raw a') returning id",
        );
        const b = await client.query(
          "insert into nodes (type, title, raw) values ('story', 'test b', 'raw b') returning id",
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

    await t.test("node with blank raw is rejected", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query("insert into nodes (type, title, raw) values ('story', 'test blank raw', '   ')"),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("talk recaps round-trip inside a transaction", async () => {
      await client.query("begin");
      try {
        const { rows } = await client.query(
          "insert into talks (recap) values ('shared the trip story; connected it to the split; left the bravery question open') returning recap",
        );
        assert.match(rows[0].recap, /bravery question open/);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("talk with a blank recap is rejected", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query("insert into talks (recap) values ('   ')"),
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
