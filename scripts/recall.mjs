// The recall verb: find -> prove over the evidence store and the ratified
// brain. Usage: node scripts/recall.mjs "<question>" [--json], or import
// recall() and call it in-process -- the CLI is a thin wrapper over it, and a
// long-lived caller like the MCP server keeps the embedding model loaded
// between questions instead of paying a fresh load per spawn.
//
// READ-ONLY by law: this file contains SELECT statements and nothing else;
// tests/sandbox-routing.test.mjs audits that claim on every run. Recall
// reads; it never writes (the processing-layer spec's non-goals).
//
// find: the retrieval design the recall bench proved on a frozen 50,000-memory
// corpus, where it took Recall@10 from 0.697 to 0.977. Every piece of that
// design that does not depend on the bench's schema lives in
// scripts/lib/retrieval/ and is imported here, so the harness and the product
// cannot drift apart. Per layer:
//   - AND full-text (websearch semantics: every term must appear),
//   - OR full-text (fragments: some terms appear -- feeds "partial"),
//   - vector cosine over the local embeddings (paraphrase reach),
//   - pg_trgm word similarity (a mistyped question, or a rare token no
//     stemmer normalizes).
// Plus one lane the bench has no equivalent of: ratified edge whys, searched
// as text, with the nodes they join surfacing behind them.
// Lane weights are chosen per question (parseQueryFeatures/laneWeights), a
// question naming a month filters every lane by date, the lanes fuse by
// reciprocal-rank fusion, and a linear reranker refines the fused order.
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
import { disposeEmbeddingModel, embedQueryCached } from "./lib/embeddings.mjs";
import { retrievalDefaults as cfg } from "./lib/retrieval/config.mjs";
import { STOPWORDS, tokenize, stem } from "./lib/retrieval/text.mjs";
import { parseQueryFeatures, laneWeights } from "./lib/retrieval/features.mjs";
import { denseRanks, fuseRrf } from "./lib/retrieval/fuse.mjs";
import { rerank } from "./lib/retrieval/rerank.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const LANE_LIMIT = 24; // per-lane candidates before fusion
const RERANK_TOP_K = 25; // fused candidates the reranker sees
const MAX_HITS = 10; // hits shown after reranking

// The question's own words are asked about only this many at a time. A
// question longer than this is already answered by its first dozen content
// words, and every extra term costs a document-frequency probe.
const MAX_QUERY_TERMS = 12;
// Document frequency is counted up to this bound rather than exactly. idf only
// has to separate "in three rows" from "everywhere", and an exact count over a
// growing evidence store is a full scan for a number nothing reads precisely.
const DF_PROBE_CAP = 5000;

// Must match scripts/schema.sql's trigram index expressions exactly, or the
// index cannot serve the lane.
const TRIGRAM_QUOTE_CAP = 2000;
const TRIGRAM_NODE_CAP = 4000;

// Tony's words outrank the machine's at equal relevance: 85 percent of
// spans are assistant-voice, and "what did Tony say" must never drown his
// turns. Modest on purpose -- a clearly better assistant hit still wins.
const TONY_BOOST = 1.2;

// Two scales for the two ways a ratified edge can put a node in front of you.
//
// EDGE_WHY_SCALE applies when the why sentence itself matched the question. A
// why is about the connection, not about either node, so a node that only
// arrived because its edge's why matched sits below a node whose own text
// matched at the same rank. Half.
//
// EDGE_HOP_SCALE applies to the one-hop walk: a neighbour inherits this
// fraction of the score of the hit it hung off. The whole fused band is
// narrow -- a single-lane rank-1 hit scores about 0.0164 and a rank-10 one
// about 0.0143 -- so the choice decides one thing: how strong a parent has to
// be before its neighbour outranks a weak direct hit. At 0.35 a neighbour of
// a three-lane rank-1 parent (about 0.049) lands at 0.017, just above the
// weakest fragment, and a neighbour of an ordinary single-lane hit lands well
// below every direct hit. That is the intent: a ratified why is real evidence
// of relevance, worth more than the tail of a fragment lane and never worth
// more than the hit it came from.
const EDGE_WHY_SCALE = 0.5;
const EDGE_HOP_SCALE = 0.35;

