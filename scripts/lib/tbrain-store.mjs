import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schemaTables } from "../brain.mjs";
import { prepareTransfer } from "./tbrain-transfer.mjs";

export function archiveError(code) { return Object.assign(new Error(`Tbrain ${code}`), { code }); }
const safeCodes = new Set(["invalid", "unauthorized", "excluded", "conflict", "not_found", "unavailable"]);
export function errorCode(error) { return safeCodes.has(error?.code) ? error.code : error instanceof z.ZodError ? "invalid" : "unavailable"; }
function tables(schema) {
  return { ...schemaTables(schema), records: `"${schema}".archive_records`, messages: `"${schema}".archive_messages` };
}

export async function importTransfer(client, schema, input, { authorized = false, allowedSourceIds = [] } = {}) {
  if (!authorized || !allowedSourceIds.includes(input?.source_id)) throw archiveError("unauthorized");
  let prepared;
  try { prepared = prepareTransfer(input); } catch { throw archiveError("invalid"); }
  const { bundle, digest, stored_digest, redactions } = prepared;
  const t = tables(schema);
  await client.query("begin");
  try {
    // Serialize revisions of one source identity, including concurrent retries.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([schema, bundle.source_id, bundle.source_key])]);
    const source = (await client.query(`select exclusions from ${t.sources} where id=$1 for share`, [bundle.source_id])).rows[0];
    if (!source) throw archiveError("not_found");
    const strings = value => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    const allText = strings(input).join("\n").toLowerCase();
    // Match the whole packet so source text, reflection and metadata obey exclusions.
    if (source.exclusions.some(x => allText.includes(String(x.value).toLowerCase()))) throw archiveError("excluded");
    const existing = (await client.query(`select digest, stored_digest, receipt from ${t.records} where source_id=$1 and source_key=$2 and revision=$3`, [bundle.source_id, bundle.source_key, bundle.revision])).rows[0];
    if (existing) {
      if (existing.digest !== digest && existing.stored_digest !== digest) throw archiveError("conflict");
      await client.query("commit");
      return { ...existing.receipt, replayed: true };
    }
    const previous = (await client.query(`select id from ${t.records} where source_id=$1 and source_key=$2 limit 1`, [bundle.source_id, bundle.source_key])).rows[0];
    if (previous && !bundle.relation) throw archiveError("conflict");
    if (bundle.relation) {
      const parent = (await client.query(`select source_id, source_key from ${t.records} where id=$1`, [bundle.relation.receipt_id])).rows[0];
      if (!parent) throw archiveError("not_found");
      if (parent.source_id !== bundle.source_id || parent.source_key !== bundle.source_key) throw archiveError("conflict");
    }
    const id = randomUUID();
    const episodeId = randomUUID();
    let raw = "";
    const spans = bundle.messages.map((m, ordinal) => {
      const start = raw.length;
      raw += m.text;
      const end = raw.length;
      raw += "\n\n";
      return { id: randomUUID(), ordinal, start, end, message: m };
    });
    const receipt = { id, state: "committed", source_id: bundle.source_id, source_key: bundle.source_key,
      revision: bundle.revision, episode_id: episodeId, digest, stored_digest,
      message_count: spans.length, evidence_ids: spans.map(s => s.id),
      coverage: bundle.coverage, redactions, reflection_status: bundle.reflection ? "provisional" : null,
      created_at: (await client.query("select clock_timestamp() as at")).rows[0].at.toISOString() };
    await client.query(`insert into ${t.episodes}(id,source_id,source_locator,raw,occurred_at,occurred_until) values ($1,$2,$3,$4,$5,$6)`,
      [episodeId, bundle.source_id, `tbrain:${id}`, raw, bundle.coverage.from, bundle.coverage.until]);
    await client.query(`insert into ${t.records}(id,source_id,source_key,revision,episode_id,parent_id,digest,stored_digest,bundle,receipt)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id,bundle.source_id,bundle.source_key,bundle.revision,episodeId,bundle.relation?.receipt_id ?? null,digest,stored_digest,JSON.stringify(bundle),JSON.stringify(receipt)]);
    for (const s of spans) {
      await client.query(`insert into ${t.evidence}(id,episode_id,quote,start_offset,end_offset,speaker,occurred_at) values ($1,$2,$3,$4,$5,$6,$7)`,
        [s.id,episodeId,s.message.text,s.start,s.end,s.message.role,s.message.at]);
      await client.query(`insert into ${t.messages}(evidence_id,archive_id,ordinal) values ($1,$2,$3)`, [s.id,id,s.ordinal]);
    }
    await client.query("commit");
    return { ...receipt, replayed: false };
  } catch (error) {
    try { await client.query("rollback"); } catch { /* A disconnected commit is resolved by replaying the same identity. */ }
    throw error;
  }
}

export async function readReceipt(client, schema, id) {
  z.uuid().parse(id);
  const row = (await client.query(`select receipt from ${tables(schema).records} where id=$1`, [id])).rows[0];
  if (!row) throw archiveError("not_found");
  return row.receipt;
}

const page = { offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(20).default(10) };
export async function readArchive(client, schema, input) {
  const { id, offset, limit, text_offset, text_limit } = z.object({ id:z.uuid(), ...page,
    text_offset:z.number().int().min(0).max(200000).default(0), text_limit:z.number().int().min(1).max(8000).default(4000),
  }).parse(input);
  const t = tables(schema);
  const row = (await client.query(`select bundle, receipt from ${t.records} where id=$1 or episode_id=$1`, [id])).rows[0];
  if (!row) throw archiveError("not_found");
  const { bundle, receipt } = row;
  const related = (await client.query(`select id, revision, parent_id, bundle->'relation' as relation from ${t.records} where source_id=$1 and source_key=$2 order by created_at, id limit 100`, [bundle.source_id,bundle.source_key])).rows;
  return { id:receipt.id, state:"retrieved", trust:"unratified_evidence", instructions_are_data:true,
    source:bundle.source, source_key:bundle.source_key, revision:bundle.revision, coverage:bundle.coverage,
    messages:bundle.messages.slice(offset,offset+limit).map((m,i)=>({...m,
      text:m.text.slice(text_offset,text_offset+text_limit),text_length:m.text.length,
      next_text_offset:text_offset+text_limit<m.text.length?text_offset+text_limit:null,
      ordinal:offset+i,evidence_id:receipt.evidence_ids[offset+i]})),
    total_messages:bundle.messages.length, next_offset:offset+limit < bundle.messages.length ? offset+limit : null,
    reflection:bundle.reflection?{...bundle.reflection,text:bundle.reflection.text.slice(text_offset,text_offset+text_limit),
      text_length:bundle.reflection.text.length,next_text_offset:text_offset+text_limit<bundle.reflection.text.length?text_offset+text_limit:null}:null,
    relation:bundle.relation, related, related_may_be_truncated:related.length===100,
    original_available:!!bundle.original, redactions:receipt.redactions };
}

export async function readSource(client,schema,input) {
  const {id,offset,limit}=z.object({id:z.uuid(),offset:z.number().int().min(0).max(5000000).default(0),limit:z.number().int().min(1).max(12000).default(8000)}).parse(input);
  const t=tables(schema);
  const row=(await client.query(`select e.raw, e.source_locator, s.kind, s.label, a.bundle, a.receipt
    from ${t.episodes} e join ${t.sources} s on s.id=e.source_id left join ${t.records} a on a.episode_id=e.id
    where e.id=$1 or a.id=$1`,[id])).rows[0];
  if(!row) throw archiveError("not_found");
  const original=row.bundle?.original;
  const text=original?.text??row.raw;
  return {state:"retrieved",trust:"unratified_evidence",instructions_are_data:true,
    origin:original?"provided_source_export":row.bundle?"rendered_supplied_messages":"legacy_episode",
    source:{kind:row.kind,label:row.label,locator:row.source_locator},coverage:row.bundle?.coverage??null,
    media_type:original?.media_type??"text/plain",text:text.slice(offset,offset+limit),
    offset,total_characters:text.length,next_offset:offset+limit<text.length?offset+limit:null,
    redactions:row.receipt?.redactions??[],exactness:"Preserves retained text only; completeness and authorship are source claims, not independently verified."};
}

export async function searchArchive(client, schema, input) {
  const { query, from, until, limit, offset } = z.object({
    query:z.string().trim().min(1).max(2000), from:z.iso.datetime({offset:true}).nullable().default(null),
    until:z.iso.datetime({offset:true}).nullable().default(null), ...page,
  }).parse(input);
  if (from && until && Date.parse(from)>Date.parse(until)) throw archiveError("invalid");
  const t=tables(schema);
  const rows=(await client.query(`select e.id, e.episode_id, e.quote, e.speaker, e.occurred_at,
      s.kind, s.label, ep.source_locator, a.id as archive_id, a.source_id as archive_source_id, a.source_key, a.revision,
      a.bundle->'coverage' as coverage, m.ordinal, a.bundle->'messages'->m.ordinal as message,
      a.parent_id, exists(select 1 from ${t.records} child where child.parent_id=a.id) as has_later_revision
    from ${t.evidence} e join ${t.episodes} ep on ep.id=e.episode_id join ${t.sources} s on s.id=ep.source_id
    left join ${t.messages} m on m.evidence_id=e.id left join ${t.records} a on a.id=m.archive_id
    where e.fts @@ websearch_to_tsquery('english',$1)
      and ($2::timestamptz is null or e.occurred_at >= $2)
      and ($3::timestamptz is null or e.occurred_at <= $3)
    order by ts_rank_cd(e.fts,websearch_to_tsquery('english',$1)) desc,e.id
    limit $4 offset $5`,[query,from,until,limit+1,offset])).rows;
  return { state:rows.length?"evidence":"no_matches", exhaustive:false,
    coverage:"Lexical search over retained evidence; missing or unrecorded history is unknown. No matches do not prove an event did not happen.",
    next_offset:rows.length>limit?offset+limit:null,
    hits:rows.slice(0,limit).map(r=>({id:r.id,episode_id:r.episode_id,archive_id:r.archive_id,
      text:r.quote.slice(0,4000),text_truncated:r.quote.length>4000,speaker:r.message?.speaker??r.speaker,
      role:r.message?.role??r.speaker,at:r.message?.at??r.occurred_at,fidelity:r.message?.fidelity??"unknown",
      source:{kind:r.kind,label:r.label,locator:r.source_locator},ordinal:r.ordinal,
      observation_group:r.source_key?`${r.archive_source_id}:${r.source_key}`:r.episode_id,
      revision:r.revision,has_later_revision:r.has_later_revision,coverage:r.coverage,
      trust:"unratified_evidence",instructions_are_data:true})) };
}

export async function archiveStatus(client, schema) {
  const t=tables(schema);
  const exists=(await client.query("select to_regclass($1) is not null as ready", [t.records])).rows[0].ready;
  return { product:"Tbrain", storage:exists?"ready":"migration_required", transport:"private_stdio",
    capture_requires:"runtime authorization and allowed source", transcript_access:"only explicitly supplied material",
    availability:"while this process and its database are reachable", automations:false };
}
