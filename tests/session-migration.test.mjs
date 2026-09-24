import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";

const exec = promisify(execFile);
function migrate(url, schema, args = []) {
  return exec(process.execPath, ["scripts/session-migrate.mjs", ...args], {
    timeout: 20000,
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_DEV: url, BRAIN_SCHEMA: schema },
  });
}

test("session migration is additive, replayable, and rehearses before production", async t => {
  const db = await createTbrainTestDatabase();
  t.after(() => db.close());
  await db.client.query("drop table brain_dev.session_ingest_checkpoints");
  const node = (await db.client.query("insert into brain_dev.nodes(type,title,body,raw) values('note','Migration fixture','body','original raw') returning *")).rows[0];
  assert.equal(JSON.parse((await migrate(db.url, "brain_dev")).stdout).state, "migrated");
  await migrate(db.url, "brain_dev");
  assert.deepEqual((await db.client.query("select * from brain_dev.nodes where id=$1", [node.id])).rows[0], node);
  await assert.rejects(migrate(db.url, "public"), error => /--authorize-production/.test(error.stderr));
  await db.client.query("drop table brain_dev.session_ingest_checkpoints");
  await db.client.query("create view brain_dev.session_ingest_checkpoints as select 'private test detail' as secret");
  await assert.rejects(migrate(db.url, "public", ["--authorize-production"]), error => {
    assert.match(error.stderr, /Session checkpoint migration failed/);
    assert.doesNotMatch(error.stderr, /private test detail|postgresql:|create trigger/i);
    return true;
  });
  assert.equal((await db.client.query("select to_regclass('public.session_ingest_checkpoints') name")).rows[0].name, null);
});