// Cosine thresholds for nomic-embed-text-v1.5, recalibrated 2026-08-30
// against the brain_dev corpus (451 embedded spans of real session text).
// 150 random letter-soup queries landed at p50 0.6135, p99 0.6508, max
// 0.6510: garbage never scores near zero, because a nonsense query still
// lands somewhere in the machine-voice centroid. Real answers and
// paraphrases scored 0.72-0.87, the floor of that band being 0.7438 for a
// paraphrase with no shared words at all. STRONG sits in the empty gap
// between the two, with about 0.05 of margin on each side.
//
// The old 0.65 sat on the garbage ceiling itself and let roughly one soup
// query in fifty read as evidence. Note the ceiling is a max over the
// corpus, so it creeps up as brain_dev grows; re-measure when it does.
//
// SIM_FLOOR keeps the admission rule below: a sub-STRONG vector hit is
// trusted only when some other lane matched the same row. Uncorroborated ones
// are indistinguishable from centroid noise and drop.
const SIM_STRONG = 0.7;
const SIM_FLOOR = 0.5;

// One row earns "strong" the same way everywhere: an exact lexical match, or
// a vector hit clear of the garbage band. Fragments are handled separately.
const isStrongHit = (c) => c.strongLex || (c.sim ?? 0) >= SIM_STRONG;

// Recall asks one profile of the shared weighting rules: the query-dependent
// one the bench measured. The fixed-weight profiles exist only as bench
// baselines and have no product meaning.
const PROFILE = { weighting: "query-dependent" };

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)} ...` : text;
}

function quoteLexeme(t) {
  return `'${t.replace(/'/g, "''")}'`;
}

function paramBag() {
  const values = [];
  return {
    values,
    bind(v) {
      values.push(v);
      return `$${values.length}`;
    },
  };
}

// Document frequency for this question's own words, counted against the brain
// itself. Without it every question looks entirely out-of-vocabulary, which
// makes every short question look mistyped and hands the trigram lane a job it
// was not asked to do. One round trip, bounded by MAX_QUERY_TERMS probes.
//
// Frequencies move at the speed of the brain, not the question, and questions
// inside one session share words, so a term probed in the last ten minutes is
// remembered and a warm question skips this round trip entirely. Staleness
// only skews rarity weighting for that window; the lanes always search live
// data, so a just-saved memory is still found either way.
const VOCAB_TTL_MS = 10 * 60_000;
const VOCAB_CACHE_MAX = 512;
const vocabCache = new Map(); // "<evidence table>|<term>" -> { df, total, at }

async function loadQueryVocab(client, tables, question) {
  const { terms } = tokenize(question);
  const content = [...new Set(terms.filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t)))]
    .slice(0, MAX_QUERY_TERMS);
  if (content.length === 0) return { totalDocs: 1, df: new Map(), stem };

  const now = Date.now();
  const entries = [];
  const missing = [];
  for (const term of content) {
    const hit = vocabCache.get(`${tables.evidence}|${term}`);
    if (hit && now - hit.at <= VOCAB_TTL_MS) entries.push({ term, df: hit.df, total: hit.total });
    else missing.push(term);
  }

  if (missing.length > 0) {
    const { rows } = await client.query(
      `with totals as (
         select (select count(*) from ${tables.evidence}) + (select count(*) from ${tables.nodes}) as n
       )
       select t as term, totals.n as total,
              (select count(*) from (
                 select 1 from ${tables.evidence} v where v.fts @@ plainto_tsquery('english', t) limit ${DF_PROBE_CAP}
               ) ev)
            + (select count(*) from (
                 select 1 from ${tables.nodes} nd where nd.fts @@ plainto_tsquery('english', t) limit ${DF_PROBE_CAP}
               ) nx) as df
       from unnest($1::text[]) as t, totals`,
      [missing],
    );
    for (const row of rows) {
      const entry = { term: row.term, df: Number(row.df), total: Number(row.total) };
      entries.push(entry);
      // A zero is worth remembering too: an out-of-vocabulary word re-probed
      // every question would defeat the whole point.
      vocabCache.set(`${tables.evidence}|${row.term}`, { df: entry.df, total: entry.total, at: now });
    }
    while (vocabCache.size > VOCAB_CACHE_MAX) vocabCache.delete(vocabCache.keys().next().value);
  }

  const df = new Map();
  let totalDocs = 1;
  for (const entry of entries) {
    totalDocs = Math.max(totalDocs, entry.total);
    if (entry.df <= 0) continue;
    const key = stem(entry.term);
    df.set(key, Math.max(df.get(key) ?? 0, entry.df));
  }
  return { totalDocs, df, stem };
}

