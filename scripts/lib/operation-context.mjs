import { AsyncLocalStorage } from "node:async_hooks";

export const operationContext = new AsyncLocalStorage();

export function operationChildEnvironment(env = process.env) {
  const context = operationContext.getStore();
  return {
    ...env,
    ...(context?.id ? { TBRAIN_PARENT_TRACE_ID: context.id } : {}),
    ...(context?.workflowId ? { TBRAIN_WORKFLOW_ID: context.workflowId } : {}),
  };
}
