// Portable file entry point. All capture writes still pass through brain.mjs.
import { runTracedCli, recordTraceInput } from "./lib/operation-cli.mjs";
import { operationContext } from "./lib/operation-context.mjs";
import { indexStatus, parseIndexArgs } from "./lib/index-status.mjs";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectTransfer, MAX_TRANSFER_BYTES, digest } from "./lib/tbrain-transfer.mjs";
import { z } from "zod";
import { runJson } from "./lib/run-json.mjs";
import { makeClient, schemaTables } from "./brain.mjs";
import { loadEnvLocal } from "./recall.mjs";
import { archiveError, errorCode, readArchive, readReceipt, readSource, searchArchive, archiveStatus, readEvidence, evidenceReadShape, archiveSearchShape } from "./lib/tbrain-store.mjs";
import { portableHelp } from "./lib/tbrain-help.mjs";

function parseArgs(args) {
  const [command, value, ...rest] = args;
  if (command === "index-status") return { command, options: parseIndexArgs(args.slice(1)) };
  const commands = new Set(["validate", "import", "status", "receipt", "verify", "export", "search", "read", "source", "evidence"]);
  if (!commands.has(command) || (command !== "status" && !value) || (command === "status" && value !== undefined)) throw archiveError("invalid");
  const flagNames = {
    search: ["from", "until", "source-id", "role", "offset", "limit"],
    read: ["offset", "limit", "text-offset", "text-limit"], source: ["offset", "limit"],
    evidence: ["context", "text-offset", "text-limit"], import: ["authorize"],
  };
  const options = {};
  let position = 0;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      if (!["read", "source"].includes(command) || position > 1) throw archiveError("invalid");
      const key = ["offset", "limit"][position++];
      if (key in options) throw archiveError("invalid");
      options[key] = Number(token);
      continue;
    }
    const name = token.slice(2), key = name.replaceAll("-", "_");
    if (!(flagNames[command] ?? []).includes(name) || key in options) throw archiveError("invalid");
    if (name === "authorize") { options.authorize = true; continue; }
    const input = rest[++i];
    if (input === undefined || input.startsWith("--")) throw archiveError("invalid");
    options[key] = ["offset", "limit", "context", "text_offset", "text_limit"].includes(key) ? Number(input) : input;
  }
  if (command === "search") {
    z.object(archiveSearchShape).parse({ query: value, ...options });
    if (options.from && options.until && Date.parse(options.from) > Date.parse(options.until)) throw archiveError("invalid");
  }
  if (command === "evidence") z.object(evidenceReadShape).parse({ id: value, ...options });
  if (["read", "source", "receipt", "verify", "export"].includes(command)) z.uuid().parse(value);
  if (["read", "source"].includes(command)) {
    const maxOffset = command === "read" ? 100000 : 5000000;
    const maxLimit = command === "read" ? 20 : 12000;
    z.object({ offset: z.number().int().min(0).max(maxOffset).optional(), limit: z.number().int().min(1).max(maxLimit).optional(),
      text_offset: z.number().int().min(0).max(200000).optional(), text_limit: z.number().int().min(1).max(8000).optional() }).parse(options);
  }
  return { command, value, options };
}

async function traceCommand(args, journal) {
  const [command, ...rest] = args;
  const options = {};
  let value;
  const allowed = command === "trace" ? ["kind"] : command === "traces" ? ["day", "limit", "after", "kind", "workflow-id", "parent-id", "operation-id", "operation", "outcome", "min-duration-ms"] : command === "trace-summary" ? ["day", "limit"] : [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) {
      if (!["trace", "report-outcome"].includes(command) || value !== undefined) throw archiveError("invalid");
      value = rest[i];
    } else {
      const flag = rest[i].slice(2), key = flag.replaceAll("-", "_"), item = rest[++i];
      if (!allowed.includes(flag) || key in options || item === undefined || item.startsWith("--")) throw archiveError("invalid");
      options[key] = ["limit", "min_duration_ms"].includes(key) ? Number(item) : item;
    }
  }
  if (command === "trace-status") return journal.status();
  if (command === "trace-summary") return journal.summary(options);
  if (command === "traces") {
    const { kind = "operations", ...page } = options;
    if (!["operations", "reports"].includes(kind)) throw archiveError("invalid");
    return kind === "reports" ? journal.listReports(page) : journal.list(page);
  }
  if (!value) throw archiveError("invalid");
  if (command === "trace") {
    if (![undefined, "operation", "report"].includes(options.kind)) throw archiveError("invalid");
    return options.kind === "report" ? journal.readReport(value) : journal.read(value);
  }
  let report;
  try {
    if (statSync(value).size > 16384) throw archiveError("invalid");
    report = JSON.parse(readFileSync(value, "utf8"));
  } catch { throw archiveError("invalid"); }
  await recordTraceInput(report);
  return journal.report(report);
}

async function main() {
  const help = portableHelp(process.argv.slice(2));
  if (help) return help;
  if (["trace-status", "trace", "traces", "trace-summary", "report-outcome"].includes(process.argv[2])) {
    return traceCommand(process.argv.slice(2), operationContext.getStore().journal);
  }
  const { command, value, options } = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  if (["validate", "import"].includes(command)) {
    let input;
    try {
      if (statSync(value).size > MAX_TRANSFER_BYTES) throw new Error();
      input = JSON.parse(readFileSync(value, "utf8"));
    } catch { throw archiveError("invalid"); }
    await recordTraceInput(input);
    const prepared = inspectTransfer(input);
    if (!prepared.valid) {
      const error = archiveError("invalid");
      error.validation = prepared;
      throw error;
    }
    if (command === "validate") return prepared;
    if (!options.authorize) throw archiveError("unauthorized");
    const result = await runJson(fileURLToPath(new URL("./brain.mjs", import.meta.url)), ["import-transfer", "--authorize", "--json-errors"], input);
    if (result.error) throw archiveError(result.error.code);
    return result;
  }
  const schema=process.env.BRAIN_SCHEMA||"public";
  schemaTables(schema);
  const client=makeClient();
  await client.connect();
  try {
    if(command==="status") return await archiveStatus(client,schema);
    if(command==="index-status") return await indexStatus(client,schema,options);
    if(command==="read") return await readArchive(client,schema,{id:value,...options});
    if(command==="receipt") return await readReceipt(client,schema,value);
    if(command==="source") return await readSource(client,schema,{id:value,...options});
    if(command==="evidence") return await readEvidence(client,schema,{id:value,...options});
    if(command==="search") return await searchArchive(client,schema,{query:value,...options});
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

loadEnvLocal();
const args = process.argv.slice(2);
const operation = !args.length || args[0] === "help" || args.some(arg => ["--help", "-h"].includes(arg)) ? "help" : args[0];
runTracedCli("tbrain_cli", operation, args, main).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{
  const code = errorCode(error);
  console.error(JSON.stringify({state:"failed",saved:false,...(error.validation??{}),error:{code,
    ...(code === "invalid" ? { help: "Run node scripts/tbrain.mjs --help, then COMMAND --help for its arguments and JSON format." } : {}),
  }}));process.exitCode=1;
});
