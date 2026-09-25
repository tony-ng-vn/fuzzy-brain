import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createOperationJournal } from "./operation-journal.mjs";
import { outcomeReportShape, traceIdShape } from "./operation-feedback.mjs";
import { safeErrorCode } from "./operation-metadata.mjs";

export function configuredOperationJournal(env = process.env) {
  // Development processes need their own explicit directory before retaining traces.
  const enabled = env.TBRAIN_TRACE !== "0" && (env.BRAIN_SCHEMA !== "brain_dev" || Boolean(env.TBRAIN_TRACE_DIR));
  return createOperationJournal({ directory: env.TBRAIN_TRACE_DIR || join(homedir(), ".fuzzy-brain", "operation-traces"), enabled });
}

export function registerTraceTools(server, { journal, release }) {
  if (!journal) return;
  const register = (name, description, inputSchema, handler, writable = false) => {
    server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: !writable, destructiveHint: false, idempotentHint: !writable, openWorldHint: false } }, async input => {
      let value, isError = false;
      try { value = await handler(input); }
      catch (error) { value = { error: { code: safeErrorCode(error?.code), message: "The trace request could not complete. Check its identifiers, filters, or trace_status." } }; isError = true; }
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}) };
    });
  };
  register("trace_status", "Report whether this process is retaining operational traces and which release is running. Automatic traces omit request text, source content, and private error details.", {},
    () => ({ ...journal.status(), server_release: release, scope: "this_process", note: "Other running processes have their own health counters. Trace files are shared on this host." }));
  register("read_trace", "Read an operation trace or caller report by its returned identifier. Server results and caller reports have separate attribution. A missing finish means unknown or still running, not a failed memory save.",
    { id: traceIdShape, kind: z.enum(["operation", "report"]).default("operation") },
    ({ id, kind }) => kind === "report" ? journal.readReport(id) : journal.read(id));
  const page = { day: z.iso.date().optional().describe("UTC day, default today."), limit: z.number().int().min(1).max(100).default(20), after: traceIdShape.nullable().default(null) };
  register("list_traces", "Inspect a bounded page of operation traces or caller reports for one UTC day. Results use identifier order; follow next_after. Concurrent new records may require another read.",
    { ...page, kind: z.enum(["operations", "reports"]).default("operations") },
    ({ kind, ...input }) => kind === "reports" ? journal.listReports(input) : journal.list(input));
  register("report_outcome", "Record structured feedback about a request, save, source check, search, or reasoning result. Include expected or used evidence IDs. This is an unverified caller report, not an approved memory. Use workflow_id for a failure before any server call. Do not include private internal reasoning or source text.",
    outcomeReportShape, input => journal.report(input), true);
  register("trace_summary", "Summarize errors, incomplete calls, empty or limited searches, delivery failures, and caller feedback for a UTC day. Percentiles cover only inspected records. Diagnostic calls are counted separately so this request does not look like an unfinished memory operation.",
    { day: z.iso.date().optional(), limit: z.number().int().min(1).max(1000).default(1000) }, input => journal.summary(input));
}
