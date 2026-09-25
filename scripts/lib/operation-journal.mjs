import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, link, unlink, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { outcomeReportSchema, summarizeOperations } from "./operation-feedback.mjs";
import { callerMetadata, inputMetadata, outputMetadata, resultErrorCode, safeErrorCode, safeOperation } from "./operation-metadata.mjs";

const MAX_EVENT_BYTES = 128 * 1024;
const idPattern = /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const failure = code => Object.assign(new Error("Operation trace " + code + "."), { code });
const validDay = day => typeof day === "string" && /^\d{4}-\d\d-\d\d$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;

function parseId(id) {
  const match = typeof id === "string" && id.match(idPattern);
  if (!match || !validDay(match[1])) throw failure("invalid");
  return { day: match[1], id };
}

async function checkPrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw failure("unavailable");
}

async function syncDirectory(path) {
  const folder = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await folder.sync(); } finally { await folder.close(); }
}

async function privateDirectory(path) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  await checkPrivateDirectory(path);
  if (created) {
    let current = path;
    const parent = dirname(created);
    while (current !== parent) { await syncDirectory(current); current = dirname(current); }
    await syncDirectory(parent);
  }
}

async function durableCreate(directory, filename, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_EVENT_BYTES) throw failure("invalid");
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = null;
    // Linking publishes a complete event and refuses to replace an earlier event.
    await link(temporary, join(directory, filename));
    await unlink(temporary);
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function readEvent(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_EVENT_BYTES || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw failure("unavailable");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function readPage(ids, reader) {
  const results = new Array(ids.length);
  let next = 0, error = null;
  // A summary can inspect 1,000 records; opening them all can exhaust the process.
  const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
    while (!error && next < ids.length) {
      const index = next++;
      try { results[index] = await reader(ids[index]); }
      catch (caught) { error = caught; }
    }
  });
  // Finish outstanding reads before reporting failure so their handles close.
  await Promise.all(workers);
  if (error) throw error;
  return results;
}

