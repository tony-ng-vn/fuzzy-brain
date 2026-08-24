// bench-recall.mjs -- the quality bench (claim A, DESIGN.md section 5).
//
// Runs a query split through engine.mjs, reports Recall@1/5/10/20 and MRR@10
// overall and per family, a bootstrap CI on Recall@10, the ablation ladder
// (section 5.1), and -- with --taxonomy -- a per-query failure cause plus a
// taxonomy summary (section 5.2).
//
// This file was written against DESIGN.md's explicit contracts (config shape
// in 3.4, record shapes in 3.1-3.3, and the engine/rerank/safety function
// signatures in 3.6). A few sibling files that this module depends on do not
// specify an exact shape in DESIGN.md, because they are owned by other
// parallel tracks and DESIGN.md only names their responsibility, not their
// API. Those spots are marked "ASSUMED" below so integration can find them
// fast. See the task summary for the full list.

import { parseArgs } from 'node:util';
import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, resolveTier } from './config.mjs';
import { assertBenchTarget, benchClient } from './lib/safety.mjs';
// ASSUMED: lib/jsonl.mjs exports an async-iterable line reader and a bulk
// array writer. Both are the minimal shape a "streaming read/write" helper
// needs; DESIGN.md names the file's job (section 2) but not its signatures.
import { readJsonl, writeJsonl } from './lib/jsonl.mjs';
// ASSUMED: lib/stats.mjs exports at least mean() and a bootstrap CI helper
// over an array of values, returning { point, lower, upper }.
import { mean, bootstrapCI } from './lib/stats.mjs';
// ASSUMED: lib/report.mjs exports a console table renderer shared with
// bench-load.mjs. Signature guessed as printTable(title, headers, rows).
import { printTable } from './lib/report.mjs';
// buildMemoryIndex is the one function gen-corpus.mjs exposes that produces
// a corpus-wide vocabulary/idf structure, and engine.mjs's parseQueryFeatures
// takes a "vocab" of unspecified shape. Reusing buildMemoryIndex's output as
// that vocab is the only wiring that does not invent a shape neither track
// declared (see task summary, deviation 1).
import { buildMemoryIndex } from './gen-corpus.mjs';
import { parseQueryFeatures, retrieve } from './engine.mjs';
import { rerank } from './rerank.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outDirFor = (tierName) => path.join(HERE, '.out', tierName);

// ---------------------------------------------------------------------------
// Family -> lane table, transcribed from DESIGN.md section 4.1. Used only to
// annotate the taxonomy summary with "which lane should have caught it"; it
// never influences retrieval or the recall number itself.
// ---------------------------------------------------------------------------
const EXPECTED_LANE_BY_FAMILY = {
  paraphrase_nolex: { breaks: 'and/or (no shared stems)', earnsBack: 'vector, up-weighted when looksParaphrase' },
  rare_token: { breaks: 'vector (rare token barely moves the embedding)', earnsBack: 'and lane on high maxIdf, plus the rareHit rerank feature' },
  entity_swap: { breaks: 'vector (near-identical sentences)', earnsBack: 'entity extraction + entity rerank feature + and-lane boost' },
  near_dup: { breaks: 'lexical and vector (siblings crowd top 10)', earnsBack: 'dupPenalty rerank feature + the distinguisher term' },
  date_filter: { breaks: 'every lane without metadata', earnsBack: 'closed-world date parsing -> occurred_at filter + dateFit rerank feature' },
  partial_ref: { breaks: 'and lane (too few matching terms)', earnsBack: 'or lane with a fragment bar, fused with vector' },
  typo_noisy: { breaks: 'and lane (nothing); or lane (noise)', earnsBack: 'trigram lane, activated when oovRatio crosses the floor' },
};

