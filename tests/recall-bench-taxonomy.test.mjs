// Pins the not_retrieved / lost_in_fusion boundary in the failure taxonomy
// (DESIGN.md section 5.2) against the verified oracle's certificate.signals,
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
//
// oracleSolvingLanes must be certificate.signals (load.mjs:669), a lane-name
// list already thresholded at config.oracle.bestLaneRankAt (10) -- not a raw
// null-check over lane_ranks_measured. vector_rank is an exact, uncapped
// global rank (buildOracleSql counts the whole table with no LIMIT), so it
// is never null; a bare "rank != null" filter would count "vector rank
// 40,000" as a solving lane on every miss and silently empty the
// not_retrieved gate. See the last test below.
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

test("a query solvable only by a lane absent from this profile is not filed as not_retrieved", () => {
  const { cause, detail } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: typoResultNoTrigramLane,
    profile: naiveProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    oracleSolvingLanes: ["trigram"],
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
    oracleSolvingLanes: ["trigram"],
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
    oracleSolvingLanes: [],
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
    oracleSolvingLanes: undefined,
  });
  assert.equal(cause, "not_retrieved");
});

test("every solving lane is present in the profile, but fusion still dropped the target -- lost_in_fusion, no 'omits' wording", () => {
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
    oracleSolvingLanes: ["and"],
  });
  assert.equal(cause, "lost_in_fusion");
  assert.doesNotMatch(detail, /omits/);
});

test("a lane with a real but far-beyond-threshold rank must not count as solving (the vector-uncapped-rank trap)", () => {
  // vector_rank in load.mjs's oracle SQL is an exact global count with no
  // LIMIT, so it is a real number even at rank 40,000 -- nowhere near
  // config.oracle.bestLaneRankAt (10). The caller is responsible for passing
  // an already-thresholded lane list (certificate.signals), not raw ranks;
  // this fixture is the case that would silently break if a caller passed
  // raw ranks and this function null-checked them instead.
  const { cause } = classifyFailure({
    qf: {},
    targetId: 55,
    targetMemory: { id: 55 },
    result: { hits: [], lanes: { and: [], or: [], vector: [] } },
    profile: fixedRrfProfile,
    distractorIds: [],
    memoriesById: new Map([[55, { id: 55 }]]),
    // certificate.signals already excludes 'vector' at rank 40,000 -- only
    // lanes that cleared the k=10 gate appear here.
    oracleSolvingLanes: [],
  });
  assert.equal(cause, "not_retrieved");
});
