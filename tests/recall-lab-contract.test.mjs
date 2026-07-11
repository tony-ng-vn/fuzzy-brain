import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lab = join(root, "experiments", "polygres-recall-lab");
const schemaPath = join(lab, "schema.sql");
const seedPath = join(lab, "seed.sql");
const runnerPath = join(lab, "run.mjs");
const nativePgGraphPath = join(lab, "native-pggraph.sql");

test("the isolated recall lab has schema, seed, and runner files", () => {
  assert.equal(existsSync(schemaPath), true, "create the lab schema");
  assert.equal(existsSync(seedPath), true, "create the synthetic fixture");
  assert.equal(existsSync(runnerPath), true, "create the lab runner");
});

test("the lab schema models evidence, claims, indexes, resolution paths, and traces", () => {
  if (!existsSync(schemaPath)) return;
  const sql = readFileSync(schemaPath, "utf8");

  for (const table of [
    "recall_lab_episodes",
    "recall_lab_evidence_spans",
    "recall_lab_entities",
    "recall_lab_claims",
    "recall_lab_meaning_edges",
    "recall_lab_search_documents",
    "recall_lab_resolution_paths",
    "recall_lab_search_traces",
    "recall_lab_search_trace_steps",
  ]) {
    assert.match(sql, new RegExp(`brain_dev\\.${table}`));
  }

  assert.match(sql, /embedding vector\(8\)/);
  assert.match(sql, /to_tsvector/);
  assert.match(sql, /valid_from/);
  assert.match(sql, /valid_to/);
  assert.match(sql, /authority/);
  assert.match(sql, /evidence_span_id/);
  assert.doesNotMatch(sql, /(?:insert|update|delete|truncate|drop|alter|create)\s+(?:table\s+)?public\./i);
  assert.doesNotMatch(sql, /create\s+extension/i, "the lab must use installed extensions, not mutate them");
});

test("the fixture is synthetic, idempotent, and confined to lab tables", () => {
  if (!existsSync(seedPath)) return;
  const sql = readFileSync(seedPath, "utf8");
  assert.match(sql, /on conflict/i);
  assert.match(sql, /Safford/);
  assert.match(sql, /partner_of/);
  assert.match(sql, /lives_in/);
  assert.match(sql, /located_in/);
  assert.doesNotMatch(sql, /public\./i);
});

test("the runner refuses non-sandbox writes and verifies public counts are unchanged", () => {
  if (!existsSync(runnerPath)) return;
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /brain_dev/);
  assert.match(source, /publicBefore/);
  assert.match(source, /publicAfter/);
  assert.match(source, /public brain changed/i);
  assert.doesNotMatch(source, /set\s+search_path\s+to\s+public/i);
});

test("the disposable pgGraph probe uses a named graph and edge-table labels", () => {
  assert.equal(existsSync(nativePgGraphPath), true, "create the native pgGraph probe");
  if (!existsSync(nativePgGraphPath)) return;

  const sql = readFileSync(nativePgGraphPath, "utf8");
  assert.match(sql, /recall_lab_native\.entities/);
  assert.match(sql, /recall_lab_native\.claim_edges/);
  assert.match(sql, /graph\.create_graph\(/);
  assert.match(sql, /graph\.add_table_to_graph\(/);
  assert.match(sql, /graph\.add_edge_to_graph\(/);
  assert.match(sql, /label_column\s*(?::=|=>)\s*'predicate'/);
  assert.match(sql, /graph\.build_graph\(/);
  assert.match(sql, /graph\.set_current_graph\(/);
  assert.match(sql, /graph\.traverse\(/);
  assert.match(sql, /graph\.gql\(/);
  assert.match(sql, /RETURN a, r, b/);
  assert.match(sql, /why text NOT NULL/);
  assert.match(sql, /evidence text NOT NULL/);
  assert.doesNotMatch(sql, /(?:insert|update|delete|truncate|drop|alter|create)\s+(?:table\s+)?public\./i);
});
