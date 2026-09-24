import { randomUUID } from "node:crypto";
import { z } from "zod";
import { schemaTables, insertEpisode, scrubSensitivePatterns } from "../brain.mjs";
import { digest } from "./tbrain-transfer.mjs";
import { normalizeTimestamp } from "./temporal.mjs";
import { renderEpisode, SESSION_PARSER_VERSION } from "./session-parser.mjs";

const words = z.string().min(1).refine(value => value.trim().length > 0);
const inputSchema = z.object({
  source_id: z.uuid().transform(value => value.toLowerCase()), source_locator: words.max(500), raw: words,
  file_mtime_ms: z.number().finite().nonnegative(), file_size: z.number().int().nonnegative(),
  thread_context: z.string().default(""),
  evidence: z.array(z.object({
    quote: words, speaker: z.enum(["tony", "assistant"]),
    start_offset: z.number().int().nonnegative(), end_offset: z.number().int().positive(),
    occurred_at: z.string().nullable().optional(), omitted_before: z.number().int().nonnegative().default(0),
  })).min(1),
});

function failure(code) { return Object.assign(new Error(`Session capture ${code}.`), { code }); }
function instant(value) {
  if (value == null) return null;
  try { return normalizeTimestamp(value instanceof Date ? value.toISOString() : value); }
  catch { throw failure("invalid"); }
}
function key(speaker, text, at) { return digest([speaker, text, instant(at)]); }
function tables(schema) {
  return { ...schemaTables(schema), checkpoints: `"${schema}".session_ingest_checkpoints` };
}

export async function listSessionCheckpoints(client, schema, sourceId) {
  z.uuid().parse(sourceId);
  const t = tables(schema);
  return (await client.query(`select distinct on (session_key) session_key, parser_version, file_mtime_ms,
      file_size::float8 as file_size, checked_at from ${t.checkpoints}
      where source_id=$1 and parser_version=$2 order by session_key, checked_at desc, id desc`,
  [sourceId, SESSION_PARSER_VERSION])).rows;
}

export async function syncSession(client, schema, input) {
  const parsed = inputSchema.parse(input);
  let previousEnd = 0;
  const turns = parsed.evidence.map(span => {
    if (span.start_offset < previousEnd || span.end_offset <= span.start_offset || parsed.raw.slice(span.start_offset, span.end_offset) !== span.quote) {
      throw failure("invalid");
    }
    previousEnd = span.end_offset;
    return { speaker: span.speaker, text: scrubSensitivePatterns(span.quote).text,
      ts: instant(span.occurred_at), omittedBefore: span.omitted_before };
  });
  const fingerprint = digest({ source: parsed.source_id, session: parsed.source_locator,
    fileTime: parsed.file_mtime_ms, fileSize: parsed.file_size, turns });
  const t = tables(schema);
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([schema, "session-sync", parsed.source_id, parsed.source_locator])]);
    const source = (await client.query(`select kind,exclusions from ${t.sources} where id=$1 for share`, [parsed.source_id])).rows[0];
    if (!source) throw failure("not_found");
    if (!["claude_code_session", "codex_session"].includes(source.kind)) throw failure("invalid");
    const fullText = parsed.raw.toLowerCase();
    if (source.exclusions.some(exclusion => (exclusion.kind === "thread" ? parsed.thread_context.toLowerCase() : fullText)
      .includes(String(exclusion.value).toLowerCase()))) throw failure("excluded");
    const receipt = (await client.query(`select result from ${t.checkpoints}
      where source_id=$1 and session_key=$2 and parser_version=$3 and input_digest=$4`,
    [parsed.source_id, parsed.source_locator, SESSION_PARSER_VERSION, fingerprint])).rows[0];
    if (receipt) {
      await client.query("commit");
      return { ...receipt.result, replayed: true };
    }

    const stored = await client.query(`select v.speaker,v.quote,v.occurred_at from ${t.evidence} v
      join ${t.episodes} e on e.id=v.episode_id where e.source_id=$1 and
      (e.source_locator=$2 or left(e.source_locator,length($2)+7)=$2||':turns:'
        or left(e.source_locator,length($2)+6)=$2||':sync:')`, [parsed.source_id, parsed.source_locator]);
    const available = new Map();
    for (const row of stored.rows) {
      const identity = key(row.speaker, row.quote, row.occurred_at);
      available.set(identity, (available.get(identity) ?? 0) + 1);
    }
    // Consume occurrences instead of deduplicating text; repetition can be meaningful.
    const unseen = turns.filter(turn => {
      const identity = key(turn.speaker, turn.text, turn.ts);
      const remaining = available.get(identity) ?? 0;
      if (!remaining) return true;
      available.set(identity, remaining - 1);
      return false;
    });
    let episode = null;
    if (unseen.length) {
      const rendered = renderEpisode(unseen);
      const stamped = unseen.map(turn => turn.ts).filter(Boolean).sort();
      episode = await insertEpisode(client, t, {
        source_id: parsed.source_id, source_locator: `${parsed.source_locator}:sync:${fingerprint}`,
        raw: rendered.raw, occurred_at: stamped[0] ?? null, occurred_until: stamped.at(-1) ?? null,
        evidence: rendered.spans.map(span => ({ quote: span.text, speaker: span.speaker,
          start_offset: span.start, end_offset: span.end, occurred_at: span.ts })),
      });
    }
    const id = randomUUID();
    const result = { state: "committed", checkpoint_id: id, id: episode?.id ?? null,
      source_locator: parsed.source_locator, evidence_count: unseen.length,
      seen_count: turns.length - unseen.length, parser_version: SESSION_PARSER_VERSION, replayed: false };
    await client.query(`insert into ${t.checkpoints}
      (id,source_id,session_key,parser_version,file_mtime_ms,file_size,input_digest,result)
      values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, parsed.source_id, parsed.source_locator, SESSION_PARSER_VERSION, parsed.file_mtime_ms, parsed.file_size, fingerprint, JSON.stringify(result)]);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* A retry verifies an uncertain commit. */ }
    throw error;
  }
}
