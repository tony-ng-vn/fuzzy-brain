import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTbrainTestDatabase } from "./helpers/tbrain-database.mjs";
import { loadEnvLocal } from "../scripts/recall.mjs";
import { fixture } from "./helpers/tbrain-fixture.mjs";

loadEnvLocal();
test("portable transfer crosses real CLI and fresh process boundaries", async t => {
  const database=await createTbrainTestDatabase();
  t.after(() => database.close());
  const dir=mkdtempSync(join(tmpdir(),"tbrain-cli-")); const path=join(dir,"day.json");
  const sourceId=randomUUID(); const input=fixture({source_id:sourceId,source_key:randomUUID()});
  writeFileSync(path,JSON.stringify(input),{mode:0o600});
  const env={...process.env,DATABASE_URL:database.url,DATABASE_URL_DEV:database.url,BRAIN_SCHEMA:"brain_dev",TBRAIN_ALLOWED_SOURCE_IDS:sourceId};
  const run=(args,e=env)=>JSON.parse(execFileSync(process.execPath,["scripts/tbrain.mjs",...args],{env:e,encoding:"utf8",timeout:10000,stdio:["ignore","pipe","pipe"]}));
  const client=database.client;
  try {
    await client.query("insert into brain_dev.sources(id,kind,label) values($1,'tbrain_cli_test',$2)",[sourceId,sourceId]);
    await t.test("validate prepares without needing database",()=>{
      const result=run(["validate",path],{...env,DATABASE_URL:"postgresql://invalid:1/no"});
      assert.equal(result.state,"prepared"); assert.equal(result.saved,false);
    });
    await t.test("import requires explicit authorization",()=>{
      assert.throws(()=>run(["import",path]),e=>e.status!==0 && /unauthorized/.test(e.stderr.toString()));
    });
    let receipt;
    await t.test("one authorized invocation imports a day",()=>{
      receipt=run(["import",path,"--authorize"]); assert.equal(receipt.state,"committed");
    });
    await t.test("new process verifies persistence and original speaker",()=>{
      const verified=run(["verify",receipt.id]); assert.equal(verified.state,"verified");
      assert.equal(verified.receipt.id,receipt.id);
      const read=run(["read",receipt.id]); assert.equal(read.messages[0].role,"user");
    });
    await t.test("timeout-equivalent retry returns the existing receipt",()=>{
      assert.equal(run(["import",path,"--authorize"]).id,receipt.id);
    });
    await t.test("conflicting content causes nonzero safe error",()=>{
      input.messages[0].text="Private test conflict payload";writeFileSync(path,JSON.stringify(input));
      assert.throws(()=>run(["import",path,"--authorize"]),e=>e.status!==0 && /conflict/.test(e.stderr.toString()) && !e.stderr.toString().includes(input.messages[0].text));
    });
    await t.test("database outage is not reported as no matches",()=>{
      assert.throws(()=>run(["search","pottery"],{...env,DATABASE_URL:"postgresql://127.0.0.1:1/no"}),e=>e.status!==0 && /unavailable/.test(e.stderr.toString()));
    });
  } finally {await database.close();rmSync(dir,{recursive:true,force:true});}
});
