// The shared retrieval library, and the one thing it exists to guarantee:
// the bench harness and the product's recall verb run the same code.
//
// tests/recall-bench-rrf.test.mjs keeps its own independent fusion oracle and
// checks it against the SQL engine.mjs emits. This file checks the JavaScript
// fusion the product uses against the same fixture, so all three agree.
// Runs with no database and no model.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shared = join(root, "scripts", "lib", "retrieval");
const benchRoot = join(root, "experiments", "recall-bench");

const { fuseRrf, rrfContribution, denseRanks } = await import(pathToFileURL(join(shared, "fuse.mjs")));
const { tokenize, stem } = await import(pathToFileURL(join(shared, "text.mjs")));
const { parseQueryFeatures, laneWeights } = await import(pathToFileURL(join(shared, "features.mjs")));
const { parseDateRange } = await import(pathToFileURL(join(shared, "dates.mjs")));
const { retrievalDefaults } = await import(pathToFileURL(join(shared, "config.mjs")));
const engine = await import(pathToFileURL(join(benchRoot, "engine.mjs")));
const benchRerank = await import(pathToFileURL(join(benchRoot, "rerank.mjs")));
const sharedRerank = await import(pathToFileURL(join(shared, "rerank.mjs")));

const EPS = 1e-12;

test("the bench re-exports the shared tokenizer and stemmer, not a copy", () => {
  assert.equal(engine.tokenize, tokenize);
  assert.equal(engine.stem, stem);
  assert.equal(benchRerank.rerankScore, sharedRerank.rerankScore);
});

// Same fixture and same expected numbers as tests/recall-bench-rrf.test.mjs's
// oracle, so the product's JavaScript fusion is pinned to the formula the
// bench SQL was measured under.
test("fuseRrf sums weight/(k+rank) across lanes, exactly as the bench oracle does", () => {
  const laneResults = {
    and: [{ key: 10, rank: 1 }, { key: 20, rank: 2 }, { key: 30, rank: 3 }],
    or: [{ key: 20, rank: 1 }, { key: 10, rank: 2 }, { key: 40, rank: 3 }],
    vector: [{ key: 30, rank: 1 }, { key: 10, rank: 2 }, { key: 20, rank: 3 }, { key: 50, rank: 4 }],
  };
  const weights = { and: 1, or: 0.6, vector: 1 };
  const rrfK = { and: 60, or: 60, vector: 60 };
  const expected = {
    10: 1 / 61 + 0.6 / 62 + 1 / 62,
    20: 1 / 62 + 0.6 / 61 + 1 / 63,
    30: 1 / 63 + 1 / 61,
    40: 0.6 / 63,
    50: 1 / 64,
  };

  const fused = fuseRrf(laneResults, weights, rrfK);
  for (const [key, want] of Object.entries(expected)) {
    assert.ok(Math.abs(fused.get(Number(key)).rrf - want) < EPS, `key ${key}`);
  }
  assert.equal(fused.get(10).laneRanks.or, 2);
  assert.equal(rrfContribution(1, 60, 1), 1 / 61);
});

test("a lane weighted 0 contributes nothing and admits nothing", () => {
  const fused = fuseRrf({ trigram: [{ key: "a", rank: 1 }] }, { trigram: 0 }, {});
  assert.equal(fused.size, 0, "a zero-weight lane must not put a row into the candidate set");
});

test("dense ranks: rows with the same lane score share a rank", () => {
  const ranks = denseRanks([{ s: 9 }, { s: 9 }, { s: 4 }], (r) => r.s).map((e) => e.rank);
  assert.deepEqual(ranks, [1, 1, 2]);
});

test("the product's date parser drops bare month names, the bench's keeps them", () => {
  // "we may ship it" is not a date filter. It is the verb "may".
  assert.deepEqual(parseDateRange("what did we may do about it", retrievalDefaults), { from: null, to: null });
  const benchRange = parseDateRange("what did we may do about it", { dates: { referenceIso: "2026-01-01T00:00:00.000Z" } });
  assert.equal(benchRange.from, "2025-05-01");

  // The explicit templates still resolve under the product config.
  assert.deepEqual(parseDateRange("what did i say in july 2026", retrievalDefaults), {
    from: "2026-07-01",
    to: "2026-08-01",
  });
});

test("product weighting: a typo query up-weights trigram, a paraphrase up-weights vector", () => {
  const vocab = { totalDocs: 451, df: new Map([["kayak", 2], ["stair", 3]]) };
  const profile = { weighting: "query-dependent" };

  const typo = parseQueryFeatures("tangerin kayk velvt stares", vocab, retrievalDefaults);
  assert.equal(typo.typoSuspect, true);
  assert.equal(typo.looksParaphrase, false);
  assert.ok(laneWeights(typo, profile, retrievalDefaults).trigram > 1);

  // Nine terms, most of them absent from the vocabulary: reworded, not mistyped.
  const para = parseQueryFeatures(
    "how much did the cost of my apartment increase",
    vocab,
    retrievalDefaults,
  );
  assert.equal(para.typoSuspect, false, "a nine-term question is too long to be a typo");

  const weights = laneWeights(
    parseQueryFeatures("could somebody remind me what the arrangement about the porch swing was", vocab, retrievalDefaults),
    profile,
    retrievalDefaults,
  );
  assert.ok(weights.vector > weights.and);
});

test("the rare-term floor is reachable at brain scale, unlike the bench's", () => {
  // maxIdf can never exceed ln(totalDocs), so a floor above that is dead code.
  assert.ok(retrievalDefaults.weighting.rareIdfFloor < Math.log(451));
  const vocab = { totalDocs: 451, df: new Map([["walnut", 2], ["desk", 40]]) };
  const qf = parseQueryFeatures("walnut desk", vocab, retrievalDefaults);
  assert.deepEqual(qf.rareTerms, ["walnut"]);
  assert.ok(laneWeights(qf, { weighting: "query-dependent" }, retrievalDefaults).and > 1);
});
