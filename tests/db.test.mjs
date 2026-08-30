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

  try {
    await t.test("the brain_dev sandbox exists", async () => {
      const { rows } = await client.query("select to_regnamespace('brain_dev') is not null as exists");
      assert.equal(rows[0].exists, true, "run npm run db:migrate to create the sandbox schema");
    });

    await t.test("connection is healthy", async () => {
      const { rows } = await client.query("select 1 as ok");
      assert.equal(rows[0].ok, 1);
    });

    await t.test("nodes and edges round-trip inside a transaction", async () => {
      await client.query("begin");
      try {
        const a = await client.query(
          "insert into brain_dev.nodes (type, title, body, raw) values ('story', 'test a', 'body a', 'raw a') returning id, raw",
        );
        assert.equal(a.rows[0].raw, "raw a");
        const b = await client.query(
          "insert into brain_dev.nodes (type, title, body, raw) values ('lesson', 'test b', 'body b', 'raw b') returning id",
        );
        const edge = await client.query(
          "insert into brain_dev.edges (source, target, why) values ($1, $2, 'a taught b') returning why",
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
          "insert into brain_dev.nodes (type, title, raw) values ('story', 'test a', 'raw a') returning id",
        );
        const b = await client.query(
          "insert into brain_dev.nodes (type, title, raw) values ('story', 'test b', 'raw b') returning id",
        );
        await assert.rejects(
          client.query("insert into brain_dev.edges (source, target, why) values ($1, $2, '   ')", [
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
          client.query("insert into brain_dev.nodes (type, title, raw) values ('story', 'test blank raw', '   ')"),
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
          "insert into brain_dev.talks (recap) values ('shared the trip story; connected it to the split; left the bravery question open') returning recap",
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
          client.query("insert into brain_dev.talks (recap) values ('   ')"),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("temporal events preserve deadline and completion history", async () => {
      const table = await client.query("select to_regclass('brain_dev.node_temporal_events') as name");
      assert.equal(table.rows[0].name, "brain_dev.node_temporal_events");

      await client.query("begin");
      try {
        const node = await client.query(
          "insert into brain_dev.nodes (type, title, body, raw) values ('goal', 'test deadline', 'test deadline', 'finish it by friday') returning id",
        );
        const nodeId = node.rows[0].id;
        await client.query(
          `insert into brain_dev.node_temporal_events
             (node_id, event_type, value_at, raw, origin)
           values ($1, 'deadline_set', '2027-08-06T06:59:59.999Z', 'finish it by friday', 'derived')`,
          [nodeId],
        );
        let state = await client.query("select * from brain_dev.node_temporal_state where node_id = $1", [nodeId]);
        assert.equal(state.rows[0].status, "active");
        assert.equal(state.rows[0].due_at.toISOString(), "2027-08-06T06:59:59.999Z");

        await client.query(
          `insert into brain_dev.node_temporal_events
             (node_id, event_type, occurred_at, raw, origin)
           values ($1, 'completed', '2026-08-06T23:08:16Z', 'i finished it please mark it', 'explicit')`,
          [nodeId],
        );
        state = await client.query("select * from brain_dev.node_temporal_state where node_id = $1", [nodeId]);
        assert.equal(state.rows[0].status, "completed");
        assert.equal(state.rows[0].status_changed_at.toISOString(), "2026-08-06T23:08:16.000Z");

        await client.query("delete from brain_dev.node_temporal_events where node_id = $1", [nodeId]);
        const remaining = await client.query(
          "select count(*)::int as n from brain_dev.node_temporal_events where node_id = $1",
          [nodeId],
        );
        assert.equal(remaining.rows[0].n, 0, "sandbox cleanup must remain available");

        await assert.rejects(
          client.query(
            `insert into brain_dev.node_temporal_events
               (node_id, event_type, raw, origin)
             values ($1, 'deadline_set', 'missing the deadline value', 'derived')`,
            [nodeId],
          ),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("public temporal history has an append-only mutation trigger", async () => {
      const { rows } = await client.query(
        `select t.tgenabled, pg_get_triggerdef(t.oid) as definition
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname = 'node_temporal_events'
           and t.tgname = 'node_temporal_events_append_only'
           and not t.tgisinternal`,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tgenabled, "O");
      assert.match(rows[0].definition, /before delete or update|before update or delete/i);
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
