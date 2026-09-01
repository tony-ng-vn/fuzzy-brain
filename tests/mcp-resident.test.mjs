// The resident-server seam: recall as an importable function, and the pool
// the MCP server borrows connections from. Both exist because answering a
// question used to cost a fresh Node process and a fresh load of the nomic
// embedding model -- about 1.9 seconds before any searching started. A
// process that lives has to hold its connections and its model correctly, so
// these cover the two ways that goes wrong: a leaked or poisoned connection,
// and a model torn down between questions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recall } from "../scripts/recall.mjs";
import { productionServices, residentPool } from "../scripts/fuzzy-brain-mcp.mjs";
import { LruCache, embedQueryCached } from "../scripts/lib/embeddings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const NODE_ID = "11111111-1111-4111-8111-111111111111";

// One node row, answered to every node lane. The statements are told apart
// by text unique to each -- the vocab probe, the fused lane statement (rows
// come back tagged with a `lane` column), the hop statement, and the
// per-lane fallback shapes -- which is enough to drive recall end to end
// without a database.
function fakeBrain({ nodeRows = [], evidenceRows = [] } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql) {
      seen.push(sql);
      if (sql.includes("as total")) return { rows: [{ term: "walnut", total: 20, df: 1 }] };
      if (sql.includes(" as lane")) {
        return {
          rows: [
            ...nodeRows.map((row) => ({ lane: "and:node", ...row })),
            ...evidenceRows.map((row) => ({ lane: "and:evidence", ...row })),
          ],
        };
      }
      if (sql.includes(" as kind")) return { rows: [] };
      if (sql.includes(".edges")) return { rows: [] };
      if (sql.includes(".nodes n")) return { rows: nodeRows };
      return { rows: evidenceRows };
    },
  };
}

const NODE_ROW = Object.freeze({
  id: NODE_ID,
  type: "story",
  title: "the walnut desk restoration",
  body: "one long afternoon of tidying produced it",
  created_at: "2026-07-01T00:00:00.000Z",
  occurred_at: "2026-07-01T00:00:00.000Z",
  lane_score: 0.9,
  sim: 0.82,
  rare_hit: false,
});

test("recall returns the documented shape without a CLI in the middle", async () => {
  const client = fakeBrain({ nodeRows: [NODE_ROW] });
  const result = await recall("what is the walnut desk restoration", {
    client,
    schema: "brain_dev",
    embedQuery: async () => new Array(768).fill(0.1),
  });

  assert.deepEqual(Object.keys(result), ["question", "state", "note", "hits"]);
  assert.equal(result.question, "what is the walnut desk restoration");
  assert.equal(result.state, "supported");
  assert.equal(result.note, "ratified brain truth; the nodes below carry it");
  assert.equal(result.hits.length, 1);
  assert.deepEqual(Object.keys(result.hits[0]).sort(), [
    "body", "created_at", "edges", "layer", "node_id", "score", "title", "type", "via_edge",
  ]);
  assert.equal(result.hits[0].node_id, NODE_ID);
  assert.equal(result.hits[0].layer, "node");
});

test("recall says so in the note when the model cannot load, and still answers", async () => {
  const result = await recall("what is the walnut desk restoration", {
    client: fakeBrain({ nodeRows: [NODE_ROW] }),
    schema: "brain_dev",
    embedQuery: async () => {
      throw new Error("weights are missing");
    },
  });
  assert.match(result.note, /vector lane unavailable \(weights are missing\); text lanes only/);
  assert.equal(result.hits.length, 1);
});

// The regression this exists to catch: a call that disposed the model would
// put the whole load back on every question the resident server answers.
test("only the recall CLI tears the embedding model down", () => {
  const source = readFileSync(join(root, "scripts", "recall.mjs"), "utf8");
  const calls = [...source.matchAll(/disposeEmbeddingModel\(\)/g)];
  assert.equal(calls.length, 1, "the model is disposed in exactly one place");
  const main = source.slice(source.indexOf("async function main()"));
  assert.match(main, /disposeEmbeddingModel\(\)/, "and that place is the CLI's own exit path");
});

test("a repeated question in one process skips the model entirely", async () => {
  // The bounded LRU has always been there; a process that answered one
  // question and exited could never hit it.
  const cache = new LruCache(8);
  let inferences = 0;
  const embedQuery = (text) => embedQueryCached(text, {
    cache,
    embedFn: async () => {
      inferences++;
      return new Array(768).fill(0.1);
    },
  });

  for (let i = 0; i < 3; i++) {
    await recall("who is doan", { client: fakeBrain(), schema: "brain_dev", embedQuery });
  }
  assert.equal(inferences, 1);
});

function fakePool() {
  const handlers = new Map();
  const state = { opens: 0, connects: 0, releases: 0, ends: 0 };
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => state.releases++ };
  const pool = {
    state,
    client,
    on: (event, handler) => handlers.set(event, handler),
    emit: (event, value) => handlers.get(event)?.(value),
    connect: async () => {
      state.connects++;
      return client;
    },
    end: async () => {
      state.ends++;
    },
  };
  return pool;
}

test("the resident pool opens once, lazily, and hands every call the same connection", async () => {
  const pool = fakePool();
  let opens = 0;
  const reads = residentPool({
    open: () => {
      opens++;
      return pool;
    },
  });

  assert.equal(opens, 0, "building the services must not touch the network");
  const first = await reads.withClient(async (client) => client);
  const second = await reads.withClient(async (client) => client);
  assert.equal(opens, 1);
  assert.equal(first, second);
  assert.equal(pool.state.connects, 2);
  assert.equal(pool.state.releases, 2, "every borrowed client goes back");

  await reads.close();
  assert.equal(pool.state.ends, 1);
});

test("a failed call gives its connection back, and the next call still runs", async () => {
  const pool = fakePool();
  const reads = residentPool({ open: () => pool });

  await assert.rejects(
    reads.withClient(async () => {
      throw new Error("no node with id 11111111-1111-4111-8111-111111111111");
    }),
    /no node with id/,
  );
  assert.equal(pool.state.releases, 1);

  assert.equal(await reads.withClient(async () => "answered"), "answered");
  assert.equal(pool.state.releases, 2);
});

test("an idle connection dying is logged, not thrown at the server", async () => {
  const pool = fakePool();
  const logged = [];
  const reads = residentPool({ open: () => pool, logError: (error) => logged.push(error) });

  await reads.withClient(async () => null);
  pool.emit("error", new Error("connection terminated unexpectedly"));
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /connection terminated/);
});

test("the read services answer on the pooled connection instead of spawning", async () => {
  const pool = fakePool();
  const borrowed = [];
  const services = productionServices({
    pool: {
      withClient: async (fn) => {
        borrowed.push(pool.client);
        return fn(pool.client);
      },
      close: async () => pool.end(),
    },
  });

  const reminders = await services.listReminders("2026-08-06T23:30:00Z");
  assert.equal(reminders.at, "2026-08-06T23:30:00.000Z");
  assert.deepEqual(reminders.overdue, []);
  await assert.rejects(services.getNode(NODE_ID), /no node with id/);

  assert.deepEqual(borrowed, [pool.client, pool.client]);
  await services.close();
  assert.equal(pool.state.ends, 1);
});
