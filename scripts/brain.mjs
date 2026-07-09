// The brain companion's read/write tool. One place so a talking session never
// hand-rolls SQL or env loading. Reads: `index` (the whole brain, gist only)
// and `show <id...>` (full node bodies). Writes: `add-node` and `add-edge`,
// each reading one JSON object from stdin so bodies and whys keep their
// newlines and quotes intact. The database CHECK on `why` is the final gate
// (AGENTS.md rule 4); this tool never works around it.
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
export function formatIndex(nodes, edges) {
  const lines = [`BRAIN INDEX  nodes=${nodes.length} edges=${edges.length}`, ""];
  lines.push("NODES");
  for (const n of nodes) {
    const date = isoDate(n.created_at);
    lines.push(`  ${date}  ${n.type || "(untyped)"}  ${n.title}`);
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

/** Full text of specific nodes: the words, pulled only when a thought lands. */
export function formatShow(nodes) {
  return nodes
    .map((n) => {
      const date = isoDate(n.created_at);
      return `[${n.type || "(untyped)"}] ${n.title}  (${date})\n${n.id}\n\n${n.body}`;
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
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
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
      console.log(formatIndex(nodes, edges));
    } else if (command === "show") {
      if (args.length === 0) throw new Error("show needs at least one node id");
      const { rows } = await client.query(
        "select id, type, title, body, created_at from nodes where id = any($1::uuid[])",
        [args],
      );
      console.log(formatShow(rows));
    } else if (command === "add-node") {
      const { type, title, body } = JSON.parse(await readStdin());
      if (!title) throw new Error("a node needs a title");
      const { rows } = await client.query(
        "insert into nodes (type, title, body) values ($1, $2, $3) returning id, type, title, created_at",
        [type ?? "", title, body ?? ""],
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