// One lane, one layer, one statement. Every lane returns the same envelope --
// the row's own payload, its lane score, its cosine, and whether it carries a
// rare word -- so fusion and reranking never care which lane a row came from.
function buildLaneSql(mode, layer, tables, ctx, p = paramBag()) {
  const isEvidence = layer === "evidence";
  const a = isEvidence ? "v" : "n";
  const occurredAt = isEvidence ? "coalesce(v.occurred_at, e.occurred_at)" : "n.created_at";
  const trigramText = isEvidence
    ? `left(v.quote, ${TRIGRAM_QUOTE_CAP})`
    : `left(n.title || ' ' || n.body, ${TRIGRAM_NODE_CAP})`;
  const payload = isEvidence
    ? `v.id, v.quote, v.speaker, ${occurredAt} as occurred_at,
       v.episode_id, e.source_locator, s.kind as source_kind, s.label as source_label`
    : `n.id, n.type, n.title, n.body, n.created_at, ${occurredAt} as occurred_at`;
  const from = isEvidence
    ? `from ${tables.evidence} v
       join ${tables.episodes} e on e.id = v.episode_id
       join ${tables.sources} s on s.id = e.source_id`
    : `from ${tables.nodes} n`;

  // Bound once and reused: the lane's own ordering and the cosine every lane
  // reports are the same 768-float literal, and binding it twice doubles the
  // bytes on the wire for nothing. When the lanes ride one fused statement,
  // ctx.vecParam is that statement's single shared binding of it.
  const vecParam = ctx.vecParam ?? (ctx.vecLiteral ? p.bind(ctx.vecLiteral) : null);

  let laneScore;
  let where;
  let orderBy;
  if (mode === "and") {
    const q = p.bind(ctx.question);
    laneScore = `ts_rank_cd(${a}.fts, websearch_to_tsquery('english', ${q}))`;
    where = `${a}.fts @@ websearch_to_tsquery('english', ${q})`;
    orderBy = "lane_score desc";
  } else if (mode === "or") {
    const q = p.bind(ctx.orQuery);
    const lex = p.bind(ctx.lexemes);
    const bar = p.bind(ctx.fragmentBar);
    laneScore = `ts_rank_cd(${a}.fts, to_tsquery('english', ${q}))`;
    // A row counts as a fragment only when it holds at least two of the
    // question's lexemes (all of them for a one-word question): one stray
    // shared word inside a big machine span is corpus noise, not a fragment.
    where = `${a}.fts @@ to_tsquery('english', ${q})
      and (select count(*) from unnest(${lex}::text[]) ql where ${a}.fts @@ to_tsquery('english', ql)) >= ${bar}`;
    orderBy = "lane_score desc";
  } else if (mode === "vector") {
    laneScore = `1 - (${a}.embedding <=> ${vecParam}::vector)`;
    where = `${a}.embedding is not null`;
    orderBy = `${a}.embedding <=> ${vecParam}::vector`;
  } else if (mode === "trigram") {
    const q = p.bind(ctx.trigramQuery);
    laneScore = `word_similarity(${q}, ${trigramText})`;
    where = `${q} <% ${trigramText}`;
    orderBy = "lane_score desc";
  } else {
    throw new Error(`buildLaneSql: unknown lane "${mode}"`);
  }

  const simExpr = vecParam ? `1 - (${a}.embedding <=> ${vecParam}::vector)` : "null::float";
  const rareExpr = ctx.rareQuery
    ? `(${a}.fts @@ to_tsquery('english', ${p.bind(ctx.rareQuery)}))`
    : "false";
  const dateClause = ctx.span
    ? ` and ${occurredAt} <@ tstzrange(${p.bind(ctx.span.from)}::timestamptz, ${p.bind(ctx.span.to)}::timestamptz, '[)')`
    : "";

  return {
    sql: `select ${payload},
       ${laneScore} as lane_score,
       ${simExpr} as sim,
       ${rareExpr} as rare_hit
     ${from}
     where ${where}${dateClause}
     order by ${orderBy} limit ${LANE_LIMIT}`,
    values: p.values,
  };
}

// The edge lane: a ratified why, searched as text. Both nodes it joins come
// back with it, because a why explains a connection and the connection has two
// ends. Never invents an edge -- only rows in the edges table can match.
function buildEdgeSql(mode, tables, question, orQuery, p = paramBag()) {
  const q = p.bind(mode === "and" ? question : orQuery);
  const match = mode === "and"
    ? `websearch_to_tsquery('english', ${q})`
    : `to_tsquery('english', ${q})`;
  return {
    sql: `select ed.id, ed.source, ed.target, ed.why,
            ns.title as source_title, nt.title as target_title,
            ts_rank_cd(ed.fts, ${match}) as lane_score
     from ${tables.edges} ed
     join ${tables.nodes} ns on ns.id = ed.source
     join ${tables.nodes} nt on nt.id = ed.target
     where ed.fts @@ ${match}
     order by lane_score desc, ed.id limit ${LANE_LIMIT}`,
    values: p.values,
  };
}

