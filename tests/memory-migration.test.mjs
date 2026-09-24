import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const exec = promisify(execFile);
function migrate(databaseUrl, schema, args = []) {
  return exec(process.execPath, ["scripts/memory-migrate.mjs", ...args], {
    timeout: 20000,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_DEV: databaseUrl, BRAIN_SCHEMA: schema },
  });
}

test("receipt migration adds sandbox storage without rewriting existing memories", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await db.client.query("drop table brain_dev.memory_write_receipts");
  const original = (await db.client.query("insert into brain_dev.nodes(type,title,body,raw) values('note','Migration fixture','Original body','  original raw  ') returning *")).rows[0];
  const result = await migrate(db.url, "brain_dev");
  assert.deepEqual(JSON.parse(result.stdout), { state: "migrated", schema: "brain_dev" });
  await migrate(db.url, "brain_dev");
  assert.deepEqual((await db.client.query("select * from brain_dev.nodes where id=$1", [original.id])).rows[0], original);
  assert.equal((await db.client.query("select count(*)::int n from brain_dev.memory_write_receipts")).rows[0].n, 0);
  assert.equal((await db.client.query("select to_regclass('public.memory_write_receipts') name")).rows[0].name, null);
});

test("receipt migration refuses production without the deployment flag", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await assert.rejects(migrate(db.url, "public"), error => {
    assert.match(error.stderr, /--authorize-production/);
    return true;
  });
  assert.equal((await db.client.query("select to_regclass('public.memory_write_receipts') name")).rows[0].name, null);
});

test("failed sandbox rehearsal leaves production untouched and hides database details", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await db.client.query("drop table brain_dev.memory_write_receipts");
  await db.client.query("create view brain_dev.memory_write_receipts as select 'private diagnostic fixture' as secret");
  await assert.rejects(migrate(db.url, "public", ["--authorize-production"]), error => {
    assert.match(error.stderr, /Memory receipt migration failed/);
    assert.doesNotMatch(error.stderr, /private diagnostic fixture|postgresql:|CREATE TRIGGER|create trigger/);
    return true;
  });
  assert.equal((await db.client.query("select to_regclass('public.memory_write_receipts') name")).rows[0].name, null);
});
