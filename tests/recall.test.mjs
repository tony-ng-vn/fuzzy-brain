// End-to-end tests for the recall verb, against brain_dev fixtures.
// Covers the hybrid find (lexical exact, fragment, vector paraphrase, trigram
// typo rescue, the date filter, the ratified-edge lane, speaker-aware
// ordering, null-embedding tolerance) and the five epistemic answer states.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
loadEnvLocal();

const TEST_LABEL = "recall-test";
const EDGE_WHY = "one long afternoon of tidying produced both of them";
const quoteLanternIn = "the brass lantern was delivered to the porch";
const quoteLanternOut = "the brass lantern was carried back inside";
const NODE_TITLES = [
  "kite festival moved to the pier",
  "kite festival stays in the meadow",
  "the walnut desk restoration",
  "the cedar hinge box",
];

function recall(question) {
  const out = execFileSync("node", [join(root, "scripts", "recall.mjs"), question, "--json"], {
    encoding: "utf8",
    env: { ...process.env, BRAIN_SCHEMA: "brain_dev" },
  });
  return JSON.parse(out);
}

// Two cosine scores measured 2026-08-30 against the brain_dev corpus (451
// embedded session spans, all of them real transcript text):
//   - 150 random letter-soup queries peaked at 0.6510, so anything at or
//     below that number is centroid noise and must never read as an answer.
//   - the rent paraphrase below scored 0.7438, and it is the only assertion
//     in this file with no lexical overlap at all, so it is the weakest hit
//     the vector lane has to call strong.
// The strong-hit threshold has to sit between them. Pinning both edges here
// keeps that calibration deterministic; the end-to-end "missing" case only
// samples it, and sampled it wrong about two percent of the time.
const GARBAGE_CEILING = 0.651;
const WEAKEST_TRUE_POSITIVE = 0.7438;

test("recall: the strong-hit threshold clears the measured garbage ceiling", async () => {
  const { classifyState } = await import("../scripts/recall.mjs");
  const evidenceHit = (sim) => ({ layer: "evidence", sim, strongLex: false, weakLex: true, row: {} });

  assert.equal(classifyState([]), "missing");
  assert.equal(
    classifyState([evidenceHit(GARBAGE_CEILING)]),
    "partial",
    "a vector score inside the garbage band is a fragment, never an answer",
  );
  assert.equal(
    classifyState([evidenceHit(WEAKEST_TRUE_POSITIVE)]),
    "evidence",
    "a real paraphrase must still carry the answer",
  );
});

