import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("brain table names are explicitly schema-qualified", async () => {
  const brainPath = join(root, "scripts", "brain.mjs");
  const source = readFileSync(brainPath, "utf8");
  assert.match(source, /export function schemaTables/);
  const { schemaTables } = await import(pathToFileURL(brainPath));
  assert.deepEqual(schemaTables("brain_dev"), {
    nodes: '"brain_dev".nodes',
    edges: '"brain_dev".edges',
    talks: '"brain_dev".talks',
    sources: '"brain_dev".sources',
    episodes: '"brain_dev".episodes',
    evidence: '"brain_dev".evidence',
  });
  assert.throws(() => schemaTables("brain_dev; drop schema public"), /invalid BRAIN_SCHEMA/);
});

test("evidence-store tables have no delete path, and only one named update path each", () => {
  const source = readFileSync(join(root, "scripts", "brain.mjs"), "utf8");

  // No delete, ever, on any of the three evidence-store tables.
  assert.doesNotMatch(source, /delete\s+from\s+\$\{tables\.(?:sources|episodes|evidence)\}/i);

  // Every update statement touching these tables must match an allowlist:
  // episodes never has one; evidence's only legal update is the set-once
  // sender_deleted_at; sources' only legal Phase 1 update is exclusions.
  const updates = [
    ...source.matchAll(/update\s+\$\{tables\.(sources|episodes|evidence)\}\s+set\s+([\s\S]*?)\s+where/gi),
  ];
  assert.ok(updates.length > 0, "expected set-exclusions and mark-sender-deleted's update statements");

  for (const [, table, setClause] of updates) {
    if (table === "episodes") {
      assert.fail(`episodes must never have an update path; found: set ${setClause}`);
    } else if (table === "evidence") {
      assert.match(
        setClause.trim(),
        /^sender_deleted_at\s*=\s*now\(\)$/i,
        `evidence's only legal update is sender_deleted_at = now(); found: set ${setClause}`,
      );
    } else if (table === "sources") {
      assert.match(
        setClause.trim(),
        /^exclusions\s*=\s*\$\d/,
        `sources' only legal Phase 1 update is exclusions; found: set ${setClause}`,
      );
    }
  }

  // The one evidence update must be guarded so it can only ever fire once.
  assert.match(
    source,
    /set\s+sender_deleted_at\s*=\s*now\(\)\s+where\s+id\s*=\s*\$1\s+and\s+sender_deleted_at\s+is\s+null/is,
  );
});

test("migrations bind search_path inside a transaction for pooled connections", () => {
  const source = readFileSync(join(root, "scripts", "migrate.mjs"), "utf8");
  assert.match(source, /begin/);
  assert.match(source, /set local search_path/i);
  assert.match(source, /applySchema\("brain_dev"/);
  assert.match(source, /applySchema\("public"/);
});

test("the visual seed writes explicitly to brain_dev tables", () => {
  const source = readFileSync(join(root, "scripts", "seed-test.mjs"), "utf8");
  assert.doesNotMatch(source, /set search_path/i);
  assert.match(source, /brain_dev\.nodes/);
  assert.match(source, /brain_dev\.edges/);
  assert.doesNotMatch(source, /(?:insert into|delete from)\s+nodes\b/i);
  assert.doesNotMatch(source, /insert into\s+edges\b/i);
});

test("the package declares ESM for the TypeScript modules imported by node tests", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.type, "module");
});
