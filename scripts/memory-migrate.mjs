import { readFileSync } from "node:fs";
import { makeClient } from "./brain.mjs";
import { loadEnvLocal } from "./recall.mjs";

loadEnvLocal();
const schema = process.env.BRAIN_SCHEMA || "brain_dev";
if (!["public", "brain_dev"].includes(schema)) {
  console.error("Use public or brain_dev for the memory receipt migration.");
  process.exit(1);
}
if (schema === "public" && !process.argv.includes("--authorize-production")) {
  console.error("Production migration requires --authorize-production.");
  process.exit(1);
}

const client = makeClient();
try {
  await client.connect();
  const sql = readFileSync(new URL("./memory-schema.sql", import.meta.url), "utf8");
  await client.query("create schema if not exists brain_dev");
  // Rehearse only the new table, without rerunning historical node backfills.
  for (const target of schema === "public" ? ["brain_dev", "public"] : ["brain_dev"]) {
    await client.query("begin");
    try {
      await client.query(`set local search_path to ${target}, public`);
      await client.query(sql);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  console.log(JSON.stringify({ state: "migrated", schema }));
} catch {
  console.error("Memory receipt migration failed. Check database access and schema prerequisites.");
  process.exitCode = 1;
} finally {
  await client.end();
}
