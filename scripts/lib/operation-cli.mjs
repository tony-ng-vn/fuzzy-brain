import { attemptTrace } from "./operation-safety.mjs";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { configuredOperationJournal } from "./operation-tools.mjs";
import { operationContext } from "./operation-context.mjs";

const release = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const safe = (journal, action) => attemptTrace(action, { onTimeout: () => journal.markTimeout?.() });
const parsed = value => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } };

export async function recordTraceInput(value) {
  const context = operationContext.getStore();
  if (context?.id) await safe(context.journal, () => context.journal.recordInput(context.id, parsed(value)));
  return value;
}

export function emitTracedOutput(text) {
  const context = operationContext.getStore();
  if (context) context.result = parsed(text);
  console.log(text);
}

export async function runTracedCli(entryPoint, operation, args, handler) {
  const journal = configuredOperationJournal();
  const receivedAt = performance.now();
  const start = await safe(journal, () => journal.start({ entry_point: entryPoint, operation, release, input: args,
    parent_id: process.env.TBRAIN_PARENT_TRACE_ID, workflow_id: process.env.TBRAIN_WORKFLOW_ID }));
  const context = { journal, id: start.id, workflowId: process.env.TBRAIN_WORKFLOW_ID, result: undefined };
  return operationContext.run(context, async () => {
    let result, error;
    try { result = await handler(); return result; }
    catch (caught) { error = caught; throw caught; }
    finally {
      const finished = start.recorded ? await safe(journal, () => journal.finish(start.id, {
        duration_ms: performance.now() - receivedAt, result: result ?? context.result,
        error: error ? { code: error instanceof SyntaxError || error.name === "ZodError" ? "invalid" : error.code } : undefined,
      })) : start;
      if (process.env.TBRAIN_TRACE_RECEIPT === "1") console.error(JSON.stringify({ event: "tbrain.trace", ...start, ...finished }));
    }
  });
}
