// Guards experiments/recall-bench/DESIGN.md section 0: the harness must never be able to
// reach the managed brain. This mirrors tests/sandbox-routing.test.mjs's audit-by-grep
// discipline, applied to the bench tree instead of scripts/.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = join(repoRoot, "experiments", "recall-bench");
const safetyPath = join(benchRoot, "lib", "safety.mjs");
const SAFETY_RELATIVE = join("lib", "safety.mjs");
// config.mjs's own frozen shape (DESIGN.md section 3.4) reads process.env.BENCH_DATABASE_URL,
// a deliberately distinct env var whose name happens to contain the substring "DATABASE_URL".
// The forbidden literal is the bare managed-brain var, so the match excludes that prefix
// rather than flagging the sanctioned bench var as a violation.
const FORBIDDEN_PATTERNS = [/(?<!BENCH_)DATABASE_URL/, /\.env\.local/];
const SKIP_DIRS = new Set([".data", ".out", "node_modules"]);

function walkMjsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // benchRoot itself may not exist yet on a fresh checkout of this branch
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMjsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

test("no .mjs file under experiments/recall-bench references DATABASE_URL or .env.local, outside lib/safety.mjs", () => {
  const files = walkMjsFiles(benchRoot);
  const offenders = [];

  for (const file of files) {
    const rel = relative(benchRoot, file);
    if (rel === SAFETY_RELATIVE) continue; // the allowlist file is the one legitimate mention
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(source)) offenders.push(`${rel}: matches ${pattern}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these bench files must not reference the managed database:\n${offenders.join("\n")}`,
  );
});

test("assertBenchTarget accepts only 127.0.0.1|localhost:55433/recallbench", async (t) => {
  if (!existsSync(safetyPath)) {
    t.skip("lib/safety.mjs not landed yet (Track 0)");
    return;
  }

  const { assertBenchTarget } = await import(pathToFileURL(safetyPath));

  assert.doesNotThrow(() => assertBenchTarget("postgres://bench:bench@127.0.0.1:55433/recallbench"));
  assert.doesNotThrow(() => assertBenchTarget("postgres://bench:bench@localhost:55433/recallbench"));

  // wrong host
  assert.throws(() => assertBenchTarget("postgres://bench:bench@example.com:55433/recallbench"));
  // wrong port (including the managed Polygres default)
  assert.throws(() => assertBenchTarget("postgres://bench:bench@127.0.0.1:5432/recallbench"));
  // wrong database name
  assert.throws(() => assertBenchTarget("postgres://bench:bench@127.0.0.1:55433/postgres"));
  // a plausible-looking managed-brain URL must not slip through
  assert.throws(() => assertBenchTarget("postgres://user:pass@db.example-neon.tech:5432/polygres"));
  // garbage input must throw, not connect
  assert.throws(() => assertBenchTarget("not a connection string"));
});
