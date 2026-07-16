// Integration tests for the Phase 3 retrieval columns (embeddings +
// full-text) on evidence and nodes. Same discipline as
// evidence-schema.test.mjs: brain_dev only, every test wrapped in a
// transaction that always rolls back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

function vectorLiteral(dim, fill = 0.1) {
  return `[${Array.from({ length: dim }, () => fill).join(",")}]`;
}

test("retrieval schema: embedding and full-text columns", async (t) => {
  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await t.test("evidence and nodes carry a nullable vector(768) embedding column", async () => {
      const { rows } = await client.query(
        `select c.relname as tbl, a.attnotnull, format_type(a.atttypid, a.atttypmod) as coltype
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'brain_dev' and c.relname in ('evidence', 'nodes')
           and a.attname = 'embedding' and not a.attisdropped`,
      );
      assert.equal(rows.length, 2, "run npm run db:migrate to add the embedding columns");
      for (const r of rows) {
        assert.equal(r.coltype, "vector(768)", `${r.tbl}.embedding must be vector(768)`);
        assert.equal(r.attnotnull, false, `${r.tbl}.embedding must be nullable (derived data fills later)`);
      }
    });

    await t.test("evidence and nodes carry a stored generated tsvector column", async () => {
      const { rows } = await client.query(
        `select c.relname as tbl, a.attgenerated, format_type(a.atttypid, a.atttypmod) as coltype
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'brain_dev' and c.relname in ('evidence', 'nodes')
           and a.attname = 'fts' and not a.attisdropped`,
      );
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.equal(r.coltype, "tsvector");
        assert.equal(r.attgenerated, "s", `${r.tbl}.fts must be a stored generated column`);
      }
    });

    await t.test("GIN indexes exist on fts; HNSW cosine indexes exist on embedding", async () => {
      const { rows } = await client.query(
        `select tablename, indexname, indexdef from pg_indexes
         where schemaname = 'brain_dev' and tablename in ('evidence', 'nodes')`,
      );
      const defs = rows.map((r) => r.indexdef.toLowerCase());
      for (const tbl of ["evidence", "nodes"]) {
        assert.ok(
          defs.some((d) => d.includes(`brain_dev.${tbl}`) && d.includes("using gin") && d.includes("fts")),
          `${tbl} needs a GIN index on fts`,
        );
        assert.ok(
          defs.some(
            (d) => d.includes(`brain_dev.${tbl}`) && d.includes("using hnsw") && d.includes("vector_cosine_ops"),
          ),
          `${tbl} needs an HNSW cosine index on embedding`,
        );
      }
    });

    await t.test("evidence fts is generated from quote and matches to_tsvector", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "the sky over safford arizona was clear");
        const { rows } = await client.query(
          `insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset)
           values ($1, 'the sky over safford arizona was clear', 0, 39)
           returning embedding, fts = to_tsvector('english', quote) as fts_matches,
                     fts @@ websearch_to_tsquery('english', 'arizona') as finds_arizona`,
          [ep],
        );
        assert.equal(rows[0].embedding, null, "a fresh row has no embedding until the sweep");
        assert.equal(rows[0].fts_matches, true);
        assert.equal(rows[0].finds_arizona, true);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("nodes fts weights title over raw over body and matches its expression", async () => {
      await client.query("begin");
      try {
        const { rows } = await client.query(
          `insert into brain_dev.nodes (type, title, raw, body)
           values ('moment', 'yosemite trip', 'i felt the mountain silence', 'a readable line')
           returning embedding,
             fts = (setweight(to_tsvector('english', title), 'A')
                 || setweight(to_tsvector('english', raw), 'B')
                 || setweight(to_tsvector('english', body), 'C')) as fts_matches,
             fts @@ websearch_to_tsquery('english', 'mountain silence') as finds_raw_text`,
        );
        assert.equal(rows[0].embedding, null);
        assert.equal(rows[0].fts_matches, true);
        assert.equal(rows[0].finds_raw_text, true);
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("a 768-dim embedding writes and reads back; wrong dimension is rejected", async () => {
      await client.query("begin");
      try {
        const ep = await insertEpisode(client, "hello world");
        const ev = await client.query(
          "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset) values ($1, 'hello', 0, 5) returning id",
          [ep],
        );
        await client.query("update brain_dev.evidence set embedding = $1::vector where id = $2 and embedding is null", [
          vectorLiteral(768),
          ev.rows[0].id,
        ]);
        const back = await client.query("select vector_dims(embedding) as dims from brain_dev.evidence where id = $1", [
          ev.rows[0].id,
        ]);
        assert.equal(back.rows[0].dims, 768);
        await client.query("savepoint sp");
        await assert.rejects(
          client.query("update brain_dev.evidence set embedding = $1::vector where id = $2", [
            vectorLiteral(8),
            ev.rows[0].id,
          ]),
          /768 dimensions/,
        );
        await client.query("rollback to savepoint sp");
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("a giant span cannot break the generated column (tsvector 1MB cap)", async () => {
      await client.query("begin");
      try {
        // 400k chars of unique-ish words: uncapped to_tsvector output could
        // exceed the 1MB tsvector limit; the left() cap must absorb it.
        const giant = Array.from({ length: 40000 }, (_, i) => `w${i}x${i % 97}`).join(" ").slice(0, 400000);
        const ep = await insertEpisode(client, giant);
        const { rows } = await client.query(
          `insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset)
           values ($1, $2, 0, $3) returning fts is not null as has_fts`,
          [ep, giant, giant.length],
        );
        assert.equal(rows[0].has_fts, true);
      } finally {
        await client.query("rollback");
      }
    });
  } finally {
    await client.end();
  }

  async function insertEpisode(client, raw) {
    const src = await client.query(
      "insert into brain_dev.sources (kind, label) values ('x', gen_random_uuid()::text) returning id",
    );
    const ep = await client.query("insert into brain_dev.episodes (source_id, raw) values ($1, $2) returning id", [
      src.rows[0].id,
      raw,
    ]);
    return ep.rows[0].id;
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