// Node rows for ids that arrived through an edge rather than through a lane,
// carrying the same cosine and rare-word columns the lanes produce so the
// reranker sees one shape.
function buildNodeFetchSql(tables, ids, ctx) {
  const p = paramBag();
  const idParam = p.bind(ids);
  const simExpr = ctx.vecLiteral
    ? `1 - (n.embedding <=> ${p.bind(ctx.vecLiteral)}::vector)`
    : "null::float";
  const rareExpr = ctx.rareQuery
    ? `(n.fts @@ to_tsquery('english', ${p.bind(ctx.rareQuery)}))`
    : "false";
  return {
    sql: `select n.id, n.type, n.title, n.body, n.created_at, n.created_at as occurred_at,
            0::float as lane_score, ${simExpr} as sim, ${rareExpr} as rare_hit
     from ${tables.nodes} n where n.id = any(${idParam}::uuid[])`,
    values: p.values,
  };
}

function candidateKey(layer, id) {
  return `${layer}:${id}`;
}

// Every lane, every matching edge, and every node row an edge drags in, as
// one statement. The brain sits behind a network whose round trip costs more
// than any of these queries costs to execute, so the per-lane loop that used
// to issue ten to fifteen statements per question was paying almost all of
// its latency to the wire. Each lane keeps its own SQL (the builders above),
// runs as its own limited CTE, and comes back tagged with a `lane` column;
// the union normalizes every arm onto one superset of columns, and the JS
// side splits the rows back into the per-lane buckets fusion always read.
function buildFusedSql(tables, ctx, laneJobs, edgeModes) {
  const p = paramBag();
  const fctx = { ...ctx, vecParam: ctx.vecLiteral ? p.bind(ctx.vecLiteral) : null };

  // A union matches its arms by POSITION, so every arm lays its columns out
  // in this exact order: lane, id, the evidence payload, the node payload,
  // the edge payload, then the three scores. Absent fields are typed nulls.
  const quoteNulls = `null::text as quote, null::text as speaker`;
  const provNulls = `null::uuid as episode_id, null::text as source_locator,
       null::text as source_kind, null::text as source_label`;
  const nodeNulls = `null::text as type, null::text as title, null::text as body, null::timestamptz as created_at`;
  const edgeNulls = `null::uuid as source, null::uuid as target, null::text as why,
       null::text as source_title, null::text as target_title`;

  const ctes = [];
  const arms = [];
  laneJobs.forEach(({ mode, layer }, i) => {
    const { sql } = buildLaneSql(mode, layer, tables, fctx, p);
    const cte = `lane_${i}`;
    ctes.push(`${cte} as (${sql})`);
    if (layer === "evidence") {
      arms.push(`select '${mode}:evidence' as lane, c.id,
       c.quote, c.speaker, c.occurred_at, c.episode_id, c.source_locator, c.source_kind, c.source_label,
       ${nodeNulls},
       ${edgeNulls},
       c.lane_score::float8 as lane_score, c.sim::float8 as sim, c.rare_hit
     from ${cte} c`);
    } else {
      arms.push(`select '${mode}:node' as lane, c.id,
       ${quoteNulls}, c.occurred_at, ${provNulls},
       c.type, c.title, c.body, c.created_at,
       ${edgeNulls},
       c.lane_score::float8 as lane_score, c.sim::float8 as sim, c.rare_hit
     from ${cte} c`);
    }
  });

  for (const mode of edgeModes) {
    const { sql } = buildEdgeSql(mode, tables, fctx.question, fctx.orQuery, p);
    const cte = `edge_${mode}`;
    ctes.push(`${cte} as (${sql})`);
    arms.push(`select 'edge-${mode}' as lane, c.id,
       ${quoteNulls}, null::timestamptz as occurred_at, ${provNulls},
       ${nodeNulls},
       c.source, c.target, c.why, c.source_title, c.target_title,
       c.lane_score::float8 as lane_score, null::float8 as sim, false as rare_hit
     from ${cte} c`);
  }

  if (edgeModes.length > 0) {
    // The node rows behind every matched edge come back in the same trip, so
    // hydrating endpoints never needs a statement of its own.
    const endpoints = edgeModes
      .map((mode) => `select source as id from edge_${mode} union select target from edge_${mode}`)
      .join(" union ");
    const simExpr = fctx.vecParam ? `1 - (n.embedding <=> ${fctx.vecParam}::vector)` : "null::float8";
    const rareExpr = fctx.rareQuery ? `(n.fts @@ to_tsquery('english', ${p.bind(fctx.rareQuery)}))` : "false";
    arms.push(`select 'edge-node' as lane, n.id,
       ${quoteNulls}, n.created_at as occurred_at, ${provNulls},
       n.type, n.title, n.body, n.created_at,
       ${edgeNulls},
       0::float8 as lane_score, ${simExpr}::float8 as sim, ${rareExpr} as rare_hit
     from ${tables.nodes} n
     where n.id in (${endpoints})`);
  }

  return { sql: `with ${ctes.join(",\n")}\n${arms.join("\nunion all\n")}`, values: p.values };
}

