// The recall verb: find -> prove over the evidence store and the ratified
// brain. Usage: node scripts/recall.mjs "<question>" [--json]
//
// READ-ONLY by law: this file contains SELECT statements and nothing else;
// tests/sandbox-routing.test.mjs audits that claim on every run. Recall
// reads; it never writes (the processing-layer spec's non-goals).
//
// find: three lanes per layer, fused by reciprocal-rank fusion --
//   - exact/AND full-text (websearch semantics: every term must appear),
//   - OR full-text (fragments: some terms appear -- feeds "partial"),
//   - vector cosine over the local embeddings (paraphrase reach).
// Rows without embeddings still surface through the text lanes, so a sweep
// lag never hides evidence.
//
// prove: classify what the hits amount to, honestly:
//   supported    a ratified node carries it (brain truth, node named)
//   conflicting  ratified nodes disagree -- detected ONLY through a ratified
//                contradicts-edge why; the machine never infers disagreement
//   evidence     only unratified evidence carries it -- always labeled
//   partial      fragments surfaced but no direct answer
//   missing      nothing relevant at all
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schemaTables, makeClient } from "./brain.mjs";
import { embedQueryCached } from "./lib/embeddings.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const LANE_LIMIT = 12; // per-lane candidates before fusion
const MAX_HITS = 10; // hits shown after fusion
const RRF_K = 60; // standard reciprocal-rank-fusion damping constant

// Tony's words outrank the machine's at equal relevance: 85 percent of
// spans are assistant-voice, and "what did Tony say" must never drown his
// turns. Modest on purpose -- a clearly better assistant hit still wins.
const TONY_BOOST = 1.2;

