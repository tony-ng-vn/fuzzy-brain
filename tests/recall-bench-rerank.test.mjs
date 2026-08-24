// Pins the rerank scorer from DESIGN.md section 6.5. The stage is a linear
// combination of eight features, so the things worth testing are not the
// arithmetic but the two behaviors the design says the stage exists to produce:
// rare_hit being close to proof, and dup_penalty unblocking the near_dup family
// by demoting each further sibling of a group already represented above.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const benchRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "experiments", "recall-bench");
const { rerank, rerankFeatures, rerankScore } = await import(pathToFileURL(join(benchRoot, "rerank.mjs")));
const { config } = await import(pathToFileURL(join(benchRoot, "config.mjs")));

const NO_DATE = { from: null, to: null };

function candidate(id, features = {}) {
  return {
    id,
    laneRanks: {},
    rrf: 0,
    rerankScore: null,
    features: {
      cosine: 0.5,
      lexical: 1,
      rareHit: false,
      titleHit: false,
      dupGroup: null,
      occurredAt: "2024-03-12T00:00:00.000Z",
      people: [],
      tags: [],
      ...features,
    },
  };
}

test("dup_penalty demotes each further member of an already-represented group", () => {
  const qf = { entities: { people: [], places: [] }, dateRange: NO_DATE, quoted: [] };
  // Three siblings of group 7 arrive consecutively in fused order, crowding
  // the standalone candidate that follows them.
  const ranked = rerank(qf, [
    candidate(1, { dupGroup: 7 }),
    candidate(2, { dupGroup: 7 }),
    candidate(3, { dupGroup: 7 }),
    candidate(4),
  ], config);

  const byId = new Map(ranked.map((c) => [c.id, c]));
  assert.equal(byId.get(1).features.dupPenalty, 0, "the first member of a group is not penalized");
  assert.equal(byId.get(2).features.dupPenalty, 1);
  assert.equal(byId.get(3).features.dupPenalty, 2, "penalty grows with how many siblings sit above");
  assert.equal(byId.get(4).features.dupPenalty, 0, "a candidate outside any group is untouched");

  assert.deepEqual(
    ranked.map((c) => c.id),
    [1, 4, 2, 3],
    "the crowded-out standalone candidate must climb above the later siblings",
  );
});

test("an exact rare-token match outranks a candidate that is otherwise identical", () => {
  const qf = { entities: { people: [], places: [] }, dateRange: NO_DATE, quoted: [] };
  const ranked = rerank(qf, [candidate(1), candidate(2, { rareHit: true })], config);

  assert.deepEqual(ranked.map((c) => c.id), [2, 1], "rareHit carries the heaviest weight (section 6.5)");
  assert.ok(
    ranked[0].rerankScore - ranked[1].rerankScore >= config.rerank.weights.rareHit,
    "the gap must be at least the rareHit weight, since nothing else differs",
  );
});

test("entity match scores the share of the query's entities the candidate carries", () => {
  const qf = { entities: { people: ["doan", "minh"], places: [] }, dateRange: NO_DATE, quoted: [] };

  const none = rerankFeatures(qf, candidate(1), config);
  const half = rerankFeatures(qf, candidate(2, { people: ["doan"] }), config);
  const both = rerankFeatures(qf, candidate(3, { people: ["doan", "minh"] }), config);

  assert.equal(none.entity, 0);
  assert.equal(half.entity, 0.5);
  assert.equal(both.entity, 1);

  // A query naming no entity must not hand every candidate a free point.
  const noEntityQuery = { entities: { people: [], places: [] }, dateRange: NO_DATE, quoted: [] };
  assert.equal(rerankFeatures(noEntityQuery, candidate(4, { people: ["doan"] }), config).entity, 0);
});

test("dateFit is 1 inside the parsed range and decays outside instead of zeroing", () => {
  const qf = {
    entities: { people: [], places: [] },
    dateRange: { from: "2024-03-01", to: "2024-03-31" },
    quoted: [],
  };

  const inside = rerankFeatures(qf, candidate(1, { occurredAt: "2024-03-12T00:00:00.000Z" }), config);
  const justOutside = rerankFeatures(qf, candidate(2, { occurredAt: "2024-05-12T00:00:00.000Z" }), config);
  const farOutside = rerankFeatures(qf, candidate(3, { occurredAt: "2019-05-12T00:00:00.000Z" }), config);

  assert.equal(inside.dateFit, 1);
  assert.ok(justOutside.dateFit > 0 && justOutside.dateFit < 1, "a near miss degrades, it does not destroy");
  assert.ok(farOutside.dateFit < justOutside.dateFit, "further outside the range must score lower");
});

test("rerankScore is the dot product of features and the configured weights", () => {
  const features = {
    fused: 1, lexical: 1, cosine: 1, entity: 1, recency: 1,
    dateFit: 1, rareHit: 1, titleHit: 1, dupPenalty: 1,
  };
  const expected = Object.values(config.rerank.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(rerankScore(features, config.rerank.weights) - expected) < 1e-9);

  // dupPenalty's weight is negative in config, so the sign is carried by the
  // weight rather than by a subtraction at the call site.
  assert.ok(config.rerank.weights.dupPenalty < 0, "dupPenalty must be a negative weight");
});
