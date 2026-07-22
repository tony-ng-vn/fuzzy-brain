// Applies scripts/schema.sql to the database in DATABASE_URL. Idempotent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeClient } from "./brain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// No query cap here: a fresh HNSW index build over the whole store is
// legitimately slow and must not be killed mid-DDL.
const client = makeClient({ connectionString, query_timeout: 0 });
await client.connect();
try {
  const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
  // Rehearse every migration on the sandbox schema first, then apply for real.
  await client.query("create schema if not exists brain_dev");
  await applySchema("brain_dev", schemaSql);
  await applySchema("public", schemaSql);
  // Keep the restricted dev role usable after new tables appear, if it exists.
  const role = await client.query("select 1 from pg_roles where rolname = 'brain_dev_role'");
  if ((role.rowCount ?? 0) > 0) {
    await client.query("grant usage on schema brain_dev to brain_dev_role");
    await client.query(
      "grant select, insert, update, delete on all tables in schema brain_dev to brain_dev_role",
    );
  }
  console.log("schema applied to brain_dev (rehearsal) and public");
} finally {
  await client.end();
}

async function applySchema(schema, schemaSql) {
  await client.query("begin");
  try {
    // SET LOCAL stays bound to this transaction even through transaction poolers.
    await client.query(`set local search_path to ${schema}, public`);
    await client.query(schemaSql);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

// Minimal .env.local loader so scripts work without extra dependencies.
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
