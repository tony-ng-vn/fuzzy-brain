// The capture migration is additive and separate from historical data backfills.
import { readFileSync } from "node:fs";
import { makeClient, schemaTables } from "./brain.mjs";
import { loadEnvLocal } from "./recall.mjs";

loadEnvLocal();
const schema=process.env.BRAIN_SCHEMA||"brain_dev";
schemaTables(schema);
if(!["public","brain_dev"].includes(schema)) throw new Error("Use public or brain_dev for the capture migration.");
if(schema==="public" && !process.argv.includes("--authorize-production")) throw new Error("Production migration requires explicit approval and --authorize-production.");
const client=makeClient();
try {
  await client.connect();
  const sql=readFileSync(new URL("./tbrain-schema.sql",import.meta.url),"utf8");
  for(const target of schema==="public"?["brain_dev","public"]:["brain_dev"]) {
    await client.query("begin");
    try {
      await client.query(`set local search_path to ${target}, public`);
      await client.query(sql);
      await client.query("commit");
    } catch(error) {await client.query("rollback");throw error;}
  }
  console.log(JSON.stringify({state:"migrated",schema}));
} catch {console.error("Tbrain migration failed. Check schema prerequisites and database access.");process.exitCode=1;}
finally {await client.end();}
