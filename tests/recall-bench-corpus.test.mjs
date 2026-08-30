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

// The two quality50k tests below each build the full 50,000-memory corpus (one
// of them twice more in child processes), minutes of single-core work per run.
// They run only under `npm run test:heavy` so the default suite stays cheap and
// parallel agent runs cannot peg every core on the same generator.
const HEAVY = process.env.RECALL_BENCH_HEAVY === "1";
const HEAVY_SKIP = "quality50k corpus generation is heavy; run `npm run test:heavy`";

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

// The invariant the post-load oracle's date-filtered lane measurement rests on
// (DESIGN.md 4.2 rule 1, "a resolvable date constraint"): a date_filter query
// declares a closed range, and its own target has to sit inside it. When it
// does not, every range-filtered lane returns NULL for that target and the
// query is unsolvable by the one mechanism the family exists to test -- which
// reads as "the filter did not help" rather than "the range is wrong".
test("date_filter targets fall inside the range their own query declares", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, buildMemoryIndex, generateQueries, tier } = await loadFixture();
  const memories = [...generateMemories(tier)];
  const index = buildMemoryIndex(memories);
  const byId = new Map(memories.map((m) => [m.id, m]));

  let checked = 0;
  for (const split of ["dev", "test"]) {
    for (const q of generateQueries(tier, split, index)) {
      if (q.family !== "date_filter") continue;
      const { date_from: from, date_to: to } = q.declared_filters;
      assert.ok(from && to, `${q.qid} must declare a closed date range, got ${from} .. ${to}`);
      const target = byId.get(q.targets[0]);
      const at = Date.parse(target.occurred_at);
      // Half-open [from, to), matching engine.mjs's `m.occurred_at <@ q.span`
      // with rangeLiteral's `[lower,upper)`.
      assert.ok(
        at >= Date.parse(from) && at < Date.parse(to),
        `${q.qid} "${q.text}": target occurred_at ${target.occurred_at} is outside declared [${from}, ${to})`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, "the smoke tier must contain date_filter queries for this to mean anything");
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

// ---------------------------------------------------------------------------
// Anchor resampling (2026-08-23 calibration decision). At the smoke1k scale
// every test above uses, re-verbalizing alone always clears the certificate,
// so it cannot exercise this path -- the failure it targets (a partial_ref
// pair or typo_noisy token whose target memory was doomed from the start,
// not merely misworded) only shows up once corpus density is high enough for
// that to happen by coincidence. Measured 2026-08-23 at quality50k: 3/2,000
// queries (2 partial_ref, 3 typo_noisy) needed a resampled anchor rather than
// a re-verbalized one. quality50k is therefore the smallest tier that
// actually exercises this code path, which is why this test (unlike every
// other one in this file) does not use smoke1k.
// ---------------------------------------------------------------------------

test("quality50k: anchor resampling converges the corpus to fully solvable, and its evidence lands in both the stats and the written queries", async (t) => {
  if (!HEAVY) {
    t.skip(HEAVY_SKIP);
    return;
  }
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { generateMemories, buildMemoryIndex, generateQueries, getRepairStats } = await import(pathToFileURL(genCorpusPath));
  const { config, resolveTier } = await import(pathToFileURL(configPath));
  const tier = resolveTier("quality50k");

  const memories = [...generateMemories(tier)];
  const index = buildMemoryIndex(memories);
  const dev = generateQueries(tier, "dev", index);
  const test = generateQueries(tier, "test", index);
  const all = [...dev, ...test];

  for (const q of all) {
    assert.equal(q.certificate.solvable, true, `${q.qid} must certify solvable once repairAnchors has run`);
  }

  const stats = getRepairStats(tier);
  assert.equal(stats.failures.length, 0, "repairAnchors must not report any unresolved failures at 50K");
  assert.ok(
    stats.anchorResampled.length > 0,
    "this run must actually exercise anchor resampling and not just re-verbalize -- " +
    "if this ever reads 0, the corpus got easier (or the mix changed) and this test's premise needs revisiting",
  );
  for (const r of stats.anchorResampled) {
    assert.ok(
      r.family === "partial_ref" || r.family === "typo_noisy",
      `anchor resampling only applies to partial_ref/typo_noisy, got ${r.family} for ${r.qid}`,
    );
    assert.ok(
      r.attempts >= 1 && r.attempts <= config.oracle.anchorResampleAttempts,
      `${r.qid} used ${r.attempts} attempts, outside the configured bound of ${config.oracle.anchorResampleAttempts}`,
    );
  }

  // The written record carries the same evidence as the in-memory stats, so
  // a caller reading queries-*.jsonl off disk (not just this process) can see
  // which queries needed a resampled anchor -- not just a re-verbalized one.
  const resampledQids = new Set(stats.anchorResampled.map((r) => r.qid));
  for (const q of all) {
    if (resampledQids.has(q.qid)) {
      assert.ok(q.diagnostics.anchor_resample_attempts >= 1, `${q.qid} is in repairStats.anchorResampled but its own diagnostics say 0 attempts`);
    } else {
      assert.equal(q.diagnostics.anchor_resample_attempts, 0, `${q.qid} was not anchor-resampled, so its diagnostics should read 0`);
    }
  }
});

// Expensive on purpose, and deliberately not a smoke1k test: repairAnchors
// runs once inside buildPlan, over dev+test cases TOGETHER, before any
// caller sees the memories (see gen-corpus.mjs's own comment on
// repairAnchors) -- specifically so a caller asking for only the test split
// repairs the exact same corpus a caller asking for both splits would. That
// invariant cannot be checked against smoke1k, because at that scale nothing
// needs the anchor-resample path in the first place, so there is no patch
// whose split-order-independence would be worth proving. Two real subprocess
// runs of quality50k, not one process asking twice, because generateMemories
// memoizes per-process (see the cross-process determinism test above) and a
// same-process check would prove the cache works, not that two independent
// runs agree.
test("quality50k: anchor resampling is split-order-independent -- '--split test' alone repairs the identical corpus '--split both' would", async (t) => {
  if (!HEAVY) {
    t.skip(HEAVY_SKIP);
    return;
  }
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const scriptFor = (splits) => `
    const { generateMemories, buildMemoryIndex, generateQueries } = await import(${JSON.stringify(pathToFileURL(genCorpusPath).href)});
    const { resolveTier } = await import(${JSON.stringify(pathToFileURL(configPath).href)});
    const tier = resolveTier("quality50k");
    const memories = [...generateMemories(tier)];
    const index = buildMemoryIndex(memories);
    const out = { memories };
    for (const split of ${JSON.stringify(splits)}) out[split] = generateQueries(tier, split, index);
    process.stdout.write(JSON.stringify(out));
  `;
  const run = (splits) => {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", scriptFor(splits)], { maxBuffer: 1 << 29 });
    assert.ok(out.length > 1_000_000, `child process produced only ${out.length} bytes for quality50k -- looks truncated or empty`);
    return JSON.parse(out.toString());
  };

  const both = run(["dev", "test"]);
  const testOnly = run(["test"]);

  assert.deepEqual(
    testOnly.memories, both.memories,
    "a caller asking only for the test split must see the SAME repaired memories (including any anchor-resampled content) as one asking for both",
  );
  assert.deepEqual(
    testOnly.test, both.test,
    "the test split's queries, including any anchor-resampled text, must be identical regardless of which splits were requested",
  );
});

// Re-targeting (DESIGN.md 4.3.1's repair loop, calibration decision 2026-08-24):
// when re-verbalizing cannot converge a query, the repair loop points it at a
// DIFFERENT memory instead. Pure function, no database and no embedding model.
test("retargetQuery moves a query onto a different member of its own confusion set", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { retargetQuery } = await import(pathToFileURL(genCorpusPath));
  const { PEOPLE } = await import(pathToFileURL(join(benchRoot, "lib", "lexicon.mjs")));
  const tier = { name: "smoke1k" };

  const members = [
    { id: 11, people: [PEOPLE[0].slug], places: ["somewhere"], occurred_at: "2019-05-04T10:00:00.000Z" },
    { id: 12, people: [PEOPLE[1].slug], places: ["somewhere"], occurred_at: "2020-05-04T10:00:00.000Z" },
    { id: 13, people: [PEOPLE[2].slug], places: ["somewhere"], occurred_at: "2021-05-04T10:00:00.000Z" },
  ];
  const index = { byId: new Map(members.map((m) => [m.id, m])) };

  const swap = {
    qid: "dev-000001", family: "entity_swap", text: `the kettle and the ladder with ${PEOPLE[0].name.toLowerCase()}`,
    targets: [11], declared_filters: { date_from: null, date_to: null, people: [PEOPLE[0].slug] },
    diagnostics: { distractor_ids: [12, 13], regen: { entitySwap: { mustInclude: ["kettle", "ladder"], swapPeople: true } } },
  };
  const moved = retargetQuery(swap, index, tier, 0);
  assert.ok(moved, "entity_swap must have an honest re-target: another member of the same group");
  assert.ok([12, 13].includes(moved.target), `re-target must land on a distractor, got ${moved.target}`);
  const landed = index.byId.get(moved.target);
  assert.match(moved.text, /^the kettle and the ladder with /, "the planted terms are preserved");
  assert.ok(moved.text.endsWith(PEOPLE.find((p) => p.slug === landed.people[0]).name.toLowerCase()),
    `the query must name the NEW member's entity, got "${moved.text}"`);
  assert.deepEqual(moved.declaredFilters.people, [landed.people[0]],
    "declared_filters.people must follow the new target, or the declared-filters ablation lies");

  // Deterministic: the same attempt index re-runs to the same choice.
  assert.deepEqual(retargetQuery(swap, index, tier, 0), moved);

  const dated = {
    qid: "dev-000002", family: "date_filter", text: "the kettle and the ladder in 2019",
    targets: [11], declared_filters: { date_from: "2019-01-01T00:00:00.000Z", date_to: "2020-01-01T00:00:00.000Z", people: [] },
    diagnostics: { distractor_ids: [12, 13], regen: { dateFilter: { mustInclude: ["kettle", "ladder"], month: 4, templateKind: "inYear" } } },
  };
  const movedDate = retargetQuery(dated, index, tier, 0);
  assert.ok(movedDate, "date_filter must re-target onto a different year of the same recurring event");
  const year = new Date(index.byId.get(movedDate.target).occurred_at).getUTCFullYear();
  assert.equal(movedDate.text, `the kettle and the ladder in ${year}`);
  const at = Date.parse(index.byId.get(movedDate.target).occurred_at);
  assert.ok(at >= Date.parse(movedDate.declaredFilters.date_from) && at < Date.parse(movedDate.declaredFilters.date_to),
    "the re-targeted range must still contain its own new target");
});

test("retargetQuery refuses the families that have no honest re-target", async (t) => {
  if (!existsSync(genCorpusPath) || !existsSync(configPath)) {
    t.skip("gen-corpus.mjs / config.mjs not landed yet");
    return;
  }
  const { retargetQuery } = await import(pathToFileURL(genCorpusPath));
  const index = { byId: new Map() };
  for (const family of ["near_dup", "rare_token", "typo_noisy", "partial_ref"]) {
    const q = {
      qid: "dev-000003", family, text: "whatever", targets: [11],
      declared_filters: { date_from: null, date_to: null, people: [] },
      diagnostics: { distractor_ids: [12], regen: null },
    };
    // near_dup's distinguisher sits in the TARGET's body, so re-targeting it
    // would mean rewriting a memory that is already embedded and loaded.
    assert.equal(retargetQuery(q, index, { name: "smoke1k" }, 0), null,
      `${family} must not be re-targeted post-load`);
  }
});
