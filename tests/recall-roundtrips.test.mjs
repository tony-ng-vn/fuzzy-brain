// Pins the recall round-trip budget. The brain lives behind a managed
// Postgres whose network alone costs about 164ms per query, so the number of
// sequential statements per question IS the latency floor: the old per-lane
// flow issued 10-15 of them and a warm recall cost about a second on network
// time nothing else could recover. Retrieval must stay at three statements
// for an ordinary question -- vocabulary probe, one fused lane statement, one
// hop statement -- and must fall back to per-lane queries when the fused
// statement fails, so a missing extension still degrades a lane instead of
// the whole answer.
import test from "node:test";
import assert from "node:assert/strict";
import { recall } from "../scripts/recall.mjs";

const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";
const EDGE_1 = "33333333-3333-4333-8333-333333333333";
const EPISODE = "44444444-4444-4444-8444-444444444444";

const QUESTION = "where is the kite festival";
const embedQuery = async () => Array(768).fill(0.01);

const vocabRows = [
  { term: "kite", total: 100, df: 5 },
  { term: "festival", total: 100, df: 5 },
];

const nodeHit = {
  lane: "and:node",
  id: NODE_A,
  type: "story",
  title: "kite festival moved to the pier",
  body: "the festival moved to the pier this year",
  created_at: "2026-08-01T00:00:00.000Z",
  occurred_at: "2026-08-01T00:00:00.000Z",
  lane_score: 0.5,
  sim: 0.82,
  rare_hit: false,
};

const evidenceHit = {
  lane: "and:evidence",
  id: "55555555-5555-4555-8555-555555555555",
  quote: "the kite festival is at the pier now",
  speaker: "tony",
  occurred_at: "2026-08-02T00:00:00.000Z",
  episode_id: EPISODE,
  source_locator: "session-1",
  source_kind: "session",
  source_label: "talk",
  lane_score: 0.4,
  sim: 0.7,
  rare_hit: false,
};

const hopRows = [
  {
    kind: "edge",
    id: EDGE_1,
    source: NODE_A,
    target: NODE_B,
    why: "the festival move is why the meadow plan was dropped",
    source_title: "kite festival moved to the pier",
    target_title: "the meadow plan",
  },
  {
    kind: "node",
    id: NODE_B,
    type: "story",
    title: "the meadow plan",
    body: "the meadow was the old site",
    created_at: "2026-07-01T00:00:00.000Z",
    occurred_at: "2026-07-01T00:00:00.000Z",
    sim: null,
    rare_hit: false,
  },
];

function stubClient({ failFused = false } = {}) {
  const calls = [];
  let fusedFailed = false;
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (/set_config/.test(sql)) return { rows: [{ set_config: "0.4" }] };
      if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: vocabRows };
      if (/ as lane\b/.test(sql)) {
        if (failFused && !fusedFailed) {
          fusedFailed = true;
          throw new Error("fused statement rejected");
        }
        return { rows: [nodeHit, evidenceHit] };
      }
      if (/ as kind\b/.test(sql)) return { rows: hopRows };
      return { rows: [] };
    },
  };
}

test("an ordinary question costs exactly three round trips", async () => {
  const client = stubClient();
  const result = await recall(QUESTION, { client, schema: "brain_dev", embedQuery });

  const kinds = client.calls.map(({ sql }) =>
    /unnest\(\$1::text\[\]\)/.test(sql) ? "vocab" : / as lane\b/.test(sql) ? "fused" : / as kind\b/.test(sql) ? "hop" : "other",
  );
  assert.deepEqual(kinds, ["vocab", "fused", "hop"], `statements issued: ${kinds.join(", ")}`);

  // The fused rows must land exactly where the per-lane rows used to: the
  // node hit is admitted, the hop neighbour surfaces behind its why, and the
  // evidence quote keeps its provenance.
  assert.equal(result.state, "supported");
  const titles = result.hits.filter((h) => h.layer === "node").map((h) => h.title);
  assert.ok(titles.includes("kite festival moved to the pier"));
  assert.ok(titles.includes("the meadow plan"), "the one-hop neighbour must still arrive");
  const neighbour = result.hits.find((h) => h.title === "the meadow plan");
  assert.match(neighbour.via_edge.why, /meadow plan was dropped/);
  const quote = result.hits.find((h) => h.layer === "evidence");
  assert.equal(quote.provenance.episode_id, EPISODE);
});

test("a failing fused statement falls back to per-lane queries and still answers", async () => {
  const client = stubClient({ failFused: true });
  const result = await recall(QUESTION, { client, schema: "brain_dev", embedQuery });

  assert.match(result.note, /fused retrieval failed/);
  const fused = client.calls.filter(({ sql }) => / as lane\b/.test(sql)).length;
  assert.equal(fused, 1, "the fused statement is tried once, never retried");
  // Per-lane statements carry no lane tag; with and/or/vector active over two
  // layers plus two edge lanes, the fallback issues more statements than the
  // fused path ever does.
  assert.ok(client.calls.length > 3, `fallback issued only ${client.calls.length} statements`);
});
