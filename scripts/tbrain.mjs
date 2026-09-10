// Portable file entry point. All capture writes still pass through brain.mjs.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareTransfer, MAX_TRANSFER_BYTES, digest } from "./lib/tbrain-transfer.mjs";
import { runJson } from "./lib/run-json.mjs";
import { makeClient } from "./brain.mjs";
import { loadEnvLocal } from "./recall.mjs";
import { archiveError, errorCode, readArchive, readReceipt, searchArchive, archiveStatus } from "./lib/tbrain-store.mjs";

async function main() {
  const [command, value, ...flags]=process.argv.slice(2);
  loadEnvLocal();
  if (["validate","import"].includes(command)) {
    if (!value) throw archiveError("invalid");
    let input;
    try {
      if (statSync(value).size>MAX_TRANSFER_BYTES) throw new Error();
      input=JSON.parse(readFileSync(value,"utf8"));
    } catch { throw archiveError("invalid"); }
    let prepared;
    try { prepared=prepareTransfer(input); } catch { throw archiveError("invalid"); }
    if(command==="validate") return {state:"prepared",saved:false,digest:prepared.digest,stored_digest:prepared.stored_digest,redactions:prepared.redactions};
    if(!flags.includes("--authorize")) throw archiveError("unauthorized");
    const result=await runJson(fileURLToPath(new URL("./brain.mjs",import.meta.url)),["import-transfer","--authorize","--json-errors"],input);
    if(result.error) throw archiveError(result.error.code);
    return result;
  }
  const schema=process.env.BRAIN_SCHEMA||"public";
  const client=makeClient();
  await client.connect();
  try {
    if(command==="status") return await archiveStatus(client,schema);
    if(command==="read") return await readArchive(client,schema,{id:value,offset:Number(flags[0]??0),limit:Number(flags[1]??10)});
    if(command==="receipt") return await readReceipt(client,schema,value);
    if(command==="search") return await searchArchive(client,schema,{query:value});
    if(command==="export" || command==="verify") {
      const receipt=await readReceipt(client,schema,value);
      const row=(await client.query(`select bundle from "${schema}".archive_records where id=$1`,[value])).rows[0];
      if(digest(row.bundle)!==receipt.stored_digest) throw archiveError("conflict");
      if(command==="export") return row.bundle;
      const source=await readArchive(client,schema,{id:value,limit:1});
      const evidence=await client.query(`select quote from "${schema}".evidence where id=any($1::uuid[]) order by start_offset`,[receipt.evidence_ids]);
      if(evidence.rows.length!==row.bundle.messages.length || evidence.rows.some((r,i)=>r.quote!==row.bundle.messages[i].text)) throw archiveError("conflict");
      return {state:"verified",receipt,source:{id:source.id,coverage:source.coverage,total_messages:source.total_messages}};
    }
    throw archiveError("invalid");
  } finally {await client.end();}
}

main().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{
  console.error(JSON.stringify({state:"failed",error:{code:errorCode(error)}}));process.exitCode=1;
});
