import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const exec = promisify(execFile);
const migrate = (url, schema, args = []) => exec(process.execPath, ["scripts/recall-migrate.mjs", ...args], {
  env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DEV: url, BRAIN_SCHEMA: schema }, timeout: 20000,
});

test("title lookup migration preserves existing nodes and indexes long titles", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await db.client.query("drop index if exists brain_dev.nodes_title_lookup_idx");
  const title = "a long title ".repeat(500);
  const original = (await db.client.query("insert into brain_dev.nodes(type,title,raw,body) values('note',$1,'  original raw  ','Original body') returning *", [title])).rows[0];
  assert.deepEqual(JSON.parse((await migrate(db.url, "brain_dev")).stdout), { state: "migrated", schema: "brain_dev" });
  await migrate(db.url, "brain_dev");
  assert.deepEqual((await db.client.query("select * from brain_dev.nodes where id=$1", [original.id])).rows[0], original);
  await db.client.query("set enable_seqscan=off");
  const plan = await db.client.query("explain (format json) select id from brain_dev.nodes where md5(lower(title))=md5(lower($1)) and lower(title)=lower($1)", [title]);
  assert.match(JSON.stringify(plan.rows), /nodes_title_lookup_idx/);
  await assert.rejects(migrate(db.url, "public"), error => /--authorize-production/.test(error.stderr));
  assert.equal((await db.client.query("select to_regclass('public.nodes_title_lookup_idx') name")).rows[0].name, null);
});


test("a missing sandbox node table cannot redirect index rehearsal into production", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await db.client.query("alter table brain_dev.nodes rename to renamed_nodes");
  await db.client.query("create table public.nodes(title text not null)");
  await assert.rejects(migrate(db.url, "public", ["--authorize-production"]), error => /Recall index migration failed/.test(error.stderr));
  assert.equal((await db.client.query("select to_regclass('public.nodes_title_lookup_idx') name")).rows[0].name, null);
});
