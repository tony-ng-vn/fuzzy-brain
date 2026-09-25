import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

function toolValue(result) {
  if (result?.structuredContent) return result.structuredContent;
  if (result?.content?.[0]?.type === "text") {
    try { return JSON.parse(result.content[0].text); } catch { return null; }
  }
  return result;
}

function resultError(message, value) {
  if (value?.error) return { code: value.error.code };
  if (message.error) return { code: [-32600, -32601, -32602].includes(message.error.code) ? "invalid" : "unavailable" };
  if (message.result?.isError) {
    const text = message.result.content?.[0]?.text ?? "";
    return { code: /^MCP error -32602:/.test(text) ? "invalid" : "unavailable" };
  }
  return null;
}

export function traceTransport(transport, { journal, entryPoint, release }) {
  const pending = new Map();
  const connectionId = randomUUID();
  let caller = null, closed = false;
  const previousClose = transport.onclose;
  const previousError = transport.onerror;
  const safely = async action => {
    try { return await action(); } catch { return { recorded: false, error_code: "trace_unavailable" }; }
  };
  const traced = {
    get sessionId() { return transport.sessionId; },
    async start() {
      transport.onmessage = async (message, extra) => {
        const request = message && typeof message.method === "string" && Object.hasOwn(message, "id");
        if (!request) { traced.onmessage?.(message, extra); return; }
        const receivedAt = performance.now();
        if (message.method === "initialize") caller = message.params?.clientInfo;
        const start = await safely(() => journal.start({
          entry_point: entryPoint, operation: message.method === "tools/call" ? message.params?.name : message.method,
          release, caller, input: message.method === "tools/call" ? message.params?.arguments : message.params,
          connection_id: connectionId, protocol_request_id: message.id, workflow_id: message.params?._meta?.["tbrain/workflow_id"],
        }));
        if (closed) return;
        pending.set(JSON.stringify(message.id), { ...start, receivedAt, tool: message.method === "tools/call" });
        traced.onmessage?.(message, extra);
      };
      transport.onclose = () => { closed = true; pending.clear(); previousClose?.(); traced.onclose?.(); };
      transport.onerror = error => { previousError?.(error); traced.onerror?.(error); };
      await transport.start();
    },
    async send(message, options) {
      const key = JSON.stringify(message.id);
      const operation = Object.hasOwn(message, "id") && !message.method ? pending.get(key) : null;
      if (!operation) return transport.send(message, options);
      const value = toolValue(message.result);
      const error = resultError(message, value);
      const finished = operation.recorded ? await safely(() => journal.finish(operation.id, {
        duration_ms: performance.now() - operation.receivedAt, result: value, error,
        is_error: message.result?.isError === true,
      })) : { recorded: false, ...(operation.disabled ? { disabled: true } : { error_code: "trace_unavailable" }) };
      const trace = { ...(operation.id ? { id: operation.id } : {}), ...finished };
      let outgoing = message;
      if (operation.tool && message.result) outgoing = { ...message, result: { ...message.result, _meta: { ...message.result._meta, "tbrain/trace": trace } } };
      if (message.error) outgoing = { ...message, error: { ...message.error, data: { ...message.error.data, "tbrain/trace": trace } } };
      pending.delete(key);
      try {
        await transport.send(outgoing, options);
      } catch (error) {
        if (finished.recorded) await safely(() => journal.recordDelivery(operation.id, "failed"));
        throw error;
      }
      if (finished.recorded) await safely(() => journal.recordDelivery(operation.id, "sent"));
    },
    async close() { closed = true; await transport.close(); },
  };
  return traced;
}
