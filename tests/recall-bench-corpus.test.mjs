// Covers DESIGN.md section 3.6's gen-corpus.mjs contract: determinism (same tier/config
// in, byte-identical corpus out -- section 1's whole premise depends on this) and the
// record shape from section 3.1/3.2. Structural checks are written directly against the
// documented shape rather than against schemas.mjs's validators, because section 3.6 pins
// gen-corpus.mjs's exports exactly but never names schemas.mjs's own export names.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchRoot = join(repoRoot, "experiments", "recall-bench");
const genCorpusPath = join(benchRoot, "gen-corpus.mjs");
const configPath = join(benchRoot, "config.mjs");

const VALID_KINDS = new Set(["event", "person", "preference", "quote", "place", "project", "note"]);

async function loadFixture() {
  const { generateMemories, buildMemoryIndex, generateQueries, paraphraseOverlapStems } = await import(pathToFileURL(genCorpusPath));
  const { resolveTier } = await import(pathToFileURL(configPath));
  // smoke1k: the smallest tier (section 3.4), so these tests stay fast.
  // resolveTier, not config.tiers.smoke1k: section 3.4 splits a tier's knobs
  // across `tiers` and `corpus`, and the generator needs both halves plus the
  // tier name it seeds its RNG from. Every entry point resolves the same way.
  const tier = resolveTier("smoke1k");
  return { generateMemories, buildMemoryIndex, generateQueries, paraphraseOverlapStems, tier };
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

// The invariant the whole paraphrase_nolex rewrite rests on. gen-corpus's
// --self-check prints these overlaps; nothing asserted them, and an assertion
// is what stops a future frame-table edit from quietly reintroducing a shared
// stem and turning the family back into a lexical test.
test("paraphrase_nolex queries share zero content stems with their target (DESIGN.md 4.2 rule 4)", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, buildMemoryIndex, generateQueries, paraphraseOverlapStems, tier } = await loadFixture();
  const memories = [...generateMemories(tier)];
  const index = buildMemoryIndex(memories);
  const byId = new Map(memories.map((m) => [m.id, m]));

  let checked = 0;
  for (const split of ["dev", "test"]) {
    for (const q of generateQueries(tier, split, index)) {
      if (q.family !== "paraphrase_nolex") continue;
      checked++;
      const target = byId.get(q.targets[0]);
      // Against title + raw + body, not body alone: the fts column is
      // title-A + raw-B + body-C, so a stem shared with the title would
      // revive the lexical lanes this family exists to switch off.
      assert.deepEqual(
        paraphraseOverlapStems(q.text, target),
        [],
        `${q.qid} shares stems with its target -- query "${q.text}"`,
      );
      assert.equal(q.certificate.lexical_overlap, 0, `${q.qid} reports a nonzero lexical_overlap`);
    }
  }
  assert.ok(checked > 0, "the smoke tier must contain paraphrase_nolex queries to check");
});

// A paraphrase has to be about the same event, not merely spelled differently.
// Zero stem overlap is satisfiable by unrelated text -- that is exactly what
// the previous ABSTRACT_* implementation did -- so this pins the other half:
// both sides come from one frame, and the query only names slots the body kept.
test("paraphrase_nolex queries verbalize the same frame their target was rendered from", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, buildMemoryIndex, generateQueries, tier } = await loadFixture();
  const { PARAPHRASE_DOMAINS } = await import(pathToFileURL(join(benchRoot, "lib", "lexicon.mjs")));
  const memories = [...generateMemories(tier)];
  const index = buildMemoryIndex(memories);
  const byId = new Map(memories.map((m) => [m.id, m]));

  for (const q of generateQueries(tier, "dev", index)) {
    if (q.family !== "paraphrase_nolex") continue;
    const frame = q.diagnostics.regen?.frame;
    assert.ok(frame, `${q.qid} must carry its frame so the repair loop can re-verbalize it`);
    const domain = PARAPHRASE_DOMAINS[frame.domainIdx];
    const target = byId.get(q.targets[0]);
    assert.equal(target.tags[0], domain.slug, `${q.qid} target should be tagged with its frame's domain`);
    assert.ok(
      target.body.includes(domain.actions[frame.actionIdx].a),
      `${q.qid} target body must render the frame's A-side action`,
    );
    assert.ok(
      q.text.includes(domain.actions[frame.actionIdx].b),
      `${q.qid} query must render the SAME frame's B-side action`,
    );
    for (const slot of frame.present) {
      if (slot === "time") continue;
      const pair = { action: domain.actions[frame.actionIdx], prop: domain.props[frame.propIdx],
        mishap: domain.mishaps[frame.mishapIdx], detail: domain.details[frame.detailIdx] }[slot];
      // Sentence-initial slots are rendered capitalized, so compare lowercased.
      if (pair) {
        assert.ok(
          target.body.toLowerCase().includes(pair.a.toLowerCase()),
          `${q.qid} body should carry its declared ${slot} slot`,
        );
      }
    }
  }
});