// ---------------------------------------------------------------------------
// Ablation ladder (section 5.1). Rungs 2-4 are not named profiles in
// config.mjs -- only naive, fixedRrf, tuned, tunedScale are -- so the
// intermediate rungs are assembled here from fixedRrf/tuned's own fields.
// Rung 5 reuses config.profiles.tuned directly so it is exactly the tuned
// profile, not a hand-rebuilt copy that could drift from it.
// ---------------------------------------------------------------------------
function buildAblationRungs(cfg) {
  const base = cfg.profiles.fixedRrf;
  return [
    { rung: 0, label: 'naive', profile: cfg.profiles.naive },
    { rung: 1, label: 'fixedRrf', profile: cfg.profiles.fixedRrf },
    { rung: 2, label: '+query-dependent weights', profile: { lanes: base.lanes, weighting: 'query-dependent', filters: false, rerank: false } },
    { rung: 3, label: '+trigram lane', profile: { lanes: [...base.lanes, 'trigram'], weighting: 'query-dependent', filters: false, rerank: false } },
    { rung: 4, label: '+metadata filters', profile: { lanes: [...base.lanes, 'trigram'], weighting: 'query-dependent', filters: true, rerank: false } },
    { rung: 5, label: 'tuned', profile: cfg.profiles.tuned },
  ];
}

function resolveProfile(cfg, name) {
  if (cfg.profiles[name]) return cfg.profiles[name];
  const rungAlias = { rung2: 2, rung3: 3, rung4: 4 }[name];
  if (rungAlias != null) {
    return buildAblationRungs(cfg).find((r) => r.rung === rungAlias).profile;
  }
  throw new Error(`unknown --profile "${name}"; expected one of ${Object.keys(cfg.profiles).join(', ')}, rung2, rung3, rung4`);
}