async function findCandidates(client, tables, question, queryVec, notes) {
  const vocab = await loadQueryVocab(client, tables, question);
  const features = parseQueryFeatures(question, vocab, cfg);
  const weights = laneWeights(features, PROFILE, cfg);

  const contentTerms = [...new Set(features.terms.filter((t) => !STOPWORDS.has(t)))].slice(0, MAX_QUERY_TERMS);
  const orQuery = contentTerms.map(quoteLexeme).join(" | ") || null;
  const fragmentBar = Math.min(2, contentTerms.length);
  // Rare words go back to the reranker as the words the person typed, not as
  // this file's stems: to_tsquery stems them again, and Postgres's stemmer is
  // the one that has to agree with the stored tsvector.
  const rareWords = contentTerms.filter((t) => features.rareTerms.includes(stem(t)));
  const rareQuery = rareWords.length > 0 ? rareWords.map(quoteLexeme).join(" | ") : null;
  const span = features.dateRange.from || features.dateRange.to
    ? { from: features.dateRange.from, to: features.dateRange.to }
    : null;

  const ctx = {
    question,
    // The trigram lane reads the question's content words only, never the raw
    // sentence. Measured against brain_dev: "where is the kite festival"
    // matched "where is the url to the site?" at word similarity above 0.4 on
    // the strength of "where is the" alone. A shared stopword prefix is not a
    // typo, and a lane meant to rescue misspellings must not rank on it.
    trigramQuery: contentTerms.join(" "),
    orQuery,
    lexemes: contentTerms,
    fragmentBar,
    vecLiteral: queryVec ? `[${queryVec.join(",")}]` : null,
    rareQuery,
    span,
  };

  // A lane weighted zero contributes nothing to the fused score, so running it
  // buys nothing and the trigram lane in particular costs roughly two seconds
  // against the real evidence store. Skipping it is not just an optimization:
  // a lane that cannot contribute must not be able to admit a row either.
  const active = [];
  for (const mode of ["and", "or", "vector", "trigram"]) {
    if ((weights[mode] ?? 0) === 0) continue;
    if (mode === "or" && !orQuery) continue;
    if (mode === "vector" && !ctx.vecLiteral) continue;
    if (mode === "trigram" && !ctx.trigramQuery) continue;
    active.push(mode);
  }

  if (active.includes("trigram")) {
    // pg_trgm's `<%` reads its cutoff from a session setting, which is the only
    // form that lets the GIN index do the filtering instead of a full scan.
    try {
      await client.query("select set_config('pg_trgm.word_similarity_threshold', $1, false)", [
        String(cfg.trigramThreshold),
      ]);
    } catch (err) {
      notes.push(`trigram lane unavailable (${err.message}); weighted 0`);
      active.splice(active.indexOf("trigram"), 1);
    }
  }

  const laneResults = {};
  const laneWeightsByName = {};
  const rowByKey = new Map();
  const flags = new Map();
  const whyByNode = new Map();
  const edgeEndpointIds = new Set();

  const flagsFor = (key) => {
    let f = flags.get(key);
    if (!f) {
      f = { strongLex: false, weakLex: false, trigramLex: false, viaEdge: false, sim: null, cosine: null, lexical: 0, rareHit: false };
      flags.set(key, f);
    }
    return f;
  };

  const laneJobs = [];
  for (const mode of active) for (const layer of ["evidence", "node"]) laneJobs.push({ mode, layer });

  const edgeModes = [];
  for (const mode of ["and", "or"]) {
    if ((weights[mode] ?? 0) === 0) continue;
    if (mode === "or" && !orQuery) continue;
    edgeModes.push(mode);
  }

  // Rows land in the same accumulators whichever transport brought them: the
  // fused single statement, or the per-lane fallback below it.
  const ingestLane = (mode, layer, laneRows) => {
    // The vector lane is the one lane that returns something for every
    // question, so it needs its own floor before anything else sees it.
    const rows = mode === "vector" ? laneRows.filter((r) => r.lane_score >= SIM_FLOOR) : laneRows;
    const laneName = `${mode}:${layer}`;
    laneWeightsByName[laneName] = weights[mode];
    laneResults[laneName] = denseRanks(rows, (r) => r.lane_score).map(({ row, rank }) => {
      const key = candidateKey(layer, row.id);
      rowByKey.set(key, row);
      const f = flagsFor(key);
      if (mode === "and") f.strongLex = true;
      if (mode === "or") f.weakLex = true;
      if (mode === "trigram") f.trigramLex = true;
      if (mode === "vector") f.sim = Math.max(f.sim ?? 0, row.lane_score);
      if (row.sim !== null && row.sim !== undefined) f.cosine = Math.max(f.cosine ?? 0, Number(row.sim));
      if (mode === "and" || mode === "or") f.lexical = Math.max(f.lexical, Number(row.lane_score));
      if (row.rare_hit) f.rareHit = true;
      return { key, rank };
    });
  };

  // The edge lane runs on the same lexical weights the node lanes got, scaled
  // down because a why explains the connection rather than either end of it.
  const ingestEdges = (mode, rows) => {
    const laneName = `edge-${mode}`;
    laneWeightsByName[laneName] = weights[mode] * EDGE_WHY_SCALE;
    const entries = [];
    for (const { row, rank } of denseRanks(rows, (r) => r.lane_score)) {
      for (const [end, otherTitle] of [[row.source, row.target_title], [row.target, row.source_title]]) {
        const key = candidateKey("node", end);
        entries.push({ key, rank });
        edgeEndpointIds.add(end);
        flagsFor(key).viaEdge = true;
        if (!whyByNode.has(key)) whyByNode.set(key, { from_title: otherTitle, why: row.why });
      }
    }
    laneResults[laneName] = entries;
  };

  let buckets = null;
  if (laneJobs.length > 0 || edgeModes.length > 0) {
    const { sql, values } = buildFusedSql(tables, ctx, laneJobs, edgeModes);
    try {
      const { rows } = await client.query(sql, values);
      buckets = new Map();
      for (const row of rows) {
        const list = buckets.get(row.lane);
        if (list) list.push(row);
        else buckets.set(row.lane, [row]);
      }
    } catch (err) {
      notes.push(`fused retrieval failed (${err.message}); per-lane fallback`);
    }
  }

  if (buckets) {
    // A union does not preserve per-arm order, so each bucket is re-sorted
    // the way its own statement used to return it. denseRanks gives tied
    // scores the same rank either way; the id tie-break only makes the order
    // deterministic.
    const laneOrder = (a, b) => b.lane_score - a.lane_score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const { mode, layer } of laneJobs) {
      ingestLane(mode, layer, (buckets.get(`${mode}:${layer}`) ?? []).sort(laneOrder));
    }
    for (const mode of edgeModes) {
      ingestEdges(mode, (buckets.get(`edge-${mode}`) ?? []).sort(laneOrder));
    }
    for (const row of buckets.get("edge-node") ?? []) {
      const key = candidateKey("node", row.id);
      if (!rowByKey.has(key)) rowByKey.set(key, row);
    }
  } else {
    for (const { mode, layer } of laneJobs) {
      const { sql, values } = buildLaneSql(mode, layer, tables, ctx);
      let rows;
      try {
        ({ rows } = await client.query(sql, values));
      } catch (err) {
        notes.push(`${mode} lane over ${layer} failed (${err.message}); skipped`);
        continue;
      }
      ingestLane(mode, layer, rows);
    }
    for (const mode of edgeModes) {
      const { sql, values } = buildEdgeSql(mode, tables, question, orQuery);
      let rows;
      try {
        ({ rows } = await client.query(sql, values));
      } catch (err) {
        notes.push(`edge lane unavailable (${err.message}); skipped`);
        break;
      }
      ingestEdges(mode, rows);
    }
    await hydrateNodes(client, tables, ctx, [...edgeEndpointIds], rowByKey);
  }

  const fused = fuseRrf(laneResults, laneWeightsByName, cfg.rrfK);

  let candidates = [];
  for (const [key, { rrf }] of fused) {
    const row = rowByKey.get(key);
    if (!row) continue; // an edge endpoint whose node row could not be read
    const f = flagsFor(key);
    candidates.push({
      key,
      id: key,
      layer: key.startsWith("node:") ? "node" : "evidence",
      row,
      rrf,
      strongLex: f.strongLex,
      weakLex: f.weakLex,
      trigramLex: f.trigramLex,
      viaEdge: f.viaEdge,
      sim: f.sim,
      cosine: f.cosine,
      lexical: f.lexical,
      rareHit: f.rareHit,
      via: whyByNode.get(key) ?? null,
    });
  }

  // The admission rule, and the reason letter soup gets no answer. A vector
  // score alone is only trusted when it clears the garbage band; below that a
  // row has to have been matched by some lane that reads actual words -- a
  // lexeme, a fragment, a trigram, or a ratified why. This is the same rule
  // the old two-lane find had, widened to the lanes that now exist.
  candidates = candidates.filter((c) => c.weakLex || c.trigramLex || c.viaEdge || isStrongHit(c));

  for (const c of candidates) {
    if (c.layer === "evidence" && c.row.speaker === "tony") c.rrf *= TONY_BOOST;
  }
  candidates.sort((a, b) => b.rrf - a.rrf);

  const edges = await expandOneHop(client, tables, ctx, candidates, rowByKey, whyByNode);
  candidates.sort((a, b) => b.rrf - a.rrf);

  for (const c of candidates) {
    if (c.layer !== "node") continue;
    c.edges = edges.filter((e) => e.source === c.row.id || e.target === c.row.id);
  }

  const shortlist = candidates.slice(0, RERANK_TOP_K);
  for (const c of shortlist) {
    c.features = {
      cosine: c.cosine ?? 0,
      lexical: c.lexical,
      rareHit: c.rareHit,
      titleHit: titleHit(features, c),
      dupGroup: null,
      occurredAt: c.row.occurred_at ? new Date(c.row.occurred_at).toISOString() : null,
      people: [],
      tags: [],
    };
  }
  const ranked = rerank(features, shortlist, cfg);
  return { hits: ranked.slice(0, MAX_HITS), features, weights };
}

