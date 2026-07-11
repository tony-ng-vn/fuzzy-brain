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
  });
  assert.throws(() => schemaTables("brain_dev; drop schema public"), /invalid BRAIN_SCHEMA/);
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