// Cosine thresholds calibrated 2026-07-16 against nomic-embed-text-v1.5 on
// representative pairs: direct answers/paraphrases scored 0.73-0.77,
// topic-adjacent fragments ~0.58, natural-language junk at or below 0.43.
// One measured trap drives the corroboration rule below: garbage queries
// (random letter soup) score ~0.60 against machine-voice spans full of
// code tokens, overlapping the topic-adjacent band -- so a sub-STRONG
// vector hit is only trusted when a text lane also matched the same row;
// uncorroborated ones are indistinguishable from centroid noise and drop.
const SIM_STRONG = 0.65;
const SIM_FLOOR = 0.5;

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)} ...` : text;
}

// Dense ranks (equal lane scores share a rank) keep ties honest: two
// identical quotes fuse identically, and only deliberate boosts separate.
function rrfContributions(rows, scoreOf) {
  let rank = 0;
  let prev;
  return rows.map((row) => {
    const s = scoreOf(row);
    if (prev === undefined || s !== prev) {
      rank += 1;
      prev = s;
    }
    return { row, contribution: 1 / (RRF_K + rank) };
  });
}

async function findCandidates(client, tables, question, queryVec) {
  const evidenceSelect = `
    select v.id, v.quote, v.speaker,
           coalesce(v.occurred_at, e.occurred_at) as occurred_at,
           v.episode_id, e.source_locator, s.kind as source_kind, s.label as source_label`;
  const evidenceFrom = `
    from ${tables.evidence} v
    join ${tables.episodes} e on e.id = v.episode_id
    join ${tables.sources} s on s.id = e.source_id`;
  const nodeSelect = `select n.id, n.type, n.title, n.body, n.created_at`;

  // Lexemes of the question, for the OR lane (fragment matches). A row
  // counts as a fragment only when it holds at least two of the question's
  // lexemes (all of them for a one-word question): one stray shared word
  // inside a big machine span is corpus noise, not a fragment of the answer.
  const lex = await client.query("select tsvector_to_array(to_tsvector('english', $1)) as lex", [question]);
  const lexemes = lex.rows[0].lex ?? [];
  const quoted = lexemes.map((l) => `'${l.replace(/'/g, "''")}'`);
  const orQuery = quoted.join(" | ");
  const fragmentBar = Math.min(2, lexemes.length);

  const lanes = [];
  const run = async (name, layer, flag, sql, params) => {
    const { rows } = await client.query(sql, params);
    lanes.push({ name, layer, flag, rows });
  };

  await run(
    "evidence-and",
    "evidence",
    "strongLex",
    `${evidenceSelect}, ts_rank_cd(v.fts, websearch_to_tsquery('english', $1)) as lane_score
     ${evidenceFrom}
     where v.fts @@ websearch_to_tsquery('english', $1)
     order by lane_score desc limit ${LANE_LIMIT}`,
    [question],
  );
  await run(
    "nodes-and",
    "node",
    "strongLex",
    `${nodeSelect}, ts_rank_cd(n.fts, websearch_to_tsquery('english', $1)) as lane_score
     from ${tables.nodes} n
     where n.fts @@ websearch_to_tsquery('english', $1)
     order by lane_score desc limit ${LANE_LIMIT}`,
    [question],
  );
  if (orQuery) {
    await run(
      "evidence-or",
      "evidence",
      "weakLex",
      `${evidenceSelect}, ts_rank_cd(v.fts, to_tsquery('english', $1)) as lane_score
       ${evidenceFrom}
       where v.fts @@ to_tsquery('english', $1)
         and (select count(*) from unnest($2::text[]) ql where v.fts @@ to_tsquery('english', ql)) >= $3
       order by lane_score desc limit ${LANE_LIMIT}`,
      [orQuery, quoted, fragmentBar],
    );
    await run(
      "nodes-or",
      "node",
      "weakLex",
      `${nodeSelect}, ts_rank_cd(n.fts, to_tsquery('english', $1)) as lane_score
       from ${tables.nodes} n
       where n.fts @@ to_tsquery('english', $1)
         and (select count(*) from unnest($2::text[]) ql where n.fts @@ to_tsquery('english', ql)) >= $3
       order by lane_score desc limit ${LANE_LIMIT}`,
      [orQuery, quoted, fragmentBar],
    );
  }
  if (queryVec) {
    const vecLiteral = `[${queryVec.join(",")}]`;
    await run(
      "evidence-vec",
      "evidence",
      "vector",
      `${evidenceSelect}, 1 - (v.embedding <=> $1::vector) as lane_score
       ${evidenceFrom}
       where v.embedding is not null
       order by v.embedding <=> $1::vector limit ${LANE_LIMIT}`,
      [vecLiteral],
    );
    await run(
      "nodes-vec",
      "node",
      "vector",
      `${nodeSelect}, 1 - (n.embedding <=> $1::vector) as lane_score
       from ${tables.nodes} n
       where n.embedding is not null
       order by n.embedding <=> $1::vector limit ${LANE_LIMIT}`,
      [vecLiteral],
    );
  }

  // Fuse: one candidate per row across lanes, RRF-summed, flags merged.
  const byKey = new Map();
  for (const lane of lanes) {
    const rows = lane.flag === "vector" ? lane.rows.filter((r) => r.lane_score >= SIM_FLOOR) : lane.rows;
    for (const { row, contribution } of rrfContributions(rows, (r) => r.lane_score)) {
      const key = `${lane.layer}:${row.id}`;
      const cand = byKey.get(key) ?? { layer: lane.layer, row, score: 0, strongLex: false, weakLex: false, sim: null };
      cand.score += contribution;
      if (lane.flag === "strongLex") cand.strongLex = true;
      if (lane.flag === "weakLex") cand.weakLex = true;
      if (lane.flag === "vector") cand.sim = Math.max(cand.sim ?? 0, row.lane_score);
      byKey.set(key, cand);
    }
  }
  // The corroboration rule (see the threshold comment): a weak vector hit
  // with no lexical echo anywhere is centroid noise, not a fragment.
  const candidates = [...byKey.values()].filter(
    (c) => c.strongLex || c.weakLex || (c.sim ?? 0) >= SIM_STRONG,
  );
  for (const c of candidates) {
    if (c.layer === "evidence" && c.row.speaker === "tony") c.score *= TONY_BOOST;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_HITS);
}

// Bounded traversal, and ALL the traversal this phase gets: one hop of
// ratified why-edges out of each node hit. The graph holds 3 edges; the
// node-side retrieval subsystem stays dormant until its own trigger fires.
async function attachEdges(client, tables, candidates) {
  const nodeIds = candidates.filter((c) => c.layer === "node").map((c) => c.row.id);
  if (nodeIds.length === 0) return;
  const { rows } = await client.query(
    `select e.source, e.target, e.why, ns.title as source_title, nt.title as target_title
     from ${tables.edges} e
     join ${tables.nodes} ns on ns.id = e.source
     join ${tables.nodes} nt on nt.id = e.target
     where e.source = any($1::uuid[]) or e.target = any($1::uuid[])`,
    [nodeIds],
  );
  for (const c of candidates) {
    if (c.layer !== "node") continue;
    c.edges = rows.filter((e) => e.source === c.row.id || e.target === c.row.id);
  }
}

