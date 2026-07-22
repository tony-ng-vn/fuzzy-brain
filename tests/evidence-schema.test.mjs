// Integration tests against the real database for the evidence store
// (sources/episodes/evidence). Same discipline as db.test.mjs: brain_dev
// only, every test wrapped in a transaction that always rolls back.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

test("evidence store schema and constraints", async (t) => {
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await t.test("sources, episodes, and evidence tables exist in brain_dev", async () => {
      const { rows } = await client.query(
        "select to_regclass('brain_dev.sources') as s, to_regclass('brain_dev.episodes') as e, to_regclass('brain_dev.evidence') as v",
      );
      assert.notEqual(rows[0].s, null, "run npm run db:migrate to create the evidence store");
      assert.notEqual(rows[0].e, null);
      assert.notEqual(rows[0].v, null);
    });

    await t.test("a source registers with defaulted sync state and empty exclusions", async () => {
      await client.query("begin");
      try {
        const { rows } = await client.query(
          "insert into brain_dev.sources (kind, label) values ('claude_code_session', 'test source') returning sync_cursor, last_synced_at, exclusions",
        );
        assert.equal(rows[0].sync_cursor, null);
        assert.equal(rows[0].last_synced_at, null);
        assert.deepEqual(rows[0].exclusions, []);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("source kind and label reject blank values", async () => {
      await client.query("begin");
      try {
        await expectReject(
          client,
          "insert into brain_dev.sources (kind, label) values ('   ', 'x')",
          [],
          /check constraint/i,
        );
        await expectReject(
          client,
          "insert into brain_dev.sources (kind, label) values ('x', '   ')",
          [],
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("duplicate (kind, label) is rejected", async () => {
      await client.query("begin");
      try {
        await client.query("insert into brain_dev.sources (kind, label) values ('imessage', 'dup')");
        await assert.rejects(
          client.query("insert into brain_dev.sources (kind, label) values ('imessage', 'dup')"),
          /unique|duplicate/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("source exclusions must be a jsonb array", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query("insert into brain_dev.sources (kind, label, exclusions) values ('x', 'y', '{}'::jsonb)"),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("an episode requires a real source", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query(
            "insert into brain_dev.episodes (source_id, raw) values ('00000000-0000-0000-0000-000000000000', 'hello')",
          ),
          /foreign key/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("an episode with blank raw is rejected", async () => {
      await client.query("begin");
      try {
        const src = await client.query(
          "insert into brain_dev.sources (kind, label) values ('x', 'blank-raw-src') returning id",
        );
        await assert.rejects(
          client.query("insert into brain_dev.episodes (source_id, raw) values ($1, '   ')", [src.rows[0].id]),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("episode occurred_until cannot precede occurred_at, but equal is allowed", async () => {
      await client.query("begin");
      try {
        const src = await client.query(
          "insert into brain_dev.sources (kind, label) values ('x', 'span-src') returning id",
        );
        await expectReject(
          client,
          "insert into brain_dev.episodes (source_id, raw, occurred_at, occurred_until) values ($1, 'hi', '2026-07-13T12:00:00Z', '2026-07-13T11:00:00Z')",
          [src.rows[0].id],
          /check constraint/i,
        );
        const { rows } = await client.query(
          "insert into brain_dev.episodes (source_id, raw, occurred_at, occurred_until) values ($1, 'hi', '2026-07-13T12:00:00Z', '2026-07-13T12:00:00Z') returning id",
          [src.rows[0].id],
        );
        assert.ok(rows[0].id);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("episode source_locator is unique per source, but repeatable when null", async () => {
      await client.query("begin");
      try {
        const src = await client.query(
          "insert into brain_dev.sources (kind, label) values ('x', 'locator-src') returning id",
        );
        await client.query("insert into brain_dev.episodes (source_id, source_locator, raw) values ($1, 'loc-1', 'hi')", [
          src.rows[0].id,
        ]);
        await expectReject(
          client,
          "insert into brain_dev.episodes (source_id, source_locator, raw) values ($1, 'loc-1', 'again')",
          [src.rows[0].id],
          /unique|duplicate/i,
        );
        // Two null locators for the same source are both fine (hand-inserted episodes).
        await client.query("insert into brain_dev.episodes (source_id, raw) values ($1, 'hand a')", [src.rows[0].id]);
        const { rows } = await client.query("insert into brain_dev.episodes (source_id, raw) values ($1, 'hand b') returning id", [
          src.rows[0].id,
        ]);
        assert.ok(rows[0].id);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("evidence requires a real episode", async () => {
      await client.query("begin");
      try {
        await assert.rejects(
          client.query(
            "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ('00000000-0000-0000-0000-000000000000', 'hi', 0, 2)",
          ),
          /foreign key/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("evidence with blank quote is rejected", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        await assert.rejects(
          client.query("insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, '   ', 0, 3)", [
            ep,
          ]),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("evidence offsets must be non-negative and strictly ordered", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        await expectReject(
          client,
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hi', -1, 2)",
          [ep],
          /check constraint/i,
        );
        await expectReject(
          client,
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hi', 5, 5)",
          [ep],
          /check constraint/i,
        );
        await expectReject(
          client,
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hi', 5, 3)",
          [ep],
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("evidence span uniqueness prevents duplicate (episode, offsets)", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        await client.query("insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hello', 0, 5)", [
          ep,
        ]);
        await expectReject(
          client,
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hello', 0, 5)",
          [ep],
          /unique|duplicate/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    // Offsets index into the episode's raw text, so they must bound the quote's
    // length for ordinary spans. This does NOT hold for redacted spans: the
    // placeholder text ("[REDACTED:reason]") has a different length than the
    // sensitive text it replaced, by design (evidence_redaction_is_placeholder_only
    // below is what actually governs redacted rows).
    await t.test("evidence offsets exactly bound their quoted text (non-redacted spans only)", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world, my ssn is not here");
        await client.query(
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hello', 0, 5)",
          [ep],
        );
        await client.query(
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, redaction_reason) values ($1, '[REDACTED:ssn_pattern]', 20, 31, 'ssn_pattern')",
          [ep],
        );
        const { rows } = await client.query(`
          select id, start_offset, end_offset, char_length(quote) as quote_length
          from brain_dev.evidence
          where episode_id = $1 and redaction_reason is null
            and end_offset - start_offset <> char_length(quote)
        `, [ep]);
        assert.deepEqual(rows, []);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("a redacted evidence row must carry the exact bracket placeholder for its reason", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "my ssn is 123-45-6789 ok");
        const { rows } = await client.query(
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, redaction_reason) values ($1, '[REDACTED:ssn_pattern]', 10, 21, 'ssn_pattern') returning id",
          [ep],
        );
        assert.ok(rows[0].id);
        await assert.rejects(
          client.query(
            "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, redaction_reason) values ($1, '123-45-6789', 10, 21, 'ssn_pattern')",
            [ep],
          ),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("redaction_reason cannot be a blank string", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        await assert.rejects(
          client.query(
            "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, redaction_reason) values ($1, 'hi', 0, 2, '   ')",
            [ep],
          ),
          /check constraint/i,
        );
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("speaker rejects a blank string but allows null", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        await expectReject(
          client,
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker) values ($1, 'hi', 0, 2, '  ')",
          [ep],
          /check constraint/i,
        );
        const { rows } = await client.query(
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hi', 0, 2) returning speaker",
          [ep],
        );
        assert.equal(rows[0].speaker, null);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("sender_deleted_at is set exactly once, never reversed", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        const ev = await client.query(
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hello', 0, 5) returning id",
          [ep],
        );
        const first = await client.query(
          "update brain_dev.evidence set sender_deleted_at = now() where id = $1 and sender_deleted_at is null returning sender_deleted_at",
          [ev.rows[0].id],
        );
        assert.equal(first.rowCount, 1);
        const stamped = first.rows[0].sender_deleted_at;
        const second = await client.query(
          "update brain_dev.evidence set sender_deleted_at = now() where id = $1 and sender_deleted_at is null returning sender_deleted_at",
          [ev.rows[0].id],
        );
        assert.equal(second.rowCount, 0);
        const check = await client.query("select sender_deleted_at from brain_dev.evidence where id = $1", [ev.rows[0].id]);
        assert.deepEqual(check.rows[0].sender_deleted_at, stamped);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("episodes and evidence reject deletion of a row still referenced", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        await client.query("insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hello', 0, 5)", [
          ep,
        ]);
        await assert.rejects(client.query("delete from brain_dev.episodes where id = $1", [ep]), /foreign key|violates/i);
      } finally {
        await client.query("rollback");
      }
    });
  } finally {
    await client.end();
  }

  // Postgres aborts the whole transaction after any failed statement, so a
  // rejected query followed by more statements needs a savepoint to recover:
  // the savepoint isolates the failure, and rolling back to it (not the
  // whole transaction) clears the aborted state while keeping everything
  // inserted before it intact.
  async function expectReject(client, sql, params, pattern) {
    await client.query("savepoint sp");
    try {
      await assert.rejects(client.query(sql, params), pattern);
    } finally {
      await client.query("rollback to savepoint sp");
    }
  }

  async function insertEpisode(client, raw) {
    const src = await client.query("insert into brain_dev.sources (kind, label) values ('x', gen_random_uuid()::text) returning id");
    const ep = await client.query("insert into brain_dev.episodes (source_id, raw) values ($1, $2) returning id", [
      src.rows[0].id,
      raw,
    ]);
    return ep.rows[0].id;
  }
});

// The wildcard backfill shells out to brain.mjs once per episode, and every
// spawn opens a fresh TLS connection to the cloud DB -- on a degraded
// network that dominated per-episode cost (2026-07-16). This is the array
// form's own contract test, direct against the CLI verb (not through
// ingest-sessions.mjs): one process, one connection, many episodes, but
// each episode still commits (or rolls back) entirely on its own.
test("add-episode CLI: the array form commits each episode in its own transaction", async (t) => {
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();

  const brainCli = join(here, "..", "scripts", "brain.mjs");
  const env = { ...process.env, BRAIN_SCHEMA: "brain_dev" };
  let sourceId;

  try {
    const src = await client.query(
      "insert into brain_dev.sources (kind, label) values ('x', gen_random_uuid()::text) returning id",
    );
    sourceId = src.rows[0].id;

    const locators = ["batch-a", "batch-bad-offsets", "batch-c"];
    const episodes = [
      { source_id: sourceId, source_locator: locators[0], raw: "first episode raw text" },
      {
        source_id: sourceId,
        source_locator: locators[1],
        raw: "second episode, whose evidence span is invalid",
        // end_offset before start_offset: violates evidence_offsets_ordered,
        // so this episode's own transaction must roll back whole.
        evidence: [{ quote: "bad span", start_offset: 5, end_offset: 2 }],
      },
      { source_id: sourceId, source_locator: locators[2], raw: "third episode raw text" },
    ];

    const out = execFileSync("node", [brainCli, "add-episode"], {
      encoding: "utf8",
      input: JSON.stringify(episodes),
      env,
    });
    const results = JSON.parse(out);

    await t.test("returns one ordered result per input episode", () => {
      assert.equal(results.length, 3);
      assert.equal(results[0].source_locator, locators[0]);
      assert.equal(results[1].source_locator, locators[1]);
      assert.equal(results[2].source_locator, locators[2]);
    });

    await t.test("the two valid episodes commit and echo a slim result, never the raw", () => {
      assert.ok(results[0].id, "successful entries echo the inserted episode's id");
      assert.ok(results[2].id);
      assert.equal(results[0].error, undefined);
      assert.equal(results[2].error, undefined);
      // Batch mode must never echo raw back: a handful of giant episodes
      // doing so in one array blew execFileSync's maxBuffer and killed the
      // exchange mid-call (EPIPE, 2026-07-16) -- no caller reads raw from a
      // batch result, so the array form's success shape is deliberately slim.
      assert.deepEqual(Object.keys(results[0]).sort(), ["evidence_count", "id", "source_locator"]);
      assert.equal(results[0].raw, undefined);
    });

    await t.test("the mid-array invalid episode errors in its own slot, not its neighbors'", () => {
      assert.ok(results[1].error, "the invalid episode must report an error, not a row");
      assert.equal(results[1].error.split("\n").length, 1, "error must be first-line-only");
      assert.equal(results[1].id, undefined);
    });

    await t.test("the invalid episode never landed a row -- its own transaction rolled back whole", async () => {
      const { rows } = await client.query(
        "select source_locator from brain_dev.episodes where source_id = $1 order by source_locator",
        [sourceId],
      );
      assert.deepEqual(
        rows.map((r) => r.source_locator).sort(),
        [locators[0], locators[2]].sort(),
      );
    });

    await t.test("the single-object form is unchanged: still echoes the full row, including raw", () => {
      const singleOut = execFileSync("node", [brainCli, "add-episode"], {
        encoding: "utf8",
        input: JSON.stringify({ source_id: sourceId, source_locator: "batch-single-echo", raw: "single object raw text" }),
        env,
      });
      const single = JSON.parse(singleOut);
      assert.equal(single.raw, "single object raw text", "single-object callers still get the full echo back (compatibility)");
      assert.ok(single.id);
    });
  } finally {
    if (sourceId) {
      await client.query(
        "delete from brain_dev.evidence v using brain_dev.episodes e where v.episode_id = e.id and e.source_id = $1",
        [sourceId],
      );
      await client.query("delete from brain_dev.episodes where source_id = $1", [sourceId]);
      await client.query("delete from brain_dev.sources where id = $1", [sourceId]);
    }
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