test("recall: hybrid find and epistemic answer states", async (t) => {
  // recall's vector lane needs the local model; same skip rule as the sweep.
  try {
    const { embedDocument } = await import("../scripts/lib/embeddings.mjs");
    await embedDocument("probe");
  } catch (err) {
    t.skip(`embedding model unavailable (${err.message}); run once online to cache the weights`);
    return;
  }

  const connectionString = process.env.DATABASE_URL_DEV || process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const src = await client.query(
      "insert into brain_dev.sources (kind, label) values ('claude_code_session', $1) returning id",
      [TEST_LABEL],
    );
    const ep = await client.query(
      `insert into brain_dev.episodes (source_id, source_locator, raw, occurred_at)
       values ($1, 'recall-test-episode', 'fixture episode raw', '2026-07-10T09:00:00Z') returning id`,
      [src.rows[0].id],
    );
    const quoteKayak = "the tangerine kayak dripped on the velvet stairs";
    const quoteRent = "my rent went up two hundred dollars this month";
    await client.query(
      `insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker, occurred_at) values
       ($1, $2, 0, 48, 'tony', '2026-07-10T09:01:00Z'),
       ($1, $2, 50, 98, 'assistant', '2026-07-10T09:02:00Z'),
       ($1, $3, 100, 146, 'tony', '2026-07-10T09:03:00Z')`,
      [ep.rows[0].id, quoteKayak, quoteRent],
    );
    await client.query(
      `insert into brain_dev.nodes (type, title, raw, body) values
       ('moment', $1, 'the kite festival was moved to the pier this year', 'the festival moved to the pier'),
       ('moment', $2, 'the kite festival stays in the meadow like always', 'the festival stays in the meadow'),
       ('moment', $3, 'i finally restored the walnut desk from the garage', 'the walnut desk is restored'),
       ('moment', $4, 'i keep the small hinges in a cedar box', 'the small hinges live in a cedar box')`,
      NODE_TITLES,
    );
    const pierNode = await client.query("select id from brain_dev.nodes where title = $1", [NODE_TITLES[0]]);
    const meadowNode = await client.query("select id from brain_dev.nodes where title = $1", [NODE_TITLES[1]]);
    const deskNode = await client.query("select id from brain_dev.nodes where title = $1", [NODE_TITLES[2]]);
    const hingeNode = await client.query("select id from brain_dev.nodes where title = $1", [NODE_TITLES[3]]);
    await client.query(
      "insert into brain_dev.edges (source, target, why) values ($1, $2, 'contradicts: the meadow account disagrees with the pier account of where the festival is')",
      [meadowNode.rows[0].id, pierNode.rows[0].id],
    );
    // The edge-walk fixture. The why deliberately shares no word with the
    // question that reaches the desk, so the hinge box can only arrive by
    // being one ratified hop away from a node that did match.
    await client.query(
      "insert into brain_dev.edges (source, target, why) values ($1, $2, $3)",
      [deskNode.rows[0].id, hingeNode.rows[0].id, EDGE_WHY],
    );

    // Fill fixture embeddings (newest-first sweep reaches them first).
    execFileSync("node", [join(root, "scripts", "embed-sweep.mjs"), "--limit", "12"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BRAIN_SCHEMA: "brain_dev",
        FUZZY_BRAIN_EMBED_LOCK: join(tmpdir(), `fuzzy-brain-recall-embed-${process.pid}.lock`),
      },
    });

    // Inserted AFTER the sweep: stays null-embedding on purpose.
    await client.query(
      "insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker) values ($1, 'the copper weathervane squeaked at midnight', 150, 193, 'tony')",
      [ep.rows[0].id],
    );

    // The date fixture: one sentence about the lantern arriving, one about it
    // leaving, six months apart and otherwise near-identical, so a question
    // that names a month has exactly one right answer.
    await client.query(
      `insert into brain_dev.evidence (episode_id, quote, start_offset, end_offset, speaker, occurred_at) values
       ($1, $2, 200, 245, 'tony', '2024-03-14T10:00:00Z'),
       ($1, $3, 250, 293, 'tony', '2024-09-14T10:00:00Z')`,
      [ep.rows[0].id, quoteLanternIn, quoteLanternOut],
    );

    await t.test("lexical find surfaces an exact phrase with provenance, state = evidence", () => {
      const res = recall("tangerine kayak velvet stairs");
      assert.equal(res.state, "evidence");
      const hit = res.hits.find((h) => h.layer === "evidence" && h.quote === quoteKayak);
      assert.ok(hit, "the exact phrase must be found");
      assert.equal(hit.provenance.source_label, TEST_LABEL);
      assert.equal(hit.provenance.source_kind, "claude_code_session");
      assert.ok(hit.provenance.episode_id);
      assert.ok(hit.provenance.occurred_at);
    });

    await t.test("tony-voice outranks assistant-voice at equal relevance", () => {
      const res = recall("tangerine kayak velvet stairs");
      const kayakHits = res.hits.filter((h) => h.quote === quoteKayak);
      assert.equal(kayakHits.length, 2, "both speakers' identical spans must surface");
      assert.equal(kayakHits[0].speaker, "tony");
      assert.equal(kayakHits[1].speaker, "assistant");
      assert.ok(kayakHits[0].score > kayakHits[1].score);
    });

    await t.test("vector find surfaces a paraphrase with no shared words, state = evidence", () => {
      const res = recall("how much did the cost of my apartment increase");
      assert.equal(res.state, "evidence");
      assert.ok(
        res.hits.some((h) => h.quote === quoteRent),
        "the rent span must surface on meaning alone",
      );
    });

    await t.test("null-embedding rows still surface through full-text", () => {
      const res = recall("copper weathervane squeaked");
      assert.ok(res.hits.some((h) => h.quote === "the copper weathervane squeaked at midnight"));
    });

    await t.test("state supported: a ratified node carries the answer, with node provenance", () => {
      const res = recall("walnut desk restoration");
      assert.equal(res.state, "supported");
      const hit = res.hits.find((h) => h.layer === "node");
      assert.ok(hit);
      assert.equal(hit.title, NODE_TITLES[2]);
      assert.ok(hit.node_id);
    });

    await t.test("state conflicting: strong node hits joined by a ratified contradicts edge", () => {
      const res = recall("where is the kite festival");
      assert.equal(res.state, "conflicting");
      const titles = res.hits.filter((h) => h.layer === "node").map((h) => h.title);
      assert.ok(titles.includes(NODE_TITLES[0]));
      assert.ok(titles.includes(NODE_TITLES[1]));
      const withEdge = res.hits.find((h) => h.layer === "node" && (h.edges ?? []).length > 0);
      assert.ok(withEdge, "node hits must carry their one-hop ratified edges");
      assert.match(withEdge.edges[0].why, /contradicts/i);
    });

    await t.test("state partial: fragments match but the direct answer does not", () => {
      // Two of four terms hit the (null-embedding) weathervane span, so it
      // clears the fragment bar in the OR lane but never a strong signal.
      const res = recall("copper weathervane parliament budget");
      assert.equal(res.state, "partial");
      assert.ok(
        res.hits.some((h) => h.quote === "the copper weathervane squeaked at midnight"),
        "the fragment row must surface",
      );
    });

    await t.test("the trigram lane rescues a mistyped question no other lane can reach", () => {
      // Every word is misspelled, so not one lexeme matches and both text
      // lanes come back empty. The row it is asking for is the weathervane
      // span, which was inserted after the sweep and has no embedding, so the
      // vector lane cannot reach it either. Only trigrams can.
      const res = recall("coper wethervane squeeked");
      assert.ok(
        res.hits.some((h) => h.quote === "the copper weathervane squeaked at midnight"),
        "the misspelled question must still reach its own answer",
      );
    });

    await t.test("a question naming a month filters the answer to that month", () => {
      const withoutDate = recall("what happened to the brass lantern");
      const quotes = withoutDate.hits.map((h) => h.quote);
      assert.ok(quotes.includes(quoteLanternIn), "the control question must reach both lantern spans");
      assert.ok(quotes.includes(quoteLanternOut), "the control question must reach both lantern spans");

      const withDate = recall("what happened to the brass lantern in march 2024");
      const dated = withDate.hits.map((h) => h.quote);
      assert.ok(dated.includes(quoteLanternIn), "the march span must survive the filter");
      assert.ok(!dated.includes(quoteLanternOut), "the september span must be filtered out");
    });

    await t.test("a node reachable only through a why-edge still surfaces, with the why", () => {
      const res = recall("walnut desk restoration");
      const hinge = res.hits.find((h) => h.layer === "node" && h.title === NODE_TITLES[3]);
      assert.ok(hinge, "the neighbour one ratified hop away must surface");
      assert.equal(hinge.via_edge?.why, EDGE_WHY, "the hit must carry the why that surfaced it");
      assert.equal(hinge.via_edge?.from_title, NODE_TITLES[2]);

      const desk = res.hits.find((h) => h.layer === "node" && h.title === NODE_TITLES[2]);
      assert.ok(desk.score > hinge.score, "a neighbour never outranks the hit it hung off");
    });

    await t.test("an edge why is searchable in its own right", () => {
      const res = recall("one long afternoon of tidying");
      const titles = res.hits.filter((h) => h.layer === "node").map((h) => h.title);
      assert.ok(titles.includes(NODE_TITLES[2]), "both ends of the matching edge must surface");
      assert.ok(titles.includes(NODE_TITLES[3]), "both ends of the matching edge must surface");
    });

    await t.test("state missing: nothing relevant at all", () => {
      // Random letter-soup words: real English "gibberish" words turned out
      // to exist in the corpus (session spans quote this repo's own tests),
      // so the only guaranteed-absent tokens are ones minted per run.
      const soup = () =>
        Array.from({ length: 12 }, () => "bcdfghjklmnpqrstvwxz"[Math.floor(Math.random() * 20)]).join("");
      const res = recall(`${soup()} ${soup()} ${soup()} ${soup()}`);
      assert.equal(res.state, "missing");
      assert.equal(res.hits.length, 0);
    });

    await t.test("--json carries the documented shape", () => {
      const res = recall("tangerine kayak velvet stairs");
      assert.deepEqual(Object.keys(res).sort(), ["hits", "note", "question", "state"]);
      assert.equal(res.question, "tangerine kayak velvet stairs");
      for (const h of res.hits) {
        assert.ok(["node", "evidence"].includes(h.layer));
        assert.equal(typeof h.score, "number");
        if (h.layer === "evidence") {
          assert.ok(h.quote);
          assert.ok(h.provenance);
        } else {
          assert.ok(h.title);
        }
      }
    });

    await t.test("human-readable output labels evidence as unratified", () => {
      const out = execFileSync("node", [join(root, "scripts", "recall.mjs"), "tangerine kayak velvet stairs"], {
        encoding: "utf8",
        env: { ...process.env, BRAIN_SCHEMA: "brain_dev" },
      });
      assert.match(out, /unratified/i);
      assert.match(out, /tangerine kayak/);
    });
  } finally {
    // brain_dev-only cleanup, restrict-ordered; edges cascade with nodes.
    await client.query(
      `delete from brain_dev.evidence v using brain_dev.episodes e, brain_dev.sources s
       where v.episode_id = e.id and e.source_id = s.id and s.label = $1`,
      [TEST_LABEL],
    );
    await client.query(
      `delete from brain_dev.episodes e using brain_dev.sources s where e.source_id = s.id and s.label = $1`,
      [TEST_LABEL],
    );
    await client.query("delete from brain_dev.sources where label = $1", [TEST_LABEL]);
    await client.query("delete from brain_dev.nodes where title = any($1)", [NODE_TITLES]);
    await client.end();
  }
});

function loadEnvLocal() {
  try {
    const text = readFileSync(join(here, "..", ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
    }
  } catch {
    // no .env.local; rely on the environment
  }
}
