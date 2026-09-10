// Custom archives include every table in the selected schema, including future ones.
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const connectionParameters = new Map([
  ["sslmode", "PGSSLMODE"], ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcert", "PGSSLCERT"], ["sslkey", "PGSSLKEY"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
]);
const driverHints = new Set(["pgbouncer", "uselibpqcompat"]);

export function connectionEnvironment(databaseUrl, inherited = process.env) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error("A PostgreSQL URL is required."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash) {
    throw new Error("A PostgreSQL URL with host and database is required.");
  }
  // Ambient libpq settings must not redirect a checked target or choose a service.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("PG") && !key.includes("DATABASE_URL")));
  Object.assign(env, {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: "15",
  });
  for (const [key, value] of url.searchParams) {
    if (driverHints.has(key)) {
      if (value !== "true" && value !== "false") throw new Error(`invalid driver hint: ${key}`);
      continue;
    }
    const target = connectionParameters.get(key);
    if (!target) throw new Error(`unsupported connection parameter: ${key}`);
    env[target] = value;
  }
  return env;
}

export function validateRestoreTarget(databaseUrl) {
  const env = connectionEnvironment(databaseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(env.PGHOST) || !/^tbrain_restore_[a-z0-9_]+$/.test(env.PGDATABASE)) {
    throw new Error("Restore requires a loopback host and an isolated tbrain_restore_* database.");
  }
  return env;
}

async function runTool(program, args, { env, stdout = "ignore" } = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", stdout, "ignore"] });
    // Database diagnostics can contain private source text, so never echo them.
    child.once("error", () => reject(new Error(`${program} could not start. Check the installed PostgreSQL tools.`)));
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${program} failed with exit code ${code}. No successful operation is claimed.`)));
  });
}

export async function backupDatabase({ databaseUrl, output, schema = "public", repositoryRoot: repo = repositoryRoot, run = runTool }) {
  if (!["public", "brain_dev"].includes(schema)) throw new Error("BRAIN_SCHEMA must be public or brain_dev.");
  if (!output) throw new Error("An output path is required.");
  const env = connectionEnvironment(databaseUrl);
  const destination = resolve(await realpath(dirname(resolve(output))), basename(resolve(output)));
  const relativePath = relative(await realpath(repo), destination);
  if (!relativePath || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) {
    throw new Error("Store private backups outside the repository.");
  }
  const file = await open(destination, "wx", 0o600);
  try {
    await run("pg_dump", ["--format=custom", `--schema=${schema}`, "--extension=*", "--strict-names", "--no-password"], { env, stdout: file.fd });
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(destination);
    throw error;
  }
  await file.close();
  return { status: "backed_up", schema, path: destination, private: true };
}

export async function restoreDatabase({ databaseUrl, input }) {
  const env = validateRestoreTarget(databaseUrl);
  if (!input || !(await stat(input)).isFile()) throw new Error("A regular backup file is required.");
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  let publicExists;
  try {
    const { rows } = await client.query(`select
      (select count(*) from pg_namespace where nspname !~ '^pg_' and nspname not in ('public', 'information_schema')) +
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public') +
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') +
      (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public') +
      (select count(*) from pg_extension where extname != 'plpgsql') as objects,
      exists(select 1 from pg_namespace where nspname = 'public') as public_exists`);
    publicExists = rows[0].public_exists;
    if (Number(rows[0].objects) !== 0) throw new Error("Restore requires an empty database with no user objects or extensions.");
  } finally { await client.end(); }
  const temporary = await mkdtemp(join(tmpdir(), "tbrain-restore-"));
  try {
    const listPath = join(temporary, "archive.list");
    const list = await open(listPath, "wx", 0o600);
    try { await runTool("pg_restore", ["--list", resolve(input)], { env, stdout: list.fd }); }
    finally { await list.close(); }
    if (publicExists) {
      // Fresh databases already have public; omit only its CREATE, never drop it.
      const entries = (await readFile(listPath, "utf8")).split("\n")
        .filter((line) => !/^\d+; \d+ \d+ SCHEMA - public(?: |$)/.test(line));
      await writeFile(listPath, entries.join("\n"), { mode: 0o600 });
    }
    // An empty dbname uses PGDATABASE without putting connection data in argv.
    await runTool("pg_restore", ["--dbname=", "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", "--no-password", `--use-list=${listPath}`, resolve(input)], { env });
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { status: "restored", database: env.PGDATABASE, host: env.PGHOST };
}

async function main() {
  try {
    const local = readFileSync(resolve(repositoryRoot, ".env.local"), "utf8");
    for (const line of local.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch { /* The shell environment can supply the entire connection. */ }
  const [command, flag, path, ...extra] = process.argv.slice(2);
  if (extra.length || !path || (command !== "backup" && command !== "restore") || flag !== (command === "backup" ? "--output" : "--input")) {
    throw new Error("Usage: node scripts/tbrain-backup.mjs backup --output /private/path.dump | restore --input /private/path.dump");
  }
  const result = command === "backup"
    ? await backupDatabase({ databaseUrl: process.env.DATABASE_URL, output: path, schema: process.env.BRAIN_SCHEMA })
    : await restoreDatabase({ databaseUrl: process.env.TBRAIN_RESTORE_DATABASE_URL, input: path });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Connection and SQL errors may echo credentials or source rows.
    process.stderr.write("Backup or restore failed. Check the command, private output path, database permissions, and PostgreSQL tools. Restore requires an empty loopback tbrain_restore_* database.\n");
    process.exitCode = 1;
  });
}