// A quoted phrase in the question, found in a node's title. Evidence spans
// have no title, so this feature is a node-only signal.
function titleHit(features, candidate) {
  if (candidate.layer !== "node" || features.quoted.length === 0) return false;
  const title = String(candidate.row.title ?? "").toLowerCase();
  return features.quoted.some((phrase) => title.includes(phrase));
}

async function hydrateNodes(client, tables, ctx, ids, rowByKey) {
  const missing = ids.filter((id) => !rowByKey.has(candidateKey("node", id)));
  if (missing.length === 0) return;
  const { sql, values } = buildNodeFetchSql(tables, missing, ctx);
  const { rows } = await client.query(sql, values);
  for (const row of rows) rowByKey.set(candidateKey("node", row.id), row);
}

// Bounded traversal: exactly one hop of ratified why-edges out of the node
// hits that survived admission. The neighbour inherits EDGE_HOP_SCALE of its
// parent's fused score and the why sentence that reached it, and it never
// expands further -- one hop is the whole traversal this phase gets.
async function expandOneHop(client, tables, ctx, candidates, rowByKey, whyByNode) {
  const nodeIds = candidates.filter((c) => c.layer === "node").map((c) => c.row.id);
  if (nodeIds.length === 0) return [];

  // One trip: the edges out of the hits, and the node rows behind every
  // neighbour those edges reach, so arrivals never need a fetch of their own.
  const p = paramBag();
  const ids = p.bind(nodeIds);
  const vecParam = ctx.vecLiteral ? p.bind(ctx.vecLiteral) : null;
  const simExpr = vecParam ? `1 - (n.embedding <=> ${vecParam}::vector)` : "null::float8";
  const rareExpr = ctx.rareQuery ? `(n.fts @@ to_tsquery('english', ${p.bind(ctx.rareQuery)}))` : "false";

  let rows;
  try {
    ({ rows } = await client.query(
      `with hop as (
         select ed.id, ed.source, ed.target, ed.why,
                ns.title as source_title, nt.title as target_title
         from ${tables.edges} ed
         join ${tables.nodes} ns on ns.id = ed.source
         join ${tables.nodes} nt on nt.id = ed.target
         where ed.source = any(${ids}::uuid[]) or ed.target = any(${ids}::uuid[])
       )
       select 'edge' as kind, h.id, h.source, h.target, h.why, h.source_title, h.target_title,
              null::text as type, null::text as title, null::text as body,
              null::timestamptz as created_at, null::timestamptz as occurred_at,
              null::float8 as sim, false as rare_hit
       from hop h
       union all
       select 'node' as kind, n.id, null::uuid as source, null::uuid as target, null::text as why,
              null::text as source_title, null::text as target_title,
              n.type, n.title, n.body, n.created_at, n.created_at as occurred_at,
              ${simExpr}::float8 as sim, ${rareExpr} as rare_hit
       from ${tables.nodes} n
       where n.id in (select source from hop union select target from hop)
         and not (n.id = any(${ids}::uuid[]))`,
      p.values,
    ));
  } catch {
    return [];
  }
  const edges = rows.filter((r) => r.kind === "edge");
  if (edges.length === 0) return edges;
  for (const row of rows) {
    if (row.kind !== "node") continue;
    const key = candidateKey("node", row.id);
    if (!rowByKey.has(key)) rowByKey.set(key, row);
  }

  const byNodeId = new Map(candidates.filter((c) => c.layer === "node").map((c) => [c.row.id, c]));
  const arrivals = new Map(); // neighbour node id -> { rrf, via }
  for (const edge of edges) {
    for (const [from, to, otherTitle] of [
      [edge.source, edge.target, edge.source_title],
      [edge.target, edge.source, edge.target_title],
    ]) {
      const parent = byNodeId.get(from);
      if (!parent || byNodeId.has(to)) continue; // already a hit in its own right
      const gain = parent.rrf * EDGE_HOP_SCALE;
      const seen = arrivals.get(to);
      if (!seen || gain > seen.rrf) {
        arrivals.set(to, { rrf: gain, via: { from_title: otherTitle, why: edge.why } });
      }
    }
  }
  if (arrivals.size === 0) return edges;

  for (const [id, arrival] of arrivals) {
    const key = candidateKey("node", id);
    const row = rowByKey.get(key);
    if (!row) continue;
    if (!whyByNode.has(key)) whyByNode.set(key, arrival.via);
    candidates.push({
      key,
      id: key,
      layer: "node",
      row,
      rrf: arrival.rrf,
      strongLex: false,
      weakLex: false,
      trigramLex: false,
      viaEdge: true,
      // A neighbour arrives on the strength of a ratified why, never on its
      // own retrieval score, so it can never make a question look answered.
      sim: null,
      cosine: row.sim === null || row.sim === undefined ? null : Number(row.sim),
      lexical: 0,
      rareHit: Boolean(row.rare_hit),
      via: whyByNode.get(key),
    });
  }
  return edges;
}

