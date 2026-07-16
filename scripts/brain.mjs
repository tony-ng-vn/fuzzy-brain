// The brain companion's read/write tool. One place so a talking session never
// hand-rolls SQL or env loading. Reads: `index` (the whole brain, gist only,
// plus the latest talk recap) and `show <id...>` (both layers of a node).
// Writes: `add-node`, `add-edge`, `set-readable <id>`, `add-talk`, each reading
// one JSON object from stdin so bodies and whys keep their newlines and quotes.
// `dump` prints the entire brain as JSON for a snapshot in Tony's own hands.
// Deliberately absent, as protection by omission: no set-raw, no delete verbs.
// The database CHECKs on raw, why, and recap are the final gates (AGENTS.md);
// this tool never works around them. BRAIN_SCHEMA=brain_dev targets the sandbox.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// Postgres hands back created_at as a Date; tests pass ISO strings. Both land
// on YYYY-MM-DD this way.
function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

// Explicit qualification survives transaction-pooling proxies that discard
// session-level search_path settings between statements.
export function schemaTables(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid BRAIN_SCHEMA: ${schema}`);
  const prefix = `"${schema}".`;
  return {
    nodes: `${prefix}nodes`,
    edges: `${prefix}edges`,
    talks: `${prefix}talks`,
    sources: `${prefix}sources`,
    episodes: `${prefix}episodes`,
    evidence: `${prefix}evidence`,
  };
}

// Deterministic, local, no network calls -- runs before ANY AI model ever
// sees this text (ADR 0002 decision 3), and before this text is ever
// written to a row, because no update path exists afterward to fix a miss.
// Catches SSN-shaped (strict dashed format, to hold down false positives on
// arbitrary 9-digit runs) and credit-card-shaped (Luhn-validated, to hold
// down false positives on arbitrary long digit runs) spans only -- the
// exact-shape class ADR 0002 assigns to a deterministic filter, not to AI
// judgment. Returns { text, redactions }: text has every match replaced
// in-place by "[REDACTED:<reason>]"; redactions is [{ reason, match }].
export function scrubSensitivePatterns(text) {
  const redactions = [];
  let result = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (match) => {
    redactions.push({ reason: "ssn_pattern", match });
    return "[REDACTED:ssn_pattern]";
  });
  result = result.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    redactions.push({ reason: "credit_card_pattern", match });
    return "[REDACTED:credit_card_pattern]";
  });
  return { text: result, redactions };
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Compact whole-brain view: the gist Claude holds the entire session. */
export function formatIndex(nodes, edges, latestTalk = null) {
  const lines = [`BRAIN INDEX  nodes=${nodes.length} edges=${edges.length}`, ""];
  if (latestTalk) {
    lines.push(`LAST TALK  ${isoDate(latestTalk.created_at)}`);
    for (const l of String(latestTalk.recap).split("\n")) lines.push(`  ${l}`);
    lines.push("");
  }
  lines.push("NODES");
  for (const n of nodes) {
    lines.push(`  ${isoDate(n.created_at)}  ${n.type || "(untyped)"}  ${n.title}`);
    lines.push(`    ${n.id}`);
  }
  lines.push("");
  lines.push("EDGES");
  for (const e of edges) {
    lines.push(`  ${e.src_title}  ->  ${e.tgt_title}`);
    lines.push(`    why  ${e.why}`);
    lines.push(`    ${e.source} -> ${e.target}`);
  }
  return lines.join("\n");
}

/** Both layers of specific nodes, readable first: the guide, then the truth. */
export function formatShow(nodes) {
  return nodes
    .map((n) => {
      const head = `[${n.type || "(untyped)"}] ${n.title}  (${isoDate(n.created_at)})\n${n.id}`;
      return `${head}\n\nREADABLE\n${n.body}\n\nRAW\n${n.raw}`;
    })
    .join("\n\n----\n\n");
}

/** One episode plus its evidence spans: source context, then each span in
 *  offset order. Redacted spans render their placeholder and reason, never
 *  the real value. Sender-deleted spans stay visible with an explicit
 *  marker -- ADR 0002 decision 2 forbids silently hiding either state. */
export function formatEvidence(episode, source, evidenceList) {
  const lines = [
    `EPISODE  ${episode.id}`,
    `source   ${source.label} (${source.kind})`,
  ];
  if (episode.source_locator) lines.push(`locator  ${episode.source_locator}`);
  if (episode.occurred_at) {
    const span = episode.occurred_until ? `${isoDate(episode.occurred_at)} .. ${isoDate(episode.occurred_until)}` : isoDate(episode.occurred_at);
    lines.push(`occurred ${span}`);
  }
  lines.push("", "RAW", episode.raw, "");
  lines.push(`EVIDENCE (${evidenceList.length})`);
  for (const e of evidenceList) {
    const who = e.speaker ? `  ${e.speaker}` : "";
    lines.push(`  [${e.start_offset}-${e.end_offset}]${who}`);
    lines.push(`    ${e.quote}`);
    if (e.redaction_reason) lines.push(`    (redacted: ${e.redaction_reason})`);
    if (e.sender_deleted_at) lines.push(`    (deleted by sender, observed ${isoDate(e.sender_deleted_at)})`);
  }
  return lines.join("\n");
}

// exclusions shape: [{ kind: 'person'|'thread'|'topic', value, added_at?, note? }]
// Prospective only: naming an exclusion cannot retroactively remove
// anything already ingested before it existed (ADR 0002).
function validateExclusion(x) {
  if (!x || typeof x !== "object") throw new Error("each exclusion needs kind and value");
  if (!["person", "thread", "topic"].includes(x.kind)) {
    throw new Error(`exclusion kind must be person, thread, or topic: got ${x.kind}`);
  }
  if (!x.value || !String(x.value).trim()) throw new Error("each exclusion needs a non-blank value");
}

function stampExclusions(list) {
  return list.map((x) => ({ ...x, added_at: x.added_at ?? new Date().toISOString() }));
}

function loadEnvLocal() {
  try {
    const text = readFileSync(join(here, "..", ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // no .env.local; rely on the environment
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// The one evidence INSERT, shared by add-evidence and add-episode's atomic
// evidence array -- a single write path so the scrub covers every caller.
// Whole-row replacement, not partial: a redacted quote is fully the
// placeholder or fully the real atomic quote, never a mixed state -- this
// is what keeps the DB's placeholder-only CHECK constraint airtight.
async function insertEvidenceRow(client, tables, item) {
  const { episode_id, quote, start_offset, end_offset, speaker, occurred_at } = item;
  if (!quote || !quote.trim()) throw new Error("evidence needs a quote");
  const { redactions } = scrubSensitivePatterns(quote);
  const finalQuote = redactions.length > 0 ? `[REDACTED:${redactions[0].reason}]` : quote;
  const redactionReason = redactions.length > 0 ? redactions[0].reason : null;
  const { rows } = await client.query(
    `insert into ${tables.evidence} (episode_id, quote, start_offset, end_offset, speaker, occurred_at, redaction_reason)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, episode_id, quote, start_offset, end_offset, speaker, occurred_at, ingested_at, redaction_reason`,
    [episode_id, finalQuote, start_offset, end_offset, speaker ?? null, occurred_at ?? null, redactionReason],
  );
  return rows[0];
}

// One episode plus its evidence spans, atomic: shared by add-episode's
// single-object and array forms so both take on exactly one commit
// boundary per episode -- a capture event is atomic (a killed pipeline
// must never strand an episode without its spans, a real near-miss on
// 2026-07-13), and in the array form a bad episode must never roll back
// its already-settled neighbors, so this begin/commit never widens beyond
// one episode no matter how it's called.
async function addOneEpisode(client, tables, input) {
  const { source_id, source_locator, raw, occurred_at, occurred_until, evidence } = input;
  if (!raw || !raw.trim()) throw new Error("an episode needs its raw: the whole captured text");
  // Scrubbed BEFORE the insert, always: no update path exists afterward
  // to fix a miss, so an unfiltered write would be permanent (ADR 0002).
  const { text: filtered } = scrubSensitivePatterns(raw);
  await client.query("begin");
  let episodeRow;
  let insertedCount = 0;
  try {
    const { rows } = await client.query(
      `insert into ${tables.episodes} (source_id, source_locator, raw, occurred_at, occurred_until)
       values ($1, $2, $3, $4, $5)
       returning id, source_id, source_locator, raw, occurred_at, occurred_until, ingested_at`,
      [source_id, source_locator ?? null, filtered, occurred_at ?? null, occurred_until ?? null],
    );
    episodeRow = rows[0];
    for (const item of evidence ?? []) {
      await insertEvidenceRow(client, tables, { ...item, episode_id: episodeRow.id });
      insertedCount++;
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { ...episodeRow, evidence_count: insertedCount };
}

async function main() {
  loadEnvLocal();
  const [command, ...args] = process.argv.slice(2);
  const schema = process.env.BRAIN_SCHEMA || "public";
  const tables = schemaTables(schema);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const s = await client.query("select to_regnamespace($1) is not null as exists", [schema]);
    if (!s.rows[0].exists) throw new Error(`schema ${schema} is missing; run npm run db:migrate`);

    if (!command || command === "index") {
      const nodes = (
        await client.query(`select id, type, title, created_at from ${tables.nodes} order by created_at asc`)
      ).rows;
      const edges = (
        await client.query(
          `select e.source, e.target, e.why, s.title as src_title, t.title as tgt_title
           from ${tables.edges} e
           join ${tables.nodes} s on s.id = e.source
           join ${tables.nodes} t on t.id = e.target
           order by e.created_at asc`,
        )
      ).rows;
      const talk = (
        await client.query(`select recap, created_at from ${tables.talks} order by created_at desc limit 1`)
      ).rows[0] ?? null;
      console.log(formatIndex(nodes, edges, talk));
    } else if (command === "show") {
      if (args.length === 0) throw new Error("show needs at least one node id");
      const { rows } = await client.query(
        `select id, type, title, body, raw, created_at from ${tables.nodes} where id = any($1::uuid[])`,
        [args],
      );
      console.log(formatShow(rows));
    } else if (command === "add-node") {
      const { type, title, raw, body } = JSON.parse(await readStdin());
      if (!title) throw new Error("a node needs a title");
      if (!raw || !raw.trim()) throw new Error("a node needs its raw: Tony's verbatim words");
      // A deliberately written thought is its own readable; body falls back to raw.
      const readable = body && body.trim() ? body : raw;
      const { rows } = await client.query(
        `insert into ${tables.nodes} (type, title, body, raw) values ($1, $2, $3, $4) returning id, type, title, created_at`,
        [type ?? "", title, readable, raw],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-edge") {
      const { source, target, why } = JSON.parse(await readStdin());
      // No client-side why check: the CHECK constraint is the one true gate.
      const { rows } = await client.query(
        `insert into ${tables.edges} (source, target, why) values ($1, $2, $3) returning id, source, target, why`,
        [source, target, why],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "set-readable") {
      const [id] = args;
      if (!id) throw new Error("set-readable needs a node id");
      const { body } = JSON.parse(await readStdin());
      if (!body || !body.trim()) throw new Error("set-readable needs a non-empty body: the ratified readable");
      // Only the readable layer is writable; raw has no update path anywhere.
      const { rows, rowCount } = await client.query(
        `update ${tables.nodes} set body = $2 where id = $1 returning id, title, body`,
        [id, body],
      );
      if (rowCount === 0) throw new Error(`no node with id ${id}`);
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-talk") {
      const { recap } = JSON.parse(await readStdin());
      if (!recap || !recap.trim()) throw new Error("a talk needs a recap");
      const { rows } = await client.query(
        `insert into ${tables.talks} (recap) values ($1) returning id, recap, created_at`,
        [recap],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-source") {
      const { kind, label, exclusions } = JSON.parse(await readStdin());
      const list = exclusions ?? [];
      for (const x of list) validateExclusion(x);
      const { rows } = await client.query(
        `insert into ${tables.sources} (kind, label, exclusions) values ($1, $2, $3) returning id, kind, label, exclusions, created_at`,
        [kind, label, JSON.stringify(stampExclusions(list))],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "list-sources") {
      const { rows } = await client.query(
        `select id, kind, label, sync_cursor, last_synced_at, exclusions, created_at from ${tables.sources} order by created_at asc`,
      );
      console.log(JSON.stringify(rows, null, 2));
    } else if (command === "set-exclusions") {
      const [id] = args;
      if (!id) throw new Error("set-exclusions needs a source id");
      const { exclusions } = JSON.parse(await readStdin());
      const list = exclusions ?? [];
      for (const x of list) validateExclusion(x);
      // Full replace, not merge: an ordinary, repeatable config update --
      // not a set-once exception, unlike mark-sender-deleted below.
      const { rows, rowCount } = await client.query(
        `update ${tables.sources} set exclusions = $2 where id = $1 returning id, kind, label, exclusions`,
        [id, JSON.stringify(stampExclusions(list))],
      );
      if (rowCount === 0) throw new Error(`no source with id ${id}`);
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-episode") {
      // Accepts one episode object (unchanged), or an array for batch
      // ingestion -- the wildcard backfill shelled out once per episode,
      // and every spawn paid a fresh TLS handshake on a degraded link
      // (2026-07-16); one process, one connection, many episodes is the
      // whole point. Unlike add-evidence's array form below, each episode
      // here gets its OWN begin/commit (addOneEpisode does this): a bad
      // episode must never roll back its already-settled neighbors, so
      // there is no single all-or-nothing transaction for the batch.
      const input = JSON.parse(await readStdin());
      if (Array.isArray(input)) {
        const results = [];
        for (const item of input) {
          try {
            results.push(await addOneEpisode(client, tables, item));
          } catch (err) {
            results.push({ error: String(err.message).split("\n")[0], source_locator: item.source_locator ?? null });
          }
        }
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(JSON.stringify(await addOneEpisode(client, tables, input), null, 2));
      }
    } else if (command === "add-evidence") {
      // Accepts one span object, or an array of spans for batch ingestion --
      // one write path either way, so the scrub below covers every caller.
      const input = JSON.parse(await readStdin());
      const items = Array.isArray(input) ? input : [input];
      if (items.length === 0) throw new Error("add-evidence got an empty array");
      const inserted = [];
      await client.query("begin");
      try {
        for (const item of items) {
          inserted.push(await insertEvidenceRow(client, tables, item));
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
      console.log(JSON.stringify(Array.isArray(input) ? inserted : inserted[0], null, 2));
    } else if (command === "list-episodes") {
      // Read-only browse: the companion's way into evidence without SQL.
      const [sourceId] = args;
      const where = sourceId ? "where e.source_id = $1" : "";
      const params = sourceId ? [sourceId] : [];
      const { rows } = await client.query(
        `select e.id, e.source_id, s.kind, s.label, e.source_locator, e.occurred_at, e.ingested_at,
                (select count(*)::int from ${tables.evidence} v where v.episode_id = e.id) as evidence_count
         from ${tables.episodes} e join ${tables.sources} s on s.id = e.source_id
         ${where}
         order by e.ingested_at desc`,
        params,
      );
      console.log(JSON.stringify(rows, null, 2));
    } else if (command === "mark-sender-deleted") {
      const [id] = args;
      if (!id) throw new Error("mark-sender-deleted needs an evidence id");
      // The one set-once exception in this whole store: guarded by "is
      // null" so it can only ever fire once per row, and the timestamp is
      // always server-generated -- it records when WE observed the
      // deletion, never a caller-supplied value.
      const { rows, rowCount } = await client.query(
        `update ${tables.evidence} set sender_deleted_at = now() where id = $1 and sender_deleted_at is null returning id, sender_deleted_at`,
        [id],
      );
      if (rowCount === 0) throw new Error(`no evidence with id ${id}, or it was already marked deleted`);
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "show-evidence") {
      const [episodeId] = args;
      if (!episodeId) throw new Error("show-evidence needs an episode id");
      const ep = await client.query(
        `select e.id, e.source_locator, e.raw, e.occurred_at, e.occurred_until, s.kind, s.label
         from ${tables.episodes} e join ${tables.sources} s on s.id = e.source_id
         where e.id = $1`,
        [episodeId],
      );
      if (ep.rowCount === 0) throw new Error(`no episode with id ${episodeId}`);
      const spans = (
        await client.query(
          `select id, quote, start_offset, end_offset, speaker, occurred_at, sender_deleted_at, redaction_reason
           from ${tables.evidence} where episode_id = $1 order by start_offset asc`,
          [episodeId],
        )
      ).rows;
      console.log(formatEvidence(ep.rows[0], { label: ep.rows[0].label, kind: ep.rows[0].kind }, spans));
    } else if (command === "dump") {
      const nodes = (await client.query(`select * from ${tables.nodes} order by created_at asc`)).rows;
      const edges = (await client.query(`select * from ${tables.edges} order by created_at asc`)).rows;
      const talks = (await client.query(`select * from ${tables.talks} order by created_at asc`)).rows;
      console.log(JSON.stringify({ dumped_at: new Date().toISOString(), nodes, edges, talks }, null, 2));
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } finally {
    await client.end();
  }
}

// Only touch the database when run directly; importing for tests must not.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