export function createOperationJournal({ directory, enabled = true } = {}) {
  const root = directory ? resolve(directory) : null;
  let writes = 0, failures = 0, timeouts = 0;
  const status = () => ({ state: !enabled ? "disabled" : failures || timeouts ? "degraded" : writes ? "ready" : "unverified", recorded_events: writes, failed_events: failures, unconfirmed_events: timeouts, storage: "local_private_files", content: "metadata_only" });
  const failed = () => { failures++; return { recorded: false, error_code: "trace_unavailable" }; };
  const folder = async (day, create = false) => {
    if (!root || (!enabled && create)) throw failure("unavailable");
    const check = create ? privateDirectory : checkPrivateDirectory;
    await check(root);
    const path = join(root, day);
    await check(path);
    return path;
  };
  const read = async id => {
    const { day } = parseId(id);
    try {
      const path = await folder(day);
      const start = await readEvent(join(path, `${id}.start.json`));
      let finish = null;
      try { finish = await readEvent(join(path, `${id}.finish.json`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      let input = null;
      try { input = await readEvent(join(path, `${id}.input.json`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      let delivery = null;
      try { delivery = await readEvent(join(path, `${id}.delivery.json`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      return { id, state: finish ? "finished" : "incomplete", start, input, finish, delivery };
    } catch (error) { throw failure(error.code === "ENOENT" ? "not_found" : "unavailable"); }
  };
  const readReport = async id => {
    const { day } = parseId(id);
    try { return await readEvent(join(await folder(day), `${id}.report.json`)); }
    catch (error) { throw failure(error.code === "ENOENT" ? "not_found" : "unavailable"); }
  };
  const listEvents = async ({ day, limit, after = null }, kind, reader) => {
    try {
      const suffix = `.${kind}.json`;
      const ids = (await readdir(await folder(day))).filter(name => name.endsWith(suffix))
        .map(name => name.slice(0, -suffix.length)).filter(id => idPattern.test(id) && (!after || id > after)).sort();
      const selected = ids.slice(0, limit);
      return { day, items: await readPage(selected, reader), has_more: ids.length > limit,
        next_after: ids.length > limit ? selected.at(-1) : null, order: "identifier", exhaustive: ids.length <= limit };
    } catch (error) {
      if (error.code === "ENOENT") return { day, items: [], has_more: false, next_after: null, order: "identifier", exhaustive: true };
      throw failure("unavailable");
    }
  };
  return {
    status, read, readReport,
    markTimeout() { timeouts++; },
    async start({ entry_point, operation, release, caller, input, connection_id = null, protocol_request_id = null, workflow_id = null, parent_id = null } = {}) {
      if (!enabled) return { recorded: false, disabled: true };
      try {
        const at = new Date().toISOString();
        const id = `${at.slice(0, 10)}_${randomUUID()}`;
        const safeUuid = value => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
        const event = {
          format: "tbrain.operation.v1", event: "start", id, at,
          entry_point: ["tbrain_mcp", "fuzzy_brain_mcp", "tbrain_cli", "recall_cli", "brain_cli", "index_cli", "sync_cli", "ingest_cli"].includes(entry_point) ? entry_point : "unknown",
          operation: safeOperation(operation),
          release: typeof release === "string" && /^\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?$/.test(release) ? release.slice(0, 80) : null,
          caller: callerMetadata(caller), input: inputMetadata(input),
          connection_id: safeUuid(connection_id), workflow_id: safeUuid(workflow_id),
          parent_id: typeof parent_id === "string" && idPattern.test(parent_id) ? parent_id : null,
          protocol_request_id: Number.isSafeInteger(protocol_request_id) ? protocol_request_id : null,
        };
        await durableCreate(await folder(at.slice(0, 10), true), `${id}.start.json`, event);
        writes++;
        return { id, recorded: true };
      } catch { return failed(); }
    },
    async recordInput(id, input) {
      if (!enabled) return { recorded: false, disabled: true };
      try {
        const { day } = parseId(id);
        await read(id);
        await durableCreate(await folder(day), `${id}.input.json`, {
          format: "tbrain.operation.v1", event: "input", id, at: new Date().toISOString(), input: inputMetadata(input),
        });
        writes++;
        return { id, recorded: true };
      } catch { return failed(); }
    },
    async finish(id, { duration_ms, result, error, is_error = false, delivery = "not_attempted" } = {}) {
      if (!enabled) return { recorded: false, disabled: true };
      try {
        const { day } = parseId(id);
        await read(id);
        const reportedError = resultErrorCode(result);
        const unsuccessful = Boolean(error || is_error || reportedError);
        const event = {
          format: "tbrain.operation.v1", event: "finish", id, at: new Date().toISOString(),
          duration_ms: typeof duration_ms === "number" && Number.isFinite(duration_ms) && duration_ms >= 0 ? duration_ms : null,
          outcome: unsuccessful ? "error" : "success",
          error_code: unsuccessful ? safeErrorCode(error?.code ?? reportedError) : null,
          delivery: ["not_attempted", "sent", "failed", "unknown"].includes(delivery) ? delivery : "unknown",
          output: outputMetadata(result),
        };
        await durableCreate(await folder(day), `${id}.finish.json`, event);
        writes++;
        return { id, recorded: true };
      } catch { return failed(); }
    },
    async recordDelivery(id, state) {
      if (!enabled) return { recorded: false, disabled: true };
      try {
        const { day } = parseId(id);
        const saved = await read(id);
        if (!saved.finish || !["sent", "failed"].includes(state)) throw failure("invalid");
        await durableCreate(await folder(day), `${id}.delivery.json`, {
          format: "tbrain.operation.v1", event: "delivery", id, at: new Date().toISOString(), state,
          note: "Sent means the transport accepted the reply, not that the caller read or used it.",
        });
        writes++;
        return { id, recorded: true };
      } catch { return failed(); }
    },
    async report(input) {
      const parsed = outcomeReportSchema.safeParse(input);
      if (!parsed.success) throw failure("invalid");
      const report = parsed.data;
      if (report.operation_id) await read(report.operation_id);
      try {
        const at = new Date().toISOString();
        const id = `${at.slice(0, 10)}_${randomUUID()}`;
        await durableCreate(await folder(at.slice(0, 10), true), `${id}.report.json`, {
          format: "tbrain.outcome.v1", id, reported_at: at, attribution: "caller_reported", ...report,
        });
        writes++;
        return { id, recorded: true, attribution: "caller_reported" };
      } catch { failures++; throw failure("unavailable"); }
    },
    async list({ day = new Date().toISOString().slice(0, 10), limit = 20, after = null } = {}) {
      if (!validDay(day) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (after !== null && parseId(after).day !== day)) throw failure("invalid");
      const { items, ...page } = await listEvents({ day, limit, after }, "start", read);
      return { ...page, traces: items };
    },
    async listReports({ day = new Date().toISOString().slice(0, 10), limit = 20, after = null } = {}) {
      if (!validDay(day) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (after !== null && parseId(after).day !== day)) throw failure("invalid");
      const { items, ...page } = await listEvents({ day, limit, after }, "report", readReport);
      return { ...page, reports: items };
    },
    async summary({ day = new Date().toISOString().slice(0, 10), limit = 1000 } = {}) {
      if (!validDay(day) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw failure("invalid");
      const [traces, reports] = await Promise.all([
        listEvents({ day, limit }, "start", read), listEvents({ day, limit }, "report", readReport),
      ]);
      return { day, ...summarizeOperations(traces.items, reports.items), exhaustive: traces.exhaustive && reports.exhaustive,
        scan_limit_per_kind: limit, next_operation: traces.next_after, next_report: reports.next_after,
        note: "Counts and percentiles describe only the inspected records. New concurrent records may need another read." };
    },
  };
}
