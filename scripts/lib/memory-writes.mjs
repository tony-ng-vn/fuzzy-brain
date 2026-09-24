import { z } from "zod";
import { schemaTables } from "../brain.mjs";
import { digest } from "./tbrain-transfer.mjs";
import { inferDeadline, normalizeTimestamp } from "./temporal.mjs";

const words = z.string().min(1).refine(value => value.trim().length > 0, "Verbatim words are required.");
const requestId = z.uuid().optional();
const timestamp = z.string().nullable().optional().transform(value => value ? normalizeTimestamp(value) : null);
const nodeInput = z.object({
  request_id: requestId, type: z.string().default(""), title: words, raw: words,
  body: z.string().nullable().optional(), deadline_at: timestamp,
  deadline_origin: z.enum(["explicit", "derived"]).nullable().optional(),
});
const completionInput = z.object({
  request_id: requestId, node_ids: z.array(z.uuid()).min(1).max(1000), raw: words, occurred_at: timestamp,
});

function operationError(code) {
  return Object.assign(new Error(`Memory write ${code}`), { code });
}

function receiptTable(schema) {
  schemaTables(schema);
  return `"${schema}".memory_write_receipts`;
}

async function executeWrite(client, schema, id, operation, input, apply) {
  const table = receiptTable(schema);
  const fingerprint = id ? digest({ operation, input }) : null;
  await client.query("begin");
  try {
    if (id) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([schema, "memory-write", id])]);
      const existing = (await client.query(`select operation, request_digest, result from ${table} where request_id=$1`, [id])).rows[0];
      if (existing) {
        if (existing.operation !== operation || existing.request_digest !== fingerprint) throw operationError("conflict");
        await client.query("commit");
        return { ...existing.result, replayed: true };
      }
    }
    const value = await apply();
    const result = id ? { ...value, request_id: id, operation, state: "committed", replayed: false } : value;
    if (id) {
      await client.query(`insert into ${table}(request_id,operation,request_digest,result) values($1,$2,$3,$4)`,
        [id, operation, fingerprint, JSON.stringify(result)]);
    }
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* Retry the same ID to resolve an uncertain commit. */ }
    throw error;
  }
}

export async function readWriteReceipt(client, schema, id) {
  z.uuid().parse(id);
  const row = (await client.query(`select result from ${receiptTable(schema)} where request_id=$1`, [id])).rows[0];
  if (!row) throw operationError("not_found");
  return row.result;
}

export async function addMemoryNode(client, schema, input) {
  const { request_id, ...parsed } = nodeInput.parse(input);
  const payload = {
    ...parsed, body: parsed.body?.trim() ? parsed.body : parsed.raw,
    deadline_origin: parsed.deadline_at ? parsed.deadline_origin ?? "derived" : null,
  };
  const tables = schemaTables(schema);
  return executeWrite(client, schema, request_id, "add-node", payload, async () => {
    // Derive relative dates only after a replay has been ruled out.
    const deadline = payload.deadline_at
      ? { dueAt: payload.deadline_at, origin: payload.deadline_origin }
      : inferDeadline({ type: payload.type, title: payload.title, text: payload.raw });
    const { rows } = await client.query(
      `insert into ${tables.nodes}(type,title,body,raw) values($1,$2,$3,$4) returning id,type,title,created_at`,
      [payload.type, payload.title, payload.body, payload.raw]);
    if (deadline?.dueAt) {
      await client.query(`insert into ${tables.temporalEvents}(node_id,event_type,value_at,raw,origin)
        values($1,'deadline_set',$2,$3,$4)`, [rows[0].id, deadline.dueAt, payload.raw, deadline.origin]);
    }
    return { ...rows[0], due_at: deadline?.dueAt ?? null };
  });
}

export async function completeMemoryNodes(client, schema, input) {
  const { request_id, ...parsed } = completionInput.parse(input);
  const payload = { ...parsed, node_ids: [...new Set(parsed.node_ids)].sort() };
  const tables = schemaTables(schema);
  return executeWrite(client, schema, request_id, "mark-complete", payload, async () => {
    const locked = await client.query(`select id from ${tables.nodes} where id=any($1::uuid[]) order by id for update`, [payload.node_ids]);
    if (locked.rowCount !== payload.node_ids.length) throw operationError("not_found");
    // A separate statement sees events committed while this call waited for a lock.
    const existing = await client.query(`select n.id,n.title,ts.status from ${tables.nodes} n
      join ${tables.temporalState} ts on ts.node_id=n.id where n.id=any($1::uuid[]) order by n.id`, [payload.node_ids]);
    const pending = existing.rows.filter(row => row.status !== "completed");
    const occurredAt = payload.occurred_at ?? new Date().toISOString();
    const events = [];
    for (const row of pending) {
      const event = await client.query(`insert into ${tables.temporalEvents}(node_id,event_type,occurred_at,raw,origin)
        values($1,'completed',$2,$3,'explicit') returning id,node_id,event_type,occurred_at,raw,origin,created_at`,
      [row.id, occurredAt, payload.raw]);
      events.push(event.rows[0]);
    }
    return {
      completed: pending.map(({ id, title }) => ({ id, title })),
      already_completed: existing.rows.filter(row => row.status === "completed").map(({ id, title }) => ({ id, title })),
      events,
    };
  });
}
