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

async function main() {
  loadEnvLocal();
  const [command, ...args] = process.argv.slice(2);
  const schema = process.env.BRAIN_SCHEMA || "public";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid BRAIN_SCHEMA: ${schema}`);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`set search_path to ${schema}`);
    const s = await client.query("select current_schema() as s");
    if (s.rows[0].s !== schema) throw new Error(`schema ${schema} is missing; run npm run db:migrate`);

    if (!command || command === "index") {
      const nodes = (
        await client.query("select id, type, title, created_at from nodes order by created_at asc")
      ).rows;
      const edges = (
        await client.query(
          `select e.source, e.target, e.why, s.title as src_title, t.title as tgt_title
           from edges e
           join nodes s on s.id = e.source
           join nodes t on t.id = e.target
           order by e.created_at asc`,
        )
      ).rows;
      const talk = (
        await client.query("select recap, created_at from talks order by created_at desc limit 1")
      ).rows[0] ?? null;
      console.log(formatIndex(nodes, edges, talk));
    } else if (command === "show") {
      if (args.length === 0) throw new Error("show needs at least one node id");
      const { rows } = await client.query(
        "select id, type, title, body, raw, created_at from nodes where id = any($1::uuid[])",
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
        "insert into nodes (type, title, body, raw) values ($1, $2, $3, $4) returning id, type, title, created_at",
        [type ?? "", title, readable, raw],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-edge") {
      const { source, target, why } = JSON.parse(await readStdin());
      // No client-side why check: the CHECK constraint is the one true gate.
      const { rows } = await client.query(
        "insert into edges (source, target, why) values ($1, $2, $3) returning id, source, target, why",
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
        "update nodes set body = $2 where id = $1 returning id, title, body",
        [id, body],
      );
      if (rowCount === 0) throw new Error(`no node with id ${id}`);
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "add-talk") {
      const { recap } = JSON.parse(await readStdin());
      if (!recap || !recap.trim()) throw new Error("a talk needs a recap");
      const { rows } = await client.query(
        "insert into talks (recap) values ($1) returning id, recap, created_at",
        [recap],
      );
      console.log(JSON.stringify(rows[0], null, 2));
    } else if (command === "dump") {
      const nodes = (await client.query("select * from nodes order by created_at asc")).rows;
      const edges = (await client.query("select * from edges order by created_at asc")).rows;
      const talks = (await client.query("select * from talks order by created_at asc")).rows;
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