export function classifyState(candidates) {
  const isStrong = (c) => c.strongLex || (c.sim ?? 0) >= SIM_STRONG;
  const strongNodes = candidates.filter((c) => c.layer === "node" && isStrong(c));
  const strongEvidence = candidates.filter((c) => c.layer === "evidence" && isStrong(c));
  if (candidates.length === 0) return "missing";
  // Disagreement is never inferred by the machine: it counts only when Tony
  // ratified it himself, as a contradicts-flavored why on an edge touching
  // a strong node hit (the why vocabulary from the companion skill).
  if (strongNodes.some((n) => (n.edges ?? []).some((e) => /contradict/i.test(e.why)))) return "conflicting";
  if (strongNodes.length > 0) return "supported";
  if (strongEvidence.length > 0) return "evidence";
  return "partial";
}

const STATE_NOTES = {
  supported: "ratified brain truth; the nodes below carry it",
  conflicting: "ratified nodes disagree; both sides shown, neither picked",
  evidence: "unratified evidence only -- what a source captured, not brain truth",
  partial: "fragments surfaced but no direct answer is stored",
  missing: "nothing relevant found in the brain or the evidence store",
};

function toJsonHit(c) {
  if (c.layer === "node") {
    return {
      layer: "node",
      node_id: c.row.id,
      type: c.row.type,
      title: c.row.title,
      body: clip(c.row.body, 700),
      created_at: c.row.created_at,
      score: Number(c.score.toFixed(4)),
      edges: (c.edges ?? []).map((e) => ({ source_title: e.source_title, target_title: e.target_title, why: e.why })),
    };
  }
  return {
    layer: "evidence",
    quote: clip(c.row.quote, 700),
    speaker: c.row.speaker,
    score: Number(c.score.toFixed(4)),
    provenance: {
      episode_id: c.row.episode_id,
      source_kind: c.row.source_kind,
      source_label: c.row.source_label,
      source_locator: c.row.source_locator,
      occurred_at: c.row.occurred_at,
    },
  };
}

function isoDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : "undated";
}

function formatHuman(result) {
  const lines = [`QUESTION  ${result.question}`, `STATE     ${result.state} -- ${result.note}`, ""];
  if (result.hits.length === 0) {
    lines.push("(no hits)");
  }
  for (const h of result.hits) {
    if (h.layer === "node") {
      lines.push(`[node] ${h.title}  (${h.type || "untyped"}, ${isoDate(h.created_at)})  score ${h.score}`);
      lines.push(`  ${h.node_id}`);
      lines.push(`  readable: ${clip(h.body, 300)}`);
      for (const e of h.edges) {
        lines.push(`  edge: ${e.source_title} -> ${e.target_title}`);
        lines.push(`    why  ${e.why}`);
      }
    } else {
      const who = h.speaker ?? "unknown-speaker";
      lines.push(
        `[evidence, unratified] ${who}  ${isoDate(h.provenance.occurred_at)}  ${h.provenance.source_label} (${h.provenance.source_kind})  score ${h.score}`,
      );
      lines.push(`  "${clip(h.quote, 300)}"`);
      lines.push(`  episode ${h.provenance.episode_id}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function main() {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const question = args.filter((a) => a !== "--json")[0];
  if (!question || !question.trim()) {
    console.error('usage: node scripts/recall.mjs "<question>" [--json]');
    process.exit(1);
  }

  const schema = process.env.BRAIN_SCHEMA || "public";
  const tables = schemaTables(schema);

  // The vector lane degrades, never blocks: if the local model cannot load,
  // recall still answers from full-text and says so.
  let queryVec = null;
  let vectorNote = "";
  try {
    queryVec = await embedQueryCached(question);
  } catch (err) {
    vectorNote = ` (vector lane unavailable: ${err.message}; text lanes only)`;
  }

  const client = makeClient();
  await client.connect();
  try {
    const candidates = await findCandidates(client, tables, question, queryVec);
    await attachEdges(client, tables, candidates);
    const state = classifyState(candidates);
    const result = {
      question,
      state,
      note: STATE_NOTES[state] + vectorNote,
      hits: candidates.map(toJsonHit),
    };
    console.log(json ? JSON.stringify(result, null, 2) : formatHuman(result));
  } finally {
    await client.end();
  }
}

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

// Only query the database when run directly; importing for tests must not.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
