import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, connectionEnvironment, validateRestoreTarget } from "../scripts/tbrain-backup.mjs";

const local = "postgresql://tester:secret@127.0.0.1:55439/tbrain_restore_example";

test("backup connection settings reject URL overrides and keep credentials in environment", () => {
  const env = connectionEnvironment(local, { PATH: "/bin", PGHOST: "other", PGSERVICE: "production", DATABASE_URL: "private" });
  assert.equal(env.PGHOST, "127.0.0.1");
  assert.equal(env.PGPORT, "55439");
  assert.equal(env.PGPASSWORD, "secret");
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.throws(() => connectionEnvironment(`${local}?host=remote.example`), /unsupported connection parameter/);
  assert.throws(() => connectionEnvironment("not a URL"), /PostgreSQL URL/);
});

test("restore accepts only explicit loopback test databases", () => {
  validateRestoreTarget(local);
  for (const url of [undefined, "postgresql://u@remote.example/tbrain_restore_example", "postgresql://u@localhost/brain", `${local}?host=remote.example`]) {
    assert.throws(() => validateRestoreTarget(url));
  }
});

test("backup selects the whole named schema and extensions into a private exclusive file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tbrain-backup-unit-"));
  const output = join(dir, "brain.dump");
  let call;
  const result = await backupDatabase({ databaseUrl: local, output, schema: "brain_dev", run: async (...args) => { call = args; } });
  assert.equal(result.status, "backed_up");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(call[0], "pg_dump");
  assert.ok(call[1].includes("--schema=brain_dev"));
  assert.ok(call[1].includes("--extension=*"));
  assert.ok(call[1].includes("--format=custom"));
  assert.ok(!call[1].join(" ").includes("secret"));
  assert.ok(!call[1].some((arg) => arg.startsWith("--exclude")));
  await assert.rejects(backupDatabase({ databaseUrl: local, output }), /exist/i);
});

test("backup rejects repository paths and symlink paths into the repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tbrain-backup-path-"));
  const repo = join(dir, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
  await symlink(repo, join(dir, "alias"));
  for (const output of [join(repo, "brain.dump"), join(dir, "alias", "brain.dump")]) {
    await assert.rejects(backupDatabase({ databaseUrl: local, output, repositoryRoot: repo }), /outside the repository/);
  }
});

test("failed backup removes partial output and hides tool diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tbrain-backup-failure-"));
  const output = join(dir, "brain.dump");
  await assert.rejects(backupDatabase({ databaseUrl: local, output, run: async () => { await writeFile(output, "partial secret source"); throw new Error("tool failed"); } }), /tool failed/);
  await assert.rejects(readFile(output), /ENOENT/);
});

test("private custom backup restores exact text and extension types into an empty local database", {
  skip: !process.env.TBRAIN_BACKUP_TEST_SOURCE_URL || !process.env.TBRAIN_BACKUP_TEST_TARGET_URL,
}, async () => {
  const sourceUrl = process.env.TBRAIN_BACKUP_TEST_SOURCE_URL;
  const targetUrl = process.env.TBRAIN_BACKUP_TEST_TARGET_URL;
  validateRestoreTarget(sourceUrl);
  validateRestoreTarget(targetUrl);
  assert.notEqual(sourceUrl, targetUrl);
  const { default: pg } = await import("pg");
  const { restoreDatabase } = await import("../scripts/tbrain-backup.mjs");
  const source = new pg.Client({ connectionString: sourceUrl });
  const target = new pg.Client({ connectionString: targetUrl });
  const raw = "  exact first line\nsecond line with 'quotes'\n";
  const dir = await mkdtemp(join(tmpdir(), "tbrain-backup-roundtrip-"));
  await source.connect();
  await target.connect();
  try {
    await source.query("create extension vector; create extension pg_trgm; create table public.backup_future_table (raw text, embedding vector(3))");
    await source.query("insert into public.backup_future_table values ($1, '[1,2,3]')", [raw]);
    const output = join(dir, "full.dump");
    await backupDatabase({ databaseUrl: sourceUrl, output });
    await restoreDatabase({ databaseUrl: targetUrl, input: output });
    const { rows } = await target.query("select raw, embedding::text from public.backup_future_table");
    assert.deepEqual(rows, [{ raw, embedding: "[1,2,3]" }]);
    await assert.rejects(restoreDatabase({ databaseUrl: targetUrl, input: output }), /empty database/);
  } finally {
    await source.end();
    await target.end();
  }
});
