// Pins the not_retrieved / lost_in_fusion boundary in the failure taxonomy
// (DESIGN.md section 5.2) against the verified oracle's per-lane rank data,
// rather than against the running profile's own lane subset.
//
// Before this fix, classifyFailure treated "target absent from every lane
// THIS PROFILE ran" as proof of a generator bug. That conflates two very
// different situations: a typo query the corpus generator promised was
// solvable, that genuinely no lane reaches (a real bug, DESIGN.md says this
// bucket must be empty) versus a typo query only the trigram lane solves,
// benched under naive or fixedRrf, which have no trigram lane at all. The
// second case is a profile limitation, not a certificate violation, and
// filing it as not_retrieved would fail a bench run for a reason that has
// nothing to do with corpus quality. No DB needed: classifyFailure is pure.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchRecallPath = join(repoRoot, "experiments", "recall-bench", "bench-recall.mjs");
const { classifyFailure } = await import(pathToFileURL(benchRecallPath));

const naiveProfile = { lanes: ["vector"], filters: false, rerank: false };
const fixedRrfProfile = { lanes: ["and", "or", "vector"], filters: false, rerank: false };
const tunedProfile = { lanes: ["and", "or", "vector", "trigram"], filters: false, rerank: false };

// A typo_noisy query the oracle can only solve via trigram (DESIGN.md 4.1:
// "typo_noisy ... earnsBack: trigram lane"). result.lanes reflects what the
// PROFILE actually queried, so a naive/fixedRrf run never has a trigram key.
const typoResultNoTrigramLane = {
  hits: [],
  lanes: { vector: [101, 102, 103] }, // profile ran; target (55) isn't in it
};
const oracleSolvesOnlyViaTrigram = { and: null, or: null, trigram: 4, vector: null };

test("a query solvable only by a lane absent from this profile is not filed as not_retrieved", () => {
  const { cause, detail } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: typoResultNoTrigramLane,
    profile: naiveProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    oracleLaneRanks: oracleSolvesOnlyViaTrigram,
  });
  assert.notEqual(cause, "not_retrieved");
  assert.equal(cause, "lost_in_fusion");
  assert.match(detail, /trigram/);
  assert.match(detail, /omits/);
});

test("the same miss under fixedRrf (also no trigram lane) is still not not_retrieved", () => {
  const { cause } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: { hits: [], lanes: { and: [], or: [201], vector: [301] } },
    profile: fixedRrfProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    oracleLaneRanks: oracleSolvesOnlyViaTrigram,
  });
  assert.notEqual(cause, "not_retrieved");
});

test("a query genuinely unreachable by every lane, per the oracle, is still not_retrieved", () => {
  const { cause, detail } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: { hits: [], lanes: { and: [], or: [], vector: [301], trigram: [] } },
    profile: tunedProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    oracleLaneRanks: { and: null, or: null, trigram: null, vector: null },
  });
  assert.equal(cause, "not_retrieved");
  assert.match(detail, /certificate promised otherwise/);
});

test("with no oracle data at all (unverified corpus), the old conservative not_retrieved behavior is preserved", () => {
  const { cause } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: { hits: [], lanes: { vector: [301] } },
    profile: naiveProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    oracleLaneRanks: undefined,
  });
  assert.equal(cause, "not_retrieved");
});

test("a lane the profile HAS still misses the target when every solving lane is present but fusion dropped it", () => {
  // tuned runs and/or/vector/trigram; oracle says only 'and' solves it, and
  // 'and' is in the profile -- so this is a genuine top-50 fusion loss, not
  // a missing-lane story. The detail text should say so, not name an omission.
  const { cause, detail } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: { hits: [], lanes: { and: [], or: [], vector: [], trigram: [] } },
    profile: tunedProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    oracleLaneRanks: { and: 3, or: null, trigram: null, vector: null },
  });
  assert.equal(cause, "lost_in_fusion");
  assert.doesNotMatch(detail, /omits/);
});
