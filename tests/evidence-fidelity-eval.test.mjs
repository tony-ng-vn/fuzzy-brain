// The master plan's literal Phase 1 done-bar: "a hand-inserted episode
// round-trips; the fidelity eval exists and passes on the hand-inserted
// sample." This is that eval. It tests exclusions STORAGE (round-trips
// correctly), not exclusions ENFORCEMENT -- no pipeline exists yet to skip
// content against a rule; that is a Phase 2 test, once one does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

test("evidence store fidelity: a hand-inserted sample round-trips intact", async (t) => {
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("begin");

  const REAL_QUOTE_ONE = "the trip felt like two different lives, side by side";
  const REAL_QUOTE_TWO = "unicode and punctuation survive: — café, \"quoted\", newline\nhere";
  const SENSITIVE_TEXT = "123-45-6789";
  const RAW = `episode start. ${REAL_QUOTE_ONE}. later: my ssn is ${SENSITIVE_TEXT} ok. ${REAL_QUOTE_TWO}. end.`;

  try {
    const src = await client.query(
      `insert into brain_dev.sources (kind, label, exclusions)
       values ('claude_code_session', 'fidelity-eval-source', $1::jsonb)
       returning id, exclusions`,
      [JSON.stringify([{ kind: "person", value: "Jane Doe", added_at: "2026-07-12T00:00:00Z" }])],
    );
    const sourceId = src.rows[0].id;

    const occurredAt = "2026-07-10T09:00:00Z";
    const ep = await client.query(
      `insert into brain_dev.episodes (source_id, source_locator, raw, occurred_at)
       values ($1, 'fidelity-eval-episode', $2, $3)
       returning id, raw, occurred_at, ingested_at`,
      [sourceId, RAW, occurredAt],
    );
    const episodeId = ep.rows[0].id;

    const startOne = RAW.indexOf(REAL_QUOTE_ONE);
    const startTwo = RAW.indexOf(REAL_QUOTE_TWO);
    const sensitiveStart = RAW.indexOf(SENSITIVE_TEXT);

    await client.query(
      "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, occurred_at) values ($1, $2, $3, $4, $5)",
      [episodeId, REAL_QUOTE_ONE, startOne, startOne + REAL_QUOTE_ONE.length, occurredAt],
    );
    const evTwo = await client.query(
      "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker) values ($1, $2, $3, $4, 'tony') returning id",
      [episodeId, REAL_QUOTE_TWO, startTwo, startTwo + REAL_QUOTE_TWO.length],
    );
    await client.query(
      `insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, redaction_reason)
       values ($1, '[REDACTED:ssn_pattern]', $2, $3, 'ssn_pattern')`,
      [episodeId, sensitiveStart, sensitiveStart + SENSITIVE_TEXT.length],
    );

    await t.test("counts reconcile", async () => {
      const { rows } = await client.query("select count(*)::int as n from brain_dev.evidence where episode_id = $1", [
        episodeId,
      ]);
      assert.equal(rows[0].n, 3);
    });

    await t.test("non-redacted quotes are byte-for-byte identical to what was inserted", async () => {
      const { rows } = await client.query(
        "select quote from brain_dev.evidence where episode_id = $1 and redaction_reason is null order by start_offset",
        [episodeId],
      );
      assert.equal(rows[0].quote, REAL_QUOTE_ONE);
      assert.equal(rows[1].quote, REAL_QUOTE_TWO);
    });

    await t.test("occurred_at and ingested_at are both populated and meaningfully distinct", async () => {
      const row = ep.rows[0];
      assert.notEqual(row.occurred_at, null);
      assert.notEqual(row.ingested_at, null);
      const occurredMs = new Date(row.occurred_at).getTime();
      const ingestedMs = new Date(row.ingested_at).getTime();
      assert.ok(ingestedMs - occurredMs > 1000 * 60 * 60 * 24, "ingested_at should be days after occurred_at in this fixture");
    });

    await t.test("the redacted evidence span carries its placeholder and reason, and the sensitive text appears nowhere in the row", async () => {
      const { rows } = await client.query(
        "select quote, redaction_reason from brain_dev.evidence where episode_id = $1 and redaction_reason is not null",
        [episodeId],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].quote, "[REDACTED:ssn_pattern]");
      assert.equal(rows[0].redaction_reason, "ssn_pattern");
      assert.ok(!rows[0].quote.includes(SENSITIVE_TEXT));
    });

    await t.test("a sender-deleted evidence span still exists, quote unchanged, with the flag set", async () => {
      const marked = await client.query(
        "update brain_dev.evidence set sender_deleted_at = now() where id = $1 and sender_deleted_at is null returning id, quote, sender_deleted_at",
        [evTwo.rows[0].id],
      );
      assert.equal(marked.rowCount, 1);
      assert.equal(marked.rows[0].quote, REAL_QUOTE_TWO);
      assert.notEqual(marked.rows[0].sender_deleted_at, null);
    });

    await t.test("source exclusions round-trip intact (storage only -- enforcement is a Phase 2 concern)", async () => {
      const { rows } = await client.query("select exclusions from brain_dev.sources where id = $1", [sourceId]);
      assert.deepEqual(rows[0].exclusions, [{ kind: "person", value: "Jane Doe", added_at: "2026-07-12T00:00:00Z" }]);
    });
  } finally {
    await client.query("rollback");
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
