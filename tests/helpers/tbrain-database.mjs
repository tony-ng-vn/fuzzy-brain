import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { makeClient } from "../../scripts/brain.mjs";
import { connectionEnvironment } from "../../scripts/tbrain-backup.mjs";

export async function createTbrainTestDatabase(databaseUrl = process.env.DATABASE_URL_DEV) {
  const settings = connectionEnvironment(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(settings.PGHOST)) {
    throw new Error("Tbrain integration tests require an explicit loopback DATABASE_URL_DEV.");
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const name = `tbrain_test_${randomUUID().replaceAll("-", "")}`;
  if (!/^tbrain_test_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid disposable database name.");
  const isolatedUrl = new URL(adminUrl);
  isolatedUrl.pathname = `/${name}`;
  const admin = makeClient({ connectionString: adminUrl.href });
  const client = makeClient({ connectionString: isolatedUrl.href });
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.end();
      // Callers close their server processes first; never force-kill unknown clients.
      if (created) await admin.query(`drop database "${name}"`);
    } finally { await admin.end(); }
  };
  try {
    await admin.connect();
    await admin.query(`create database "${name}" template template0`);
    created = true;
    await client.connect();
    await client.query("create schema brain_dev");
    for (const script of ["schema.sql", "tbrain-schema.sql"]) {
      const sql = await readFile(new URL(`../../scripts/${script}`, import.meta.url), "utf8");
      await client.query("begin");
      try {
        await client.query("set local search_path to brain_dev, public");
        await client.query(sql);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    return { url: isolatedUrl.href, client, close };
  } catch (error) {
    await close();
    throw error;
  }
}