// generateMemories is memoized per process, so run-to-run equality inside one
// process is satisfied by the cache rather than by the seeding. Two separate
// node invocations agreeing is the check that actually covers the RNG call
// sites -- and those moved when the confusion-set families switched to a
// shared fork label.
test("generateMemories is deterministic ACROSS processes, not just within one", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const script = `
    const { generateMemories } = await import(${JSON.stringify(pathToFileURL(genCorpusPath).href)});
    const { resolveTier } = await import(${JSON.stringify(pathToFileURL(configPath).href)});
    process.stdout.write(JSON.stringify([...generateMemories(resolveTier("smoke1k"))]));
  `;
  const runOnce = () => {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { maxBuffer: 1 << 28 });
    // Guard against the degenerate pass: two empty outputs also hash equal.
    assert.ok(out.length > 100_000, `child process produced only ${out.length} bytes of corpus`);
    return createHash("sha256").update(out).digest("hex");
  };
  assert.equal(runOnce(), runOnce(), "the same seed must produce a byte-identical corpus in a fresh process");
});

// Pins the trigram extraction against pg_trgm's real behaviour, read off the
// running cluster with `select show_trgm('the skilet and garlic')`. Every
// trigram-lane bound in gen-corpus.mjs is only sound if these sets match what
// Postgres builds, and the previous implementation padded the whole string
// once -- inventing cross-word trigrams like "e s" that pg never produces.
test("charTrigrams matches pg_trgm's show_trgm, which every trigram bound rests on", async (t) => {
  if (!existsSync(genCorpusPath)) {
    t.skip("gen-corpus.mjs not landed yet");
    return;
  }
  const { charTrigrams, wordSimilarityBounds } = await import(pathToFileURL(genCorpusPath));

  // show_trgm('the skilet and garlic') on Postgres 17 with pg_trgm:
  const expected = [
    "  a", "  g", "  s", "  t", " an", " ga", " sk", " th", "and", "arl",
    "et ", "gar", "he ", "ic ", "ile", "kil", "let", "lic", "nd ", "rli",
    "ski", "the",
  ].sort();
  assert.deepEqual([...charTrigrams("the skilet and garlic")].sort(), expected);
  assert.equal([...charTrigrams("kbz-4417")].sort().join("|"), ["  4", "  k", " 44", " kb", "17 ", "417", "441", "bz ", "kbz"].sort().join("|"),
    "pg_trgm splits on non-alphanumerics, so a rare token is two words, not one");

  // The bounds must bracket: lower <= upper, and an unrelated document must
  // not clear the 0.3 lane threshold on shared stopwords alone.
  const related = wordSimilarityBounds("the skilet and the garlic", "a b c the skillet and the garlic d e f");
  assert.ok(related.lower <= related.upper, "the lower bound cannot exceed the upper bound");
  assert.ok(related.lower >= 0.5, `a near-exact match should score high, got ${related.lower}`);
  const unrelated = wordSimilarityBounds("the skilet and the garlic", "totally unrelated words about puppies and leashes here");
  assert.ok(unrelated.upper < 0.5, `an unrelated document should not look like a match, got ${unrelated.upper}`);
});
