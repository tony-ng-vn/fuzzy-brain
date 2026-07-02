// Temporary visual-QA seed: inserts clearly-marked test nodes/edges,
// or deletes them all with --clean. Not part of the brain ritual.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  if (process.argv.includes("--clean")) {
    const res = await client.query("delete from nodes where title like '[test]%'");
    console.log(`deleted ${res.rowCount} test nodes (edges cascade)`);
  } else {
    const specs = [
      ["story", "[test] First startup failed", "Body of a test story."],
      ["lesson", "[test] Ship before ready", "Body of a test lesson."],
      ["quote", "[test] Life is an abstraction", "Body of a test quote."],
      ["event", "[test] Moved to the US", "Body of a test event."],
      ["person", "[test] A good friend", "Body of a test person."],
      ["story", "[test] The Adrianna call", "Body of another test story."],
    ];
    const ids = [];
    for (const [type, title, body] of specs) {
      const { rows } = await client.query(
        "insert into nodes (type, title, body) values ($1, $2, $3) returning id",
        [type, title, body],
      );
      ids.push(rows[0].id);
    }
    const edgeSpecs = [
      [0, 1, "The failure is where the lesson came from."],
      [1, 2, "Shipping early is the practical form of the abstraction."],
      [3, 0, "Moving countries set the stage for the first startup."],
      [4, 5, "This friend was on the call."],
      [2, 5, "The call circled the same abstraction idea."],
    ];
    for (const [a, b, why] of edgeSpecs) {
      await client.query("insert into edges (source, target, why) values ($1, $2, $3)", [
        ids[a],
        ids[b],
        why,
      ]);
    }
    console.log(`seeded ${ids.length} test nodes, ${edgeSpecs.length} test edges`);
  }
} finally {
  await client.end();
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
