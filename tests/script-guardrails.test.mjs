// Guardrails against the hang-forever class: every DB client carries
// timeouts, every shell-out to brain.mjs carries a timeout, and the embed
// sweep can never loop without making progress. These exist because one
// degraded link silently stalled the whole ingest pipeline for hours
// (2026-07-16) -- a hang gives the operator nothing, a loud failure
// lands in counters the idempotent pipelines already know how to retry.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { CLIENT_GUARDRAILS, makeClient } = await import(pathToFileURL(join(root, "scripts", "brain.mjs")));
const { CLI_EXEC_OPTS } = await import(pathToFileURL(join(root, "scripts", "lib", "brain-cli.mjs")));
const { sweepTable } = await import(pathToFileURL(join(root, "scripts", "embed-sweep.mjs")));

const FAKE_URL = "postgresql://user:pw@host:5432/db";

test("makeClient: every client is born with connect and query timeouts", () => {
  const client = makeClient({ connectionString: FAKE_URL });
  const p = client.connectionParameters;
  assert.equal(p.query_timeout, CLIENT_GUARDRAILS.query_timeout);
  assert.ok(CLIENT_GUARDRAILS.query_timeout > 0);
  // Client-side only: the Polygres pooler rejects statement_timeout as a
  // startup parameter, so it must never reappear in the guardrails.
  assert.ok(!("statement_timeout" in CLIENT_GUARDRAILS));
  assert.ok(!p.statement_timeout);
  assert.ok(CLIENT_GUARDRAILS.connectionTimeoutMillis > 0);
  assert.ok(CLIENT_GUARDRAILS.connectionTimeoutMillis <= 30_000);
  assert.equal(p.keepalives, 1);
});

test("makeClient: callers with a real reason can lift a guardrail", () => {
  // migrate.mjs disables the query cap: a fresh HNSW index build is
  // legitimately slow and must not be killed mid-DDL.
  const client = makeClient({ connectionString: FAKE_URL, query_timeout: 0 });
  // pg normalizes a 0 cap to false; either way means "no cap".
  assert.ok(!client.connectionParameters.query_timeout);
});

test("brain-cli: shell-outs to brain.mjs carry a timeout and the batch-sized buffer", () => {
  assert.ok(CLI_EXEC_OPTS.timeout > 0);
  assert.ok(CLI_EXEC_OPTS.timeout <= 10 * 60 * 1000);
  assert.ok(CLI_EXEC_OPTS.maxBuffer >= 64 * 1024 * 1024);
});

test("brain-cli uses the absolute current Node executable for launchd", async () => {
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(join(root, "scripts", "lib", "brain-cli.mjs"), "utf8"),
  );
  assert.match(source, /execFileSync\(process\.execPath/);
  assert.doesNotMatch(source, /execFileSync\(["']node["']/);
});

test("sweepTable: fills null rows and stops when the table is drained", async () => {
  const embedCalls = [];
  const updates = [];
  const client = {
    query: async (sql, params) => {
      if (sql === "SELECT_NULLS") {
        return updates.length === 0
          ? { rows: [{ id: "a", quote: "long quote here" }, { id: "b", quote: "hi" }] }
          : { rows: [] };
      }
      updates.push(params);
      return { rowCount: params[0].length };
    },
  };
  const filled = await sweepTable(client, {
    label: "evidence",
    selectSql: "SELECT_NULLS",
    updateSql: "UPDATE_FILL",
    toText: (r) => r.quote,
    limit: null,
    embed: async (texts) => {
      embedCalls.push(texts);
      return texts.map(() => [0.1, 0.2]);
    },
  });
  assert.equal(filled, 2);
  assert.equal(updates.length, 1);
  // Length-sorted before embedding, with one document per inference call.
  assert.deepEqual(embedCalls, [["hi"], ["long quote here"]]);
});

test("sweepTable: stops instead of spinning when pages make no progress", async () => {
  // Another sweeper owning every row (updates all no-op on the null guard)
  // used to mean this loop re-selected the same page forever.
  let selects = 0;
  const client = {
    query: async (sql) => {
      if (sql === "SELECT_NULLS") {
        selects++;
        return { rows: [{ id: "a", quote: "contested row" }] };
      }
      return { rowCount: 0 };
    },
  };
  const filled = await sweepTable(client, {
    label: "evidence",
    selectSql: "SELECT_NULLS",
    updateSql: "UPDATE_FILL",
    toText: (r) => r.quote,
    limit: null,
    embed: async (texts) => texts.map(() => [0.1, 0.2]),
  });
  assert.equal(filled, 0);
  assert.ok(selects <= 3, `expected the no-progress guard to stop the loop, saw ${selects} selects`);
});
