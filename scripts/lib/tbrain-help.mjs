import { z } from "zod";
import { transferSchema } from "./tbrain-transfer.mjs";
import { outcomeReportSchema } from "./operation-feedback.mjs";
import { archiveSearchShape, evidenceReadShape } from "./tbrain-store.mjs";

const commands = {
  "index-status": {
    usage: "index-status [--source-id UUID | --receipt-id UUID]",
    note: "Inspect stored and missing search vectors. Choose either one source or one archive receipt, or omit both for evidence and approved nodes. A complete index does not guarantee a useful answer.",
  },
  "trace-status": {
    usage: "trace-status",
    note: "Inspect this process's private operation journal and recording counters. Other processes have their own counters. This command does not need the memory database.",
  },
  trace: {
    usage: "trace ID [--kind operation|report]",
    note: "Read a returned trace identifier. The default kind is operation. Use report for caller feedback. A missing finish means unknown or still running, not a failed save.",
  },
  traces: {
    usage: "traces [--day DATE] [--limit N] [--after ID] [--kind operations|reports] [--workflow-id UUID] [--parent-id ID] [--operation-id ID]",
    note: "List records for a UTC day, default today. The limit defaults to 20 and accepts 1 through 100 inspected records before filtering. Follow next_after even on an empty page. Results use identifier order. Workflow filters work for both kinds; parent filters select operations and operation filters select reports. Combined filters must all match.",
  },
  "trace-summary": {
    usage: "trace-summary [--day DATE] [--limit N]",
    note: "Summarize a UTC day, default today. The limit defaults to 1000 and accepts 1 through 1000 records of each kind. Check exhaustive before treating counts as complete. Timings describe inspected calls, not answer quality.",
  },
  "report-outcome": {
    usage: "report-outcome FILE",
    note: "Read a JSON file of at most 16384 bytes and append unverified caller feedback to the private journal. Supply operation_id or workflow_id, or both. Use returned evidence IDs for expected or used passages. Do not include source text or private internal reasoning. This does not create an approved memory.",
    schema: outcomeReportSchema,
  },
  validate: {
    usage: "validate FILE",
    note: "Validate a portable transfer JSON file of at most 4 MiB without the database. This never saves. Validation reports field paths without echoing rejected values. It does not establish source permission or prove that a source exists.",
    schema: transferSchema,
  },
  import: {
    usage: "import FILE --authorize",
    note: "Import an explicitly authorized review from a portable transfer JSON file of at most 4 MiB. Configured source permissions and exclusions still apply. Preserve source identity and revision on retries. Verify the returned receipt before reporting a save. This appends unratified evidence, not approved beliefs or connections.",
    schema: transferSchema,
  },
  status: {
    usage: "status",
    note: "Check archive storage availability. This requires the configured memory database. A connection failure is not evidence that memory is empty.",
  },
  receipt: {
    usage: "receipt ID",
    note: "Read a committed archive receipt by its returned UUID. A receipt proves that capture committed. It does not independently verify the source's claims or completeness.",
  },
  verify: {
    usage: "verify ID",
    note: "Verify a committed archive receipt against its stored transfer digest and saved evidence text. Supply the receipt UUID returned by import. This reads existing records and does not save a new capture.",
  },
  export: {
    usage: "export ID",
    note: "Return the complete stored transfer after checking its digest against the receipt. Supply a receipt UUID. The output contains source text; keep exported files in private storage.",
  },
  search: {
    usage: "search QUERY [--from ISO] [--until ISO] [--source-id UUID] [--role user|assistant|system|tool|other|unknown] [--offset N] [--limit N]",
    note: "Search source evidence with PostgreSQL web-search syntax. Ordinary words must all match; use distinctive words or explicit OR alternatives. Dates require known message timestamps. Follow next_offset for more results. An empty result does not prove absence. Schema keys use underscores where command flags use hyphens.",
    schema: z.object(archiveSearchShape),
  },
  read: {
    usage: "read ID [OFFSET LIMIT] [--offset N] [--limit N] [--text-offset N] [--text-limit N]",
    note: "Read a saved archive by receipt or episode UUID. Message offset defaults to 0, maximum 100000; message limit defaults to 10, maximum 20. Text offset defaults to 0, maximum 200000; text limit defaults to 4000, maximum 8000. Follow next_offset for messages and each next_text_offset for longer text. Positional and named page arguments cannot duplicate each other.",
  },
  source: {
    usage: "source ID [OFFSET LIMIT] [--offset N] [--limit N]",
    note: "Read retained source text by receipt or episode UUID. Offset defaults to 0, maximum 5000000; limit defaults to 8000, maximum 12000. Follow next_offset. The origin field distinguishes a supplied source export, rendered messages, and legacy text. Retained text does not prove source completeness.",
  },
  evidence: {
    usage: "evidence ID [--context N] [--text-offset N] [--text-limit N]",
    note: "Read an evidence UUID and nearby passages in its saved episode. Context defaults to one neighbor per side and accepts 0 through 3. Follow next_text_offset to continue the matching passage. Neighbors have their own IDs and continuation offsets. Schema keys use underscores where command flags use hyphens.",
    schema: z.object(evidenceReadShape),
  },
};

const helpFlags = new Set(["--help", "-h"]);
export function portableHelp(args) {
  let command;
  if (!args.length) command = undefined;
  else if (args[0] === "help" || helpFlags.has(args[0])) {
    if (args.length > 2) throw Object.assign(new Error("Invalid help request."), { code: "invalid" });
    command = args[1];
  } else if (args.slice(1).some(arg => helpFlags.has(arg))) command = args[0];
  else return null;
  if (command === undefined) return {
    state: "help", commands: Object.values(commands).map(item => item.usage),
    note: "Use COMMAND --help or help COMMAND for arguments and JSON file formats. Validation is offline and never saves. Read and search results include continuation offsets. Import requires explicit authorization.",
  };
  if (!Object.hasOwn(commands, command)) throw Object.assign(new Error("Unknown help command."), { code: "invalid" });
  const entry = commands[command];
  return { state: "help", command, usage: entry.usage, note: entry.note, ...(entry.schema ? { input_schema: z.toJSONSchema(entry.schema, { io: "input" }) } : {}) };
}
