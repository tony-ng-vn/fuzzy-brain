// Fills null embedding columns on evidence and nodes from the local model.
// Embeddings are DERIVED data, so this sweep is deliberately the only writer
// and deliberately dumb: select null rows, embed, fill -- re-runnable
// forever, safe to kill anytime, and unable to rewrite anything (the
// "embedding is null" guard means a filled row can never be touched again).
// Writes stay OUT of brain.mjs's verbs and the ingest pipeline on purpose:
// the capture path stays lean and model-free, and this catches up after.
// BRAIN_SCHEMA=brain_dev targets the sandbox. --limit N caps the combined rows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os, { tmpdir } from "node:os";
import { schemaTables, makeClient } from "./brain.mjs";
import { disposeEmbeddingModel, embedDocuments } from "./lib/embeddings.mjs";
import { acquireProcessLock } from "./lib/process-lock.mjs";
import { parseIndexScope, resolveIndexScope } from "./lib/index-status.mjs";
import { runTracedCli, recordTraceInput } from "./lib/operation-cli.mjs";

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

function validLimit(limit) {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw Object.assign(new Error("--limit needs a positive integer"), { code: "invalid" });
  }
  return limit;
}

export function parseSweepArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--limit", "--source-id", "--receipt-id"].includes(key) || key in values || !value || value.startsWith("--")) {
      throw Object.assign(new Error("Invalid index repair arguments."), { code: "invalid" });
    }
    values[key] = value;
  }
  const scope = parseIndexScope({
    ...(values["--source-id"] ? { source_id: values["--source-id"] } : {}),
    ...(values["--receipt-id"] ? { receipt_id: values["--receipt-id"] } : {}),
  });
  return { scope, limit: validLimit(values["--limit"] === undefined ? null : Number(values["--limit"])) };
}

export async function runEmbeddingSweep(client, { schema = "public", scope = {}, limit = null, embed = embedDocuments } = {}) {
  validLimit(limit);
  const resolved = await resolveIndexScope(client, schema, scope);
  const tables = schemaTables(schema);
  const selected = Boolean(resolved.scope.source_id || resolved.scope.receipt_id);
  const filter = resolved.episodeId ? " and v.episode_id=$2" : resolved.scope.source_id ? " and e.source_id=$2" : "";
  const nodeOptions = {
    label: "nodes",
    selectSql: `select id, title, raw, body from ${tables.nodes} where embedding is null order by created_at desc,id limit $1`,
    updateSql: `update ${tables.nodes} t set embedding = v.vec::vector from (select unnest($1::uuid[]) as id, unnest($2::text[]) as vec) v where t.id = v.id and t.embedding is null`,
    toText: nodeText, embed,
  };
  // A large archive must not consume every slot before saved thoughts get a turn.
  const nodeShare = limit === null ? null : Math.ceil(limit / 2);
  let nodes = selected ? 0 : await sweepTable(client, { ...nodeOptions, limit: nodeShare });
  const evidence = await sweepTable(client, {
    label: "evidence",
    selectSql: `select v.id, v.quote from ${tables.evidence} v join ${tables.episodes} e on e.id=v.episode_id
      where v.embedding is null${filter} order by v.ingested_at desc,v.id limit $1`,
    updateSql: `update ${tables.evidence} t set embedding = v.vec::vector from (select unnest($1::uuid[]) as id, unnest($2::text[]) as vec) v where t.id = v.id and t.embedding is null`,
    selectValues: selected ? [resolved.episodeId ?? resolved.scope.source_id] : [],
    toText: row => row.quote, limit: remainingLimit(limit, nodes), embed,
  });
  const unused = remainingLimit(limit, evidence + nodes);
  if (!selected && limit !== null && nodes === nodeShare && unused > 0) {
    nodes += await sweepTable(client, { ...nodeOptions, limit: unused });
  }
  return { evidence, nodes };
}

export async function sweepTable(client, { label, selectSql, selectValues = [], updateSql, toText, limit, embed = embedDocuments }) {
  let filled = 0;
  let stalledPages = 0;
  for (;;) {
    const remaining = limit === null ? EMBED_PAGE_SIZE : Math.min(EMBED_PAGE_SIZE, limit - filled);
    if (remaining <= 0) break;
    const { rows } = await client.query(selectSql, [remaining, ...selectValues]);
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
  const { scope, limit } = parseSweepArgs(process.argv.slice(2));
  await recordTraceInput({ ...scope, limit });

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
  const releaseSweepLock = acquireSweepLock();
  const client = makeClient();
  const started = Date.now();
  try {
    await client.connect();
    const filled = await runEmbeddingSweep(client, { schema, scope, limit });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      [
        `embed-sweep summary (${schema})`,
        `  evidence filled ${filled.evidence}`,
        `  nodes    filled ${filled.nodes}`,
        `  wall     ${seconds}s`,
      ].join("\n"),
    );
    return { indexed_evidence: filled.evidence, indexed_nodes: filled.nodes };
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
  loadEnvLocal();
  runTracedCli("index_cli", "index_repair", process.argv.slice(2), main).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