export function classifyState(candidates) {
  const strongNodes = candidates.filter((c) => c.layer === "node" && isStrongHit(c));
  const strongEvidence = candidates.filter((c) => c.layer === "evidence" && isStrongHit(c));
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
  const score = Number((c.rerankScore ?? c.rrf).toFixed(4));
  if (c.layer === "node") {
    return {
      layer: "node",
      node_id: c.row.id,
      type: c.row.type,
      title: c.row.title,
      body: clip(c.row.body, 700),
      created_at: c.row.created_at,
      score,
      via_edge: c.via ? { from_title: c.via.from_title, why: c.via.why } : null,
      edges: (c.edges ?? []).map((e) => ({ source_title: e.source_title, target_title: e.target_title, why: e.why })),
    };
  }
  return {
    layer: "evidence",
    quote: clip(c.row.quote, 700),
    speaker: c.row.speaker,
    score,
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
      if (h.via_edge) {
        lines.push(`  surfaced through ${h.via_edge.from_title}`);
        lines.push(`    why  ${h.via_edge.why}`);
      }
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

/**
 * One question, answered: exactly the object the `--json` CLI prints, as a
 * value -- { question, state, note, hits }. The CLI below is a thin wrapper
 * over this, and the MCP server calls it directly so the embedding model
 * loads once for the life of that process instead of once per question.
 *
 * A caller holding its own connected client passes it in and keeps it; without
 * one this opens a client and closes it again. Tearing the model down is the
 * CLI's job alone, never this function's.
 */
export async function recall(question, options = {}) {
  const { client, schema = process.env.BRAIN_SCHEMA || "public", embedQuery = embedQueryCached } = options;
  if (client) return answerQuestion(client, question, schema, embedQuery);
  const own = makeClient();
  await own.connect();
  try {
    return await answerQuestion(own, question, schema, embedQuery);
  } finally {
    await own.end();
  }
}

async function answerQuestion(client, question, schema, embedQuery) {
  const tables = schemaTables(schema);

  // The vector lane degrades, never blocks: if the local model cannot load,
  // recall still answers from full-text and says so.
  const notes = [];
  let queryVec = null;
  try {
    queryVec = await embedQuery(question);
  } catch (err) {
    notes.push(`vector lane unavailable (${err.message}); text lanes only`);
  }

  const { hits } = await findCandidates(client, tables, question, queryVec, notes);
  const state = classifyState(hits);
  return {
    question,
    state,
    note: STATE_NOTES[state] + (notes.length > 0 ? ` (${notes.join("; ")})` : ""),
    hits: hits.map(toJsonHit),
  };
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

  try {
    const result = await recall(question);
    console.log(json ? JSON.stringify(result, null, 2) : formatHuman(result));
  } finally {
    // The one place the model is torn down. A resident caller keeps it loaded
    // for the next question; this process is about to exit anyway.
    await disposeEmbeddingModel();
  }
}

export function loadEnvLocal() {
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