// ---------------------------------------------------------------------------
// Corpus artifact loading
// ---------------------------------------------------------------------------
async function loadJsonlArray(filePath) {
  const out = [];
  for await (const record of readJsonl(filePath)) out.push(record);
  return out;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256OfFile(filePath) {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

// The query-vector cache format (section 7, rung 2) is written by load.mjs,
// a sibling file this module does not own. DESIGN.md never pins down its
// byte layout, so this is the one binary contract this file had to invent:
// a flat little-endian Float32Array, dev queries first in queries-dev.jsonl
// file order, then test queries in queries-test.jsonl file order, each query
// occupying tier.dims consecutive floats. If load.mjs lands with a different
// layout, this is the function to reconcile (task summary, deviation 2).
async function loadQueryVectorCache(cachePath, tierCfg, devCount, testCount) {
  const buf = await readFile(cachePath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const flat = new Float32Array(arrayBuffer);
  const dims = tierCfg.dims;
  const expected = (devCount + testCount) * dims;
  if (flat.length < expected) {
    throw new Error(`query-vectors cache too short: have ${flat.length} floats, need ${expected} (dev ${devCount} + test ${testCount} at dims=${dims})`);
  }
  const sliceAt = (blockOffset, index) => flat.subarray(blockOffset + index * dims, blockOffset + index * dims + dims);
  return {
    dev: (i) => sliceAt(0, i),
    test: (i) => sliceAt(devCount * dims, i),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function rankOfTarget(hits, targetId) {
  const idx = hits.findIndex((h) => h.id === targetId);
  return idx === -1 ? null : idx + 1; // 1-based rank, null if absent from returned hits
}

function computeMetrics(perQuery) {
  // perQuery: [{ family, rank }] where rank is 1-based or null
  const n = perQuery.length;
  const recallAt = (k) => n === 0 ? 0 : perQuery.filter((q) => q.rank != null && q.rank <= k).length / n;
  const mrrAt10 = n === 0 ? 0 : mean(perQuery.map((q) => (q.rank != null && q.rank <= 10 ? 1 / q.rank : 0)));

  const byFamily = {};
  for (const q of perQuery) {
    byFamily[q.family] ??= [];
    byFamily[q.family].push(q);
  }
  const perFamily = Object.fromEntries(
    Object.entries(byFamily).map(([family, rows]) => [
      family,
      { n: rows.length, recallAt10: rows.filter((r) => r.rank != null && r.rank <= 10).length / rows.length },
    ]),
  );

  const hitsAt10 = perQuery.map((q) => (q.rank != null && q.rank <= 10 ? 1 : 0));
  const ci = n > 0 ? bootstrapCI(hitsAt10, { resamples: 10_000, level: 0.95 }) : { point: 0, lower: 0, upper: 0 };

  return {
    n,
    recallAt1: recallAt(1),
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    recallAt20: recallAt(20),
    mrrAt10,
    recallAt10CI: ci,
    perFamily,
  };
}

// ---------------------------------------------------------------------------
// Failure taxonomy (section 5.2). Priority order is this file's own choice --
// DESIGN.md lists seven buckets but does not state a decision order when more
// than one condition applies to the same miss. The order below checks the
// most specific, most actionable cause first (a filter that silently drops
// the right answer, or a known crowding/confusion pattern) and only falls
// back to the generic fusion/rerank buckets when nothing more specific fits.
// See task summary, deviation 3.
// ---------------------------------------------------------------------------
function checkFilterExclusion(qf, targetMemory) {
  if (!targetMemory) return null;
  if (qf?.dateRange && (qf.dateRange.from || qf.dateRange.to)) {
    const occurred = new Date(targetMemory.occurred_at);
    const from = qf.dateRange.from ? new Date(qf.dateRange.from) : null;
    const to = qf.dateRange.to ? new Date(qf.dateRange.to) : null;
    const outside = (from && occurred < from) || (to && occurred > to);
    if (outside) return 'date_misparse';
  }
  // Must mirror resolveFilters: only confident mentions become a hard filter,
  // so only those can be what excluded the target.
  const filteringPeople = qf?.entities?.peopleConfident ?? qf?.entities?.people;
  if (filteringPeople?.length) {
    const overlap = filteringPeople.some((p) => targetMemory.people?.includes(p));
    if (!overlap) return 'filter_excluded';
  }
  return null;
}

export function classifyFailure({ qf, targetId, targetMemory, result, profile, distractorIds, memoriesById, oracleSolvingLanes }) {
  if (profile.filters) {
    const cause = checkFilterExclusion(qf, targetMemory);
    if (cause) return { cause, detail: 'an inferred metadata filter excluded the ground-truth target' };
  }

  const laneHasTarget = Object.values(result.lanes ?? {}).some((ids) => ids.includes(targetId));
  if (!laneHasTarget) {
    // The verified oracle (load.mjs --verify-oracle's certificate.signals),
    // not this profile's own lane set, is what "the certificate promised"
    // refers to. A profile that never runs the trigram lane (naive, fixedRrf)
    // will always show laneHasTarget=false for a typo query only trigram
    // solves; that is a profile limitation, not the generator bug this
    // bucket exists to catch. Reserve not_retrieved for the case where no
    // lane in the whole engine -- per the oracle -- reaches the target.
    //
    // oracleSolvingLanes must be the already-thresholded certificate.signals
    // list (rank <= config.oracle.bestLaneRankAt), not a raw null-check over
    // lane_ranks_measured: vector_rank is an exact, uncapped global rank
    // (load.mjs's buildOracleSql counts the whole table), so it is never
    // null and a bare null-check would count "vector rank 40,000" as a
    // solving lane and silently empty the not_retrieved gate.
    const solvingLanes = oracleSolvingLanes ?? [];
    if (solvingLanes.length === 0) {
      return { cause: 'not_retrieved', detail: 'target absent from every lane at configured depth; the certificate promised otherwise' };
    }
    const missingFromProfile = solvingLanes.filter((lane) => !profile.lanes.includes(lane));
    return {
      cause: 'lost_in_fusion',
      detail: missingFromProfile.length > 0
        ? `oracle reaches the target via ${solvingLanes.join(', ')}, which this profile's lane set (${profile.lanes.join(', ')}) omits`
        : `oracle reaches the target via ${solvingLanes.join(', ')}, all present in this profile, but it was outside the top 50 fused candidates`,
    };
  }

  const top10 = result.hits.slice(0, 10);

  const targetDupGroup = targetMemory?.dup_group ?? null;
  if (targetDupGroup != null) {
    const siblingsAbove = top10.filter((h) => memoriesById.get(h.id)?.dup_group === targetDupGroup).length;
    if (siblingsAbove >= 3) {
      return { cause: 'crowded_by_dups', detail: `${siblingsAbove} of the top 10 are members of the target's dup_group` };
    }
  }

  if (distractorIds?.length) {
    const distractorSet = new Set(distractorIds);
    const distractorCount = top10.filter((h) => distractorSet.has(h.id)).length;
    if (distractorCount >= 5) {
      return { cause: 'entity_confusion', detail: `${distractorCount} of the top 10 are known distractor_ids` };
    }
  }

  const byRrf = [...result.hits].sort((a, b) => b.rrf - a.rrf);
  const fusedRank = rankOfTarget(byRrf, targetId);
  if (fusedRank != null && fusedRank <= 10) {
    return { cause: 'lost_in_rerank', detail: `fused rank ${fusedRank}, outside the top 10 after rerank` };
  }
  return { cause: 'lost_in_fusion', detail: fusedRank == null ? 'outside the top 50 fused candidates' : `fused rank ${fusedRank}` };
}

// ---------------------------------------------------------------------------
// Running one profile over one split
// ---------------------------------------------------------------------------
async function runProfile({ client, queries, vectorsFor, profile, baseCtx }) {
  const results = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const ctx = { ...baseCtx, profile, queryVector: vectorsFor(q.vecIndex ?? i) };
    const filters = baseCtx.useDeclaredFilters ? q.declared_filters : undefined;
    const result = await retrieve(client, { text: q.text, filters }, ctx);
    const targetId = q.targets[0];
    const rank = rankOfTarget(result.hits, targetId);
    results.push({ qid: q.qid, family: q.family, targetId, rank, result, query: q });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { values: args } = parseArgs({
    options: {
      tier: { type: 'string' },
      profile: { type: 'string', default: 'tuned' },
      split: { type: 'string', default: 'test' },
      ablation: { type: 'boolean', default: false },
      limit: { type: 'string' },
      out: { type: 'string' },
      taxonomy: { type: 'boolean', default: false },
      'declared-filters': { type: 'boolean', default: false },
      // Dev-loop convenience: restrict the run to one or more comma-separated
      // families so a per-family experiment does not pay for the whole split.
      // Query SELECTION only -- computeMetrics is untouched, and the flag is
      // rejected on the test split so a headline number can never come from a
      // subset of it.
      family: { type: 'string' },
    },
  });

  if (!args.tier) throw new Error('bench-recall.mjs requires --tier <name>');
  // resolveTier composes tiers + corpus knobs; engine.mjs reads tier.dims and
  // tier.schema, buildMemoryIndex needs the same tier the corpus was built from.
  const tierCfg = resolveTier(args.tier);
  if (args.split !== 'dev' && args.split !== 'test') throw new Error('--split must be "dev" or "test"');

  // Section 3.7: every script prints its resolved target and tier schema on
  // line one, before anything else runs, so a misconfigured target is
  // visible before any query executes.
  console.log(`bench-recall: target=${config.db.url} tier=${args.tier} schema=${tierCfg.schema}`);

  assertBenchTarget(config.db.url);

  const outDir = outDirFor(args.tier);
  const memoriesPath = path.join(outDir, 'memories.jsonl');

  // Section 4.4 step 9: the test split refuses to run without a matching
  // CORPUS.lock, and every test-split run is appended to TEST-RUNS.log.
  // ASSUMED: CORPUS.lock is JSON and its memory-hash field is named
  // memoriesSha256 (falling back to a couple of plausible alternates); it
  // is gen-corpus.mjs, a sibling file, that actually writes this file.
  if (args.split === 'test') {
    const lockPath = path.join(outDir, 'CORPUS.lock');
    if (!(await fileExists(lockPath))) {
      throw new Error(`refusing to run the test split: ${lockPath} does not exist (run gen-corpus.mjs --verify first)`);
    }
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const lockedHash = lock.memoriesSha256 ?? lock.sha256 ?? lock.memories_sha256 ?? lock.hash;
    const actualHash = await sha256OfFile(memoriesPath);
    if (!lockedHash || lockedHash !== actualHash) {
      throw new Error(`refusing to run the test split: memories.jsonl hash does not match CORPUS.lock (locked=${lockedHash}, actual=${actualHash})`);
    }
  }

  const memories = await loadJsonlArray(memoriesPath);
  const memoriesById = new Map(memories.map((m) => [m.id, m]));
  const vocab = buildMemoryIndex(memories);

  const queriesPath = path.join(outDir, `queries-${args.split}.jsonl`);
  // The query-vector cache is positional over the UNFILTERED split, so the
  // original row index has to travel with the query or any subsetting below
  // would silently pair each query with another query's embedding.
  let queries = (await loadJsonlArray(queriesPath)).map((q, i) => ({ ...q, vecIndex: i }));
  if (args.family) {
    if (args.split === 'test') throw new Error('--family is a dev-loop flag; the test split is always run whole');
    const wanted = new Set(args.family.split(',').map((f) => f.trim()).filter(Boolean));
    queries = queries.filter((q) => wanted.has(q.family));
    if (queries.length === 0) throw new Error(`--family "${args.family}" matched no queries in ${queriesPath}`);
  }
  const limit = args.limit ? Number.parseInt(args.limit, 10) : null;
  if (limit) queries = queries.slice(0, limit);

  const devQueriesRaw = await loadJsonlArray(path.join(outDir, 'queries-dev.jsonl'));
  const testQueriesRaw = await loadJsonlArray(path.join(outDir, 'queries-test.jsonl'));
  const vectorCache = await loadQueryVectorCache(
    path.join(outDir, 'query-vectors.f32'),
    tierCfg,
    devQueriesRaw.length,
    testQueriesRaw.length,
  );
  const vectorsFor = (i) => (args.split === 'dev' ? vectorCache.dev(i) : vectorCache.test(i));

  const client = benchClient();
  await client.connect();

  try {
    const baseCtx = {
      // engine.mjs's EngineContext.tier is the resolved tier object (it reads
      // tier.schema/tier.vector/tier.dims directly, per DESIGN.md 3.6's
      // buildRetrievalSql(tier, profile) signature) -- a bare tier name
      // string here produces "undefined.memories" from planStatement.
      tier: tierCfg,
      cfg: config,
      vocab,
      useDeclaredFilters: args['declared-filters'],
    };

    const report = { tier: args.tier, split: args.split, generatedAt: new Date().toISOString() };

    if (args.ablation) {
      const rungs = buildAblationRungs(config);
      const rungRows = [];
      let previousRecall10 = null;
      for (const { rung, label, profile } of rungs) {
        const ctx = { ...baseCtx, rerank: profile.rerank ? rerank : undefined };
        const results = await runProfile({ client, queries, vectorsFor, profile, baseCtx: ctx });
        const metrics = computeMetrics(results.map((r) => ({ family: r.family, rank: r.rank })));
        const regressed = previousRecall10 != null && metrics.recallAt10 < previousRecall10;
        rungRows.push([rung, label, metrics.recallAt10.toFixed(3), metrics.recallAt5.toFixed(3), metrics.mrrAt10.toFixed(3), regressed ? 'REGRESSED' : '']);
        previousRecall10 = metrics.recallAt10;
      }
      printTable('Ablation ladder', ['rung', 'profile', 'recall@10', 'recall@5', 'mrr@10', 'note'], rungRows);
      report.ablation = rungs.map((r, i) => ({ rung: r.rung, label: r.label, row: rungRows[i] }));
    }

    const profile = resolveProfile(config, args.profile);
    const ctx = { ...baseCtx, rerank: profile.rerank ? rerank : undefined };
    const results = await runProfile({ client, queries, vectorsFor, profile, baseCtx: ctx });
    const metrics = computeMetrics(results.map((r) => ({ family: r.family, rank: r.rank })));

    const oracleCeilingPath = path.join(outDir, 'oracle.json');
    const oracle = (await fileExists(oracleCeilingPath)) ? JSON.parse(await readFile(oracleCeilingPath, 'utf8')) : null;

    report.profile = args.profile;
    report.metrics = metrics;
    report.oracle = oracle;

    printTable(
      `Recall (${args.profile}, ${args.split})`,
      ['metric', 'value'],
      [
        ['n', metrics.n],
        ['recall@1', metrics.recallAt1.toFixed(3)],
        ['recall@5', metrics.recallAt5.toFixed(3)],
        ['recall@10', metrics.recallAt10.toFixed(3)],
        ['recall@10 95% CI', `[${metrics.recallAt10CI.lower.toFixed(3)}, ${metrics.recallAt10CI.upper.toFixed(3)}]`],
        ['recall@20', metrics.recallAt20.toFixed(3)],
        ['mrr@10', metrics.mrrAt10.toFixed(3)],
        ['oracle best-lane-rank@10', oracle ? oracle.overall?.bestLaneRankAt10 ?? oracle.bestLaneRankAt10 ?? 'n/a' : 'not generated'],
      ],
    );
    printTable(
      'Per-family recall@10',
      ['family', 'n', 'recall@10', 'expected lane (breaks / earns back)'],
      Object.entries(metrics.perFamily).map(([family, m]) => [
        family,
        m.n,
        m.recallAt10.toFixed(3),
        EXPECTED_LANE_BY_FAMILY[family] ? `${EXPECTED_LANE_BY_FAMILY[family].breaks} / ${EXPECTED_LANE_BY_FAMILY[family].earnsBack}` : 'n/a',
      ]),
    );

    let gatePassed = true;

    if (args.taxonomy) {
      const failures = results.filter((r) => r.rank == null || r.rank > 10);
      const failureRecords = [];
      const byCause = {};
      const byFamily = {};

      for (const f of failures) {
        const qf = parseQueryFeatures(f.query.text, vocab, config);
        const distractorIds = f.query.diagnostics?.distractor_ids ?? [];
        const targetMemory = memoriesById.get(f.targetId);
        const { cause, detail } = classifyFailure({
          qf,
          targetId: f.targetId,
          targetMemory,
          result: f.result,
          profile,
          distractorIds,
          memoriesById,
          // certificate.signals is meaningful only once load.mjs
          // --verify-oracle has run (DESIGN.md 4.3.1); pre-verify it lists
          // only 'and'/'or'/'trigram' and never 'vector' (see gen-corpus.mjs
          // computeCertificateAndReach), which is conservative in the same
          // direction not_retrieved already was, so this is safe either way.
          oracleSolvingLanes: f.query.certificate?.signals,
        });

        byCause[cause] = (byCause[cause] ?? 0) + 1;
        byFamily[f.family] ??= { total: 0, causes: {} };
        byFamily[f.family].total += 1;
        byFamily[f.family].causes[cause] = (byFamily[f.family].causes[cause] ?? 0) + 1;

        failureRecords.push({
          qid: f.qid,
          split: args.split,
          family: f.family,
          difficulty: f.query.diagnostics?.difficulty ?? null,
          targetId: f.targetId,
          finalRank: f.rank,
          cause,
          detail,
          expectedLane: EXPECTED_LANE_BY_FAMILY[f.family] ?? null,
        });
      }

      const notRetrievedCount = byCause.not_retrieved ?? 0;
      gatePassed = notRetrievedCount === 0;

      report.taxonomy = {
        profile: args.profile,
        split: args.split,
        totalQueries: results.length,
        missed: failures.length,
        recallAt10: metrics.recallAt10,
        byCause,
        byFamily,
        gate: { notRetrievedCount, gatePassed },
      };

      const failuresPath = args.out
        ? args.out.replace(/\.json$/i, '.failures.jsonl')
        : path.join(outDir, `failures-${args.profile}-${args.split}.jsonl`);
      await mkdir(path.dirname(failuresPath), { recursive: true });
      await writeJsonl(failuresPath, failureRecords);
      console.log(`failure log written: ${failuresPath} (${failureRecords.length} records)`);

      printTable(
        'Failure taxonomy',
        ['cause', 'count'],
        Object.entries(byCause).sort((a, b) => b[1] - a[1]),
      );

      if (!gatePassed) {
        console.error(`GATE FAILED: not_retrieved bucket has ${notRetrievedCount} queries; section 5.2 requires this to be empty`);
      }
    }

    const outPath = args.out ?? path.join(outDir, `recall-${args.profile}-${args.split}.json`);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`report written: ${outPath}`);

    if (args.split === 'test') {
      const configHash = createHash('sha256').update(JSON.stringify({ profile: args.profile, weighting: config.weighting, rerank: config.rerank, lanes: config.lanes })).digest('hex');
      const logLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        tier: args.tier,
        profile: args.profile,
        configHash,
        recallAt10: metrics.recallAt10,
        recallAt10CI: metrics.recallAt10CI,
      });
      await appendFile(path.join(outDir, 'TEST-RUNS.log'), logLine + '\n');
    }

    if (args.taxonomy && !gatePassed) {
      process.exitCode = 1;
    } else if (args.split === 'test' && !(metrics.recallAt10CI.lower >= 0.91) && args.profile === 'tuned') {
      // Section 7 rung 2 gate: 0.91 is only claimed when the bootstrap lower
      // bound also clears it. This does not throw -- a miss is reported, not
      // hidden -- but it does mark the run as not having cleared the claim.
      console.log(`note: tuned recall@10 lower CI bound (${metrics.recallAt10CI.lower.toFixed(3)}) does not clear the 0.91 claim`);
    }
  } finally {
    await client.end();
  }
}

// Only run the CLI when this file IS the entry point. Without the guard,
// importing this module for a test or a REPL fires a full bench run --
// including a database connection -- as a side effect of the import.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  });
}
