// Fills null embedding columns on evidence and nodes from the local model.
// Embeddings are DERIVED data, so this sweep is deliberately the only writer
// and deliberately dumb: select null rows, embed, fill -- re-runnable
// forever, safe to kill anytime, and unable to rewrite anything (the
// "embedding is null" guard means a filled row can never be touched again).
// Writes stay OUT of brain.mjs's verbs and the ingest pipeline on purpose:
// the capture path stays lean and model-free, and this catches up after.
// BRAIN_SCHEMA=brain_dev targets the sandbox. --limit N caps rows per table.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { schemaTables } from "./brain.mjs";
import { embedDocuments } from "./lib/embeddings.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// One extractor pass per BATCH texts; a page is one DB fetch of null rows.
const BATCH = 16;
const PAGE = 256;

function vectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

// A node embeds as its whole meaning: title plus both layers. body falls
// back to raw at write time, so skip it when identical to avoid embedding
// the same words twice.
function nodeText(row) {
  const body = row.body !== row.raw ? row.body : "";
  return [row.title, row.raw, body].filter(Boolean).join("\n");
}

async function sweepTable(client, { label, selectSql, updateSql, toText, limit }) {
  let filled = 0;
  for (;;) {
    const remaining = limit === null ? PAGE : Math.min(PAGE, limit - filled);
    if (remaining <= 0) break;
    const { rows } = await client.query(selectSql, [remaining]);
    if (rows.length === 0) break;

    // Length-sorted batches waste less padding inside the model.
    rows.sort((a, b) => toText(a).length - toText(b).length);
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const vectors = await embedDocuments(batch.map(toText));
      await client.query("begin");
      try {
        for (let j = 0; j < batch.length; j++) {
          // The null guard also makes concurrent sweeps safe: whoever
          // lands second becomes a no-op instead of an overwrite.
          const res = await client.query(updateSql, [vectorLiteral(vectors[j]), batch[j].id]);
          filled += res.rowCount;
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
    console.log(`  ${label}: ${filled} filled so far`);
  }
  return filled;
}

async function main() {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit needs a positive integer");
  }

  const schema = process.env.BRAIN_SCHEMA || "public";
  const tables = schemaTables(schema);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const started = Date.now();
  try {
    // Newest first: fresh evidence becomes findable soonest while a long
    // backfill sweep catches up on history behind it.
    const evidenceFilled = await sweepTable(client, {
      label: "evidence",
      selectSql: `select id, quote from ${tables.evidence} where embedding is null order by ingested_at desc limit $1`,
      updateSql: `update ${tables.evidence} set embedding = $1 where id = $2 and embedding is null`,
      toText: (r) => r.quote,
      limit,
    });
    const nodesFilled = await sweepTable(client, {
      label: "nodes",
      selectSql: `select id, title, raw, body from ${tables.nodes} where embedding is null order by created_at desc limit $1`,
      updateSql: `update ${tables.nodes} set embedding = $1 where id = $2 and embedding is null`,
      toText: nodeText,
      limit,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      [
        `embed-sweep summary (${schema})`,
        `  evidence filled ${evidenceFilled}`,
        `  nodes    filled ${nodesFilled}`,
        `  wall     ${seconds}s`,
      ].join("\n"),
    );
  } finally {
    await client.end();
  }
}

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

// Only sweep when run directly; importing for tests must not.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
