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
import os, { tmpdir } from "node:os";
import { schemaTables, makeClient } from "./brain.mjs";
import { disposeEmbeddingModel, embedDocuments } from "./lib/embeddings.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Inference stays single-row to bound native memory. Database reads and writes
// stay paged so the remote connection still costs one round trip per page.
export const EMBED_BATCH_SIZE = 1;
export const EMBED_PAGE_SIZE = 64;
const DEFAULT_SWEEP_LOCK_PATH = join(tmpdir(), "fuzzy-brain-embed-sweep.lock");

export function acquireSweepLock(lockPath = process.env.FUZZY_BRAIN_EMBED_LOCK || DEFAULT_SWEEP_LOCK_PATH) {
  return acquireProcessLock(lockPath, "an embedding sweep");
}

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

export function remainingLimit(limit, filled) {
  return limit === null ? null : Math.max(0, limit - filled);
}

export async function sweepTable(client, { label, selectSql, updateSql, toText, limit, embed = embedDocuments }) {
  let filled = 0;
  let stalledPages = 0;
  for (;;) {
    const remaining = limit === null ? EMBED_PAGE_SIZE : Math.min(EMBED_PAGE_SIZE, limit - filled);
    if (remaining <= 0) break;
    const { rows } = await client.query(selectSql, [remaining]);
    if (rows.length === 0) break;
    const pageStart = filled;

    // Length-sorted batches waste less padding inside the model.
    rows.sort((a, b) => toText(a).length - toText(b).length);
    const pageVectors = [];
    for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
      const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embed(batch.map(toText));
      pageVectors.push(...vectors);
    }
    // One statement per page keeps the remote database cost bounded while
    // single-row model calls keep native inference memory bounded.
    const res = await client.query(updateSql, [
      rows.map((r) => r.id),
      pageVectors.map(vectorLiteral),
    ]);
    filled += res.rowCount;
    // A page that selects rows but fills none means the null guard is
    // no-oping every update -- e.g. a concurrent sweep owns these rows.
    // Selecting the same page forever would spin without progress, so two
    // strikes and this sweep bows out; whoever is filling keeps going.
    if (filled === pageStart) {
      stalledPages++;
      if (stalledPages >= 2) {
        console.log(`  ${label}: two pages with no progress -- another sweep is filling these rows, stopping`);
        break;
      }
    } else {
      stalledPages = 0;
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

  // Lowest CPU priority, set before the model loads so the inference
  // threads inherit it: the fp32 backfill once saturated every core for
  // days and starved the whole machine. The sweep takes as long as it
  // takes either way; the machine stays usable meanwhile.
  try {
    os.setPriority(19);
  } catch {
    // not permitted on some platforms; the sweep still runs
  }

  const schema = process.env.BRAIN_SCHEMA || "public";
  const tables = schemaTables(schema);
  const releaseSweepLock = acquireSweepLock();
  const client = makeClient();
  const started = Date.now();
  try {
    await client.connect();
    // Newest first: fresh evidence becomes findable soonest while a long
    // backfill sweep catches up on history behind it.
    const evidenceFilled = await sweepTable(client, {
      label: "evidence",
      selectSql: `select id, quote from ${tables.evidence} where embedding is null order by ingested_at desc limit $1`,
      updateSql: `update ${tables.evidence} t set embedding = v.vec::vector from (select unnest($1::uuid[]) as id, unnest($2::text[]) as vec) v where t.id = v.id and t.embedding is null`,
      toText: (r) => r.quote,
      limit,
    });
    const nodesFilled = await sweepTable(client, {
      label: "nodes",
      selectSql: `select id, title, raw, body from ${tables.nodes} where embedding is null order by created_at desc limit $1`,
      updateSql: `update ${tables.nodes} t set embedding = v.vec::vector from (select unnest($1::uuid[]) as id, unnest($2::text[]) as vec) v where t.id = v.id and t.embedding is null`,
      toText: nodeText,
      limit: remainingLimit(limit, evidenceFilled),
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
    try {
      await client.end();
    } finally {
      try {
        await disposeEmbeddingModel();
      } finally {
        releaseSweepLock();
      }
    }
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
