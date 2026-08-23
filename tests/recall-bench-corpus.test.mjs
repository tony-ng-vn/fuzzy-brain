// Covers DESIGN.md section 3.6's gen-corpus.mjs contract: determinism (same tier/config
// in, byte-identical corpus out -- section 1's whole premise depends on this) and the
// record shape from section 3.1/3.2. Structural checks are written directly against the
// documented shape rather than against schemas.mjs's validators, because section 3.6 pins
// gen-corpus.mjs's exports exactly but never names schemas.mjs's own export names.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = join(repoRoot, "experiments", "recall-bench");
const genCorpusPath = join(benchRoot, "gen-corpus.mjs");
const configPath = join(benchRoot, "config.mjs");

const VALID_KINDS = new Set(["event", "person", "preference", "quote", "place", "project", "note"]);

async function loadFixture() {
  const { generateMemories, buildMemoryIndex, generateQueries } = await import(pathToFileURL(genCorpusPath));
  const { resolveTier } = await import(pathToFileURL(configPath));
  // smoke1k: the smallest tier (section 3.4), so these tests stay fast.
  // resolveTier, not config.tiers.smoke1k: section 3.4 splits a tier's knobs
  // across `tiers` and `corpus`, and the generator needs both halves plus the
  // tier name it seeds its RNG from. Every entry point resolves the same way.
  const tier = resolveTier("smoke1k");
  return { generateMemories, buildMemoryIndex, generateQueries, tier };
}

test("config.mjs and gen-corpus.mjs land as the frozen contract this suite depends on", () => {
  assert.equal(existsSync(configPath), true, "config.mjs is Track 0's contract; see DESIGN.md section 3.4");
  assert.equal(existsSync(genCorpusPath), true, "gen-corpus.mjs is Track 2's generator; see DESIGN.md section 3.6");
});

test("generateMemories is deterministic for a fixed tier", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, tier } = await loadFixture();

  const runA = [...generateMemories(tier)];
  const runB = [...generateMemories(tier)];

  assert.equal(runA.length, tier.memories, "generator must emit exactly tier.memories records");
  assert.deepEqual(runA, runB, "same tier/config must produce byte-identical output (DESIGN.md section 1)");
});

test("memory records match the documented shape and are dense-id (DESIGN.md section 3.1)", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, tier } = await loadFixture();
  const memories = [...generateMemories(tier)];
  const seenIds = new Set();

  for (const m of memories) {
    assert.equal(Number.isInteger(m.id), true, `id must be an int, got ${m.id}`);
    seenIds.add(m.id);
    assert.equal(VALID_KINDS.has(m.kind), true, `unexpected kind: ${m.kind}`);
    assert.equal(typeof m.title, "string");
    assert.ok(m.title.length > 0, "title must be non-empty");
    assert.equal(typeof m.body, "string");
    assert.ok(
      m.body.length >= tier.bodyChars[0] && m.body.length <= tier.bodyChars[1],
      `body length ${m.body.length} outside tier band [${tier.bodyChars[0]}, ${tier.bodyChars[1]}]`,
    );
    assert.equal(typeof m.raw, "string");
    assert.ok(m.raw.length > 0, "raw must be non-empty");
    assert.ok(Array.isArray(m.people));
    assert.ok(Array.isArray(m.places));
    assert.ok(Array.isArray(m.tags));
    assert.equal(typeof m.occurred_at, "string");
    assert.ok(!Number.isNaN(Date.parse(m.occurred_at)), "occurred_at must be ISO-parseable");
    assert.equal(Number.isInteger(m.cluster_id), true);
    assert.ok(m.dup_group === null || Number.isInteger(m.dup_group), "dup_group must be int or null");
    assert.ok(m.rare_token === null || typeof m.rare_token === "string", "rare_token must be string or null");
    assert.ok(
      m.distinguisher === null || typeof m.distinguisher === "string",
      "distinguisher must be string or null",
    );
  }

  assert.equal(seenIds.size, memories.length, "ids must be unique");
  const sortedIds = [...seenIds].sort((a, b) => a - b);
  assert.deepEqual(
    sortedIds,
    Array.from({ length: memories.length }, (_, i) => i + 1),
    "ids must be dense 1..N",
  );
});

test("generated queries carry a solvable certificate and only target real memory ids (DESIGN.md section 4.2)", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, buildMemoryIndex, generateQueries, tier } = await loadFixture();

  const memories = [...generateMemories(tier)];
  const index = buildMemoryIndex(memories);
  const queries = generateQueries(tier, "dev", index);
  const memoryIds = new Set(memories.map((m) => m.id));

  assert.ok(queries.length > 0, "dev split must produce queries");
  for (const q of queries) {
    assert.equal(q.split, "dev");
    assert.ok(Array.isArray(q.targets) && q.targets.length > 0, `${q.qid} must carry at least one target`);
    for (const targetId of q.targets) {
      assert.ok(memoryIds.has(targetId), `${q.qid} targets memory ${targetId}, which does not exist in the corpus`);
    }
    assert.equal(q.certificate.solvable, true, `${q.qid} must be certified solvable`);
  }
});
