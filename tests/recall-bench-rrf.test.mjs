// Pins the reciprocal-rank-fusion formula from DESIGN.md section 6.1's `fused` CTE:
//   rrf(id) = sum over lanes L containing id of weight[L] / (rrfK[L] + rank_L(id))
// Section 6.1 deliberately keeps fusion inside a single prepared SQL statement (the doc's
// own words: "not a micro-optimization"), so engine.mjs exports no standalone fuse
// function to call here.
//
// So this file works from both ends. The first half is a fixture-pinned JS oracle for the
// formula. The second half reads the SQL engine.mjs actually emits and asserts it computes
// that same formula -- same denominators from config, same sum, same tie-break -- which is
// what keeps the oracle honest instead of it being a spec nothing is measured against.
// Runs with no DB.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "experiments", "recall-bench");
const { buildRetrievalSql } = await import(pathToFileURL(join(benchRoot, "engine.mjs")));
const { config, resolveTier } = await import(pathToFileURL(join(benchRoot, "config.mjs")));

const EPS = 1e-9;

// laneResults: Record<lane, id[]>, array position (0-based) + 1 = the lane's rank,
// mirroring the `row_number() over (order by ...)` each lane CTE produces.
function fuseRrf(laneResults, weights, rrfK) {
  const scores = new Map();
  for (const [lane, ids] of Object.entries(laneResults)) {
    const w = weights[lane] ?? 0;
    const k = rrfK[lane] ?? 60;
    if (w === 0) continue; // section 6.2: a weight of 0 zeroes the lane's contribution
    ids.forEach((id, i) => {
      const rank = i + 1;
      const contribution = w / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }
  return [...scores.entries()]
    .map(([id, rrf]) => ({ id, rrf }))
    .sort((a, b) => b.rrf - a.rrf || a.id - b.id); // section 6.1: `order by rrf desc, id`
}

const laneResults = {
  and: [10, 20, 30],
  or: [20, 10, 40],
  vector: [30, 10, 20, 50],
};
const weights = { and: 1, or: 0.6, vector: 1 };
const rrfK = { and: 60, or: 60, vector: 60 };

test("fuseRrf sums per-lane weight/(k+rank) contributions across lanes", () => {
  const fused = fuseRrf(laneResults, weights, rrfK);
  const byId = new Map(fused.map((r) => [r.id, r.rrf]));

  const expected = {
    10: 1 / (60 + 1) + 0.6 / (60 + 2) + 1 / (60 + 2), // and#1, or#2, vector#2
    20: 1 / (60 + 2) + 0.6 / (60 + 1) + 1 / (60 + 3), // and#2, or#1, vector#3
    30: 1 / (60 + 3) + 1 / (60 + 1), // and#3, vector#1 (absent from `or`)
    40: 0.6 / (60 + 3), // or#3 only
    50: 1 / (60 + 4), // vector#4 only
  };

  for (const [id, expectedScore] of Object.entries(expected)) {
    assert.ok(
      Math.abs(byId.get(Number(id)) - expectedScore) < EPS,
      `id ${id}: expected rrf ~${expectedScore}, got ${byId.get(Number(id))}`,
    );
  }
  assert.equal(fused.length, 5, "an id absent from every lane must never appear");
});

test("fuseRrf sorts by descending rrf, then ascending id to break ties", () => {
  const fused = fuseRrf(laneResults, weights, rrfK);
  for (let i = 1; i < fused.length; i++) {
    const prev = fused[i - 1];
    const cur = fused[i];
    assert.ok(
      prev.rrf > cur.rrf || (prev.rrf === cur.rrf && prev.id < cur.id),
      `fused order broken at index ${i}: ${JSON.stringify(prev)} then ${JSON.stringify(cur)}`,
    );
  }

  // exact tie: two lanes, same rank, equal weight -> only id ascending decides order
  const tied = fuseRrf({ and: [200, 100], or: [100, 200] }, { and: 1, or: 1 }, { and: 60, or: 60 });
  assert.equal(Math.abs(tied[0].rrf - tied[1].rrf) < EPS, true, "fixture must actually tie");
  assert.deepEqual(tied.map((r) => r.id), [100, 200], "id ascending must break the tie");
});

test("a zero lane weight contributes nothing, matching the SQL comment in section 6.2", () => {
  const withTrigram = fuseRrf(
    { and: [10, 20], trigram: [20, 10] },
    { and: 1, trigram: 0 },
    { and: 60, trigram: 60 },
  );
  const withoutTrigramLane = fuseRrf({ and: [10, 20] }, { and: 1 }, { and: 60 });

  assert.deepEqual(withTrigram, withoutTrigramLane, "weight 0 must equal the lane not existing at all");
});

test("an id present in only one lane still fuses, and a lane with no results contributes nothing", () => {
  const fused = fuseRrf({ and: [7], or: [] }, { and: 1, or: 0.6 }, { and: 60, or: 60 });
  assert.deepEqual(fused, [{ id: 7, rrf: 1 / 61 }]);
});

// --- the SQL side: engine.mjs must implement the formula pinned above -------

// quality50k is the only tier carrying the trigram lane (section 6.2), so the
// tuned profile there is the widest fusion the engine ever emits.
const tunedSql = buildRetrievalSql(resolveTier("quality50k"), config.profiles.tuned).text;

test("the emitted fused CTE divides each lane weight by its configured rrfK plus the rank", () => {
  const branches = tunedSql.match(/\$\d+::float \/ \((\d+) \+ rnk\)/g) ?? [];
  assert.equal(branches.length, 4, `tuned runs four lanes; SQL emitted ${branches.length} fusion branches`);

  for (const lane of ["and", "or", "vector", "trigram"]) {
    const k = config.lanes.rrfK[lane];
    assert.match(
      tunedSql,
      new RegExp(`'${lane}'[^\\n]*\\$\\d+::float / \\(${k} \\+ rnk\\)`),
      `the ${lane} lane must fuse as weight / (${k} + rnk), the rrfK config says`,
    );
  }
});

test("the emitted SQL sums lane contributions per id and breaks ties by ascending id", () => {
  assert.match(tunedSql, /sum\(w\) as rrf/, "fusion is a sum over lanes, matching fuseRrf above");
  assert.match(tunedSql, /order by rrf desc, id/, "the fused cut must order by rrf desc then id asc");
  assert.match(tunedSql, /order by t\.rrf desc, t\.id/, "the final projection must keep that same order");
});

test("a profile's lane list decides which lanes reach fusion at all", () => {
  // naive is vector-only (section 3.4), so it must emit exactly one branch --
  // the zero-weight equivalence proved above is about weights, not lane sets.
  const naiveSql = buildRetrievalSql(resolveTier("quality50k"), config.profiles.naive).text;
  const branches = naiveSql.match(/\$\d+::float \/ \(\d+ \+ rnk\)/g) ?? [];
  assert.equal(branches.length, 1, "naive fuses the vector lane alone");
  assert.doesNotMatch(naiveSql, /and_lane/, "naive must not emit an AND lane");
});

// Regression: every fusedBranches entry must alias its own 'lane' and 'w'
// columns, not just the first one in the UNION ALL. Postgres names a UNION's
// output columns from the FIRST select alone -- the 'and' branch used to be
// the only one carrying "as lane"/"as w", which is invisible whenever 'and'
// happens to be first (fixedRrf, tuned), and fatal ("column w does not
// exist") the moment a profile's first (or only) lane is anything else, as
// naive's vector-only profile is. This only surfaced against a live
// Postgres -- the fixture oracle above never runs real SQL -- so it is
// pinned here as a string check on every lane in isolation.
test("every lane's fusion branch names its own 'lane' and 'w' columns, not just the first lane in the UNION", () => {
  const tier = resolveTier("quality50k");
  const singleLaneProfiles = {
    and: { lanes: ["and"], weighting: "fixed", weights: { and: 1 }, filters: false, rerank: false },
    or: { lanes: ["or"], weighting: "fixed", weights: { or: 1 }, filters: false, rerank: false },
    vector: { lanes: ["vector"], weighting: "fixed", weights: { vector: 1 }, filters: false, rerank: false },
    trigram: { lanes: ["trigram"], weighting: "fixed", weights: { trigram: 1 }, filters: false, rerank: false },
  };
  for (const [lane, profile] of Object.entries(singleLaneProfiles)) {
    const sql = buildRetrievalSql(tier, profile).text;
    assert.match(
      sql,
      new RegExp(`'${lane}' as lane, \\$\\d+::float / \\(\\d+ \\+ rnk\\) as w from ${lane === "vector" ? "vec_lane" : lane === "trigram" ? "trg_lane" : lane + "_lane"}`),
      `the ${lane}-only branch must alias its own lane/w columns so 'fused as (select id, sum(w) ..., jsonb_object_agg(lane, rnk) ...)' resolves when ${lane} is the ONLY (and therefore first) branch in the UNION`,
    );
  }
});
