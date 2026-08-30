// Fits config.rerank.weights and config.weighting on the dev split, with no
// database round trip per trial (DESIGN.md 6.5: "Weights are fit on the dev
// split by coordinate descent over a small grid, and the fitted vector is
// written into config.rerank.weights and committed, so the reported run is
// reproducible from the repo alone").
//
// Three phases, because a single database pass over the dev split is enough
// to feed all of them:
//
//   --dump         one pass over the dev split, writing (a) each query's
//                   top-K rerank candidates with their nine features already
//                   computed, exactly as before, and (b) a WIDER per-query
//                   candidate pool (raw per-lane ranks and raw rerank inputs,
//                   before any lane-weight or rerank-weight is applied) that
//                   the lane-weight search below needs.
//   --fit          the original rerank-weight coordinate descent, unchanged.
//   --fit-logistic fits config.rerank.weights by logistic regression instead
//                   of coordinate descent: each dev candidate is a training
//                   example (is-the-target vs is-not), and the nine features
//                   are the predictors.
//   --fit-lanes    coordinate descent / grid search over the lane-weight
//                   multipliers in config.weighting (base + the five additive
//                   boosts), recombining the wide candidate pool's per-lane
//                   RRF contributions for each trial instead of re-querying.
//
// The rerank-weight split (--fit, --fit-logistic) is sound because none of
// the nine features depends on the rerank weights: `lexical` and `fused` are
// normalized against the best candidate in the same query's top-K, and
// `dupPenalty` counts same-group members above a candidate in that fixed
// order -- both computed once, before any weight is applied.
//
// The lane-weight split (--fit-lanes) is a coarser approximation and says so:
// a trial's RRF is recombined from each candidate's per-lane RANK (fixed,
// independent of any weight), but the candidate POOL itself was gathered
// under today's committed lane weights, out to 4x the per-lane depth -- the
// full "fused" CTE, not a truncation of it, so the recombination is exact
// for any trial whose weights the dump's candidates already reflect. A trial
// whose weights would have surfaced a candidate never fetched at all cannot
// recover it; that is the same "target never made the candidate set" ceiling
// --fit already reports, not a new one.
//
// Two dial groups are held fixed rather than searched, both measured before
// writing the search rather than assumed:
//   - rareTermBoost never fires on this corpus (config.mjs's own comment:
//     measured maxIdf tops out at 4.73, nowhere near rareIdfFloor 9.5), so it
//     has no dev queries to search over at all.
//   - weighting.base.trigram is pinned at its committed 0. retrieve() drops
//     the trigram lane from the SQL entirely when a query's trigram weight
//     is 0 (trigramWhenWeighted), so a normal dump carries real trigram
//     ranks only for the ~15% of dev queries typoBoost already turns the
//     lane on for. Forcing the lane on for every query to widen that
//     coverage was measured and priced: 20 dev queries at ~153 ms/query with
//     the lane gated as today, ~3,523 ms/query with it forced on for all of
//     them -- the unindexed word_similarity scan is the whole difference,
//     and it is not affordable over 1,000 queries here. typoBoost.trigram
//     stays searchable (its queries already carry real ranks); base.trigram
//     does not.
//
// This never touches the test split. It reads queries-dev.jsonl only.

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, resolveTier } from './config.mjs';
import { assertBenchTarget, benchClient } from './lib/safety.mjs';
import { readJsonl } from './lib/jsonl.mjs';
import { buildMemoryIndex } from './gen-corpus.mjs';
import { retrieve, laneWeights } from './engine.mjs';
import { rerank } from './rerank.mjs';
import { makeRng } from './lib/rng.mjs';
import { bootstrapCI } from './lib/stats.mjs';

const FEATURES = ['fused', 'lexical', 'cosine', 'entity', 'recency', 'dateFit', 'rareHit', 'titleHit', 'dupPenalty'];
const LANES = ['and', 'or', 'vector', 'trigram'];
const DEFAULT_GRID = [-2, -1.4, -1, -0.7, -0.4, -0.2, 0, 0.2, 0.4, 0.7, 1, 1.4, 2, 2.6, 3.2, 4];

// The lane-weight dials this file searches: [dial-group, key] pairs into
// config.weighting. rareTermBoost and base.trigram are deliberately absent --
// see the file header for why (one never fires on this corpus, the other has
// no affordable way to gather real data for most dev queries).
const DIAL_SPEC = [
  ['base', 'and'], ['base', 'or'], ['base', 'vector'],
  ['paraphraseBoost', 'vector'], ['paraphraseBoost', 'or'], ['paraphraseBoost', 'and'],
  ['typoBoost', 'trigram'], ['typoBoost', 'and'],
  ['entityBoost', 'and'],
  ['dateBoost', 'vector'],
];

const here = path.dirname(fileURLToPath(import.meta.url));
const outDirFor = (tier) => path.join(here, '.out', tier);

async function loadJsonlArray(filePath) {
  const out = [];
  for await (const record of readJsonl(filePath)) out.push(record);
  return out;
}

// Same little-endian Float32 layout bench-recall.mjs reads: dev queries first
// in file order, then test queries, each occupying tier.dims floats.
async function loadDevVectors(cachePath, dims, devCount) {
  const buf = await readFile(cachePath);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return (i) => {
    if (i < 0 || i >= devCount) throw new Error(`dev vector index ${i} out of range`);
    return Array.from(all.subarray(i * dims, (i + 1) * dims));
  };
}

// ---------------------------------------------------------------------------
// Phase 1: dump
// ---------------------------------------------------------------------------

// How many candidates the SQL statement returns, per query. 4x the per-lane
// depth is the full "fused" CTE (DESIGN.md 6.1: "fused holds up to 4 x depth
// deduped ids"), so this is the whole candidate pool, not a truncation of it
// -- measured to cost the same as the production topK=25 cut (~150 ms/query
// either way; the extra rows are a cheap join + cosine projection, not extra
// lane work, since each lane's own `limit depth` is unchanged).
function dumpDepth(cfg) {
  return 4 * cfg.lanes.quality.depth;
}

async function dump(tierName, dumpPath) {
  const tierCfg = resolveTier(tierName);
  console.log(`fit-rerank: target=${config.db.url} tier=${tierName} schema=${tierCfg.schema} phase=dump`);
  assertBenchTarget(config.db.url);

  const outDir = outDirFor(tierName);
  const memories = await loadJsonlArray(path.join(outDir, 'memories.jsonl'));
  const vocab = buildMemoryIndex(memories);
  const queries = await loadJsonlArray(path.join(outDir, 'queries-dev.jsonl'));
  const vectorFor = await loadDevVectors(path.join(outDir, 'query-vectors.f32'), tierCfg.dims, queries.length);

  const productionTopK = config.rerank.topK;
  // Only the SQL row cap changes; weighting and rerank stay at their
  // committed values, so the trigram lane is gated exactly as production
  // gates it (see the file header for why that gate is left alone).
  const wideCfg = { ...config, rerank: { ...config.rerank, topK: dumpDepth(config) } };

  const client = benchClient();
  await client.connect();
  const records = [];
  try {
    for (let i = 0; i < queries.length; i += 1) {
      const q = queries[i];
      let capturedQf = null;
      let capturedTop = null;
      let capturedWide = null;
      const ctx = {
        tier: tierCfg,
        cfg: wideCfg,
        vocab,
        queryVector: vectorFor(i),
        profile: config.profiles.tuned,
        rerank: (qf, candidates, _cfg) => {
          capturedQf = qf;
          // Raw pool, snapshotted BEFORE rerank() runs on anything: rerank()
          // mutates candidate.features in place (merges the 9 computed keys
          // over the raw ones, clobbering `lexical`'s raw ts_rank_cd with the
          // normalized value), so the wide pool has to be copied out first.
          capturedWide = candidates.map((c) => ({ id: c.id, laneRanks: { ...c.laneRanks }, features: { ...c.features } }));

          // The production-shaped top-K, scored with the COMMITTED config
          // (not wideCfg, which only exists to widen the SQL's row cap) --
          // candidates[0..K-1] are exactly what a topK=25 statement would
          // have returned, since both share the same `order by rrf desc, id`
          // and only the LIMIT differs. rerank() attaches the nine computed
          // features here, so running it once with the committed weights is
          // also how `cands` gets its features -- no second implementation.
          const top = candidates.slice(0, productionTopK).map((c) => ({
            id: c.id, rrf: c.rrf, rerankScore: null, features: { ...c.features },
          }));
          const scored = rerank(qf, top, config);
          capturedTop = scored.map((c) => ({ id: c.id, f: FEATURES.map((name) => Number(c.features?.[name] ?? 0)) }));

          return candidates; // retrieve()'s own post-call re-sort is unused; only `captured*` matters
        },
      };
      await retrieve(client, { text: q.text }, ctx);
      records.push({
        qid: q.qid,
        family: q.family,
        targetId: q.targets[0],
        qf: capturedQf,
        cands: capturedTop ?? [],
        wideCands: capturedWide ?? [],
      });
      if ((i + 1) % 100 === 0) console.log(`  dumped ${i + 1}/${queries.length}`);
    }
  } finally {
    await client.end();
  }

  await writeFile(dumpPath, JSON.stringify({
    tier: tierName,
    features: FEATURES,
    lanes: LANES,
    rrfK: config.lanes.rrfK,
    topK: productionTopK,
    records,
  }));
  console.log(`dump written: ${dumpPath} (${records.length} queries)`);
}

// ---------------------------------------------------------------------------
// Phase 2: fit
// ---------------------------------------------------------------------------

// Mirrors what retrieve() does after ctx.rerank: rerank() sorts by score
// descending with an id tiebreak, and retrieve() then re-sorts by score with a
// stable sort, so the effective order is score desc, id asc.
function recallAt10(records, weightVector) {
  let hits = 0;
  for (const rec of records) {
    let betterThanTarget = 0;
    let targetScore = null;
    const scores = new Array(rec.cands.length);
    for (let i = 0; i < rec.cands.length; i += 1) {
      let s = 0;
      const f = rec.cands[i].f;
      for (let k = 0; k < weightVector.length; k += 1) s += weightVector[k] * f[k];
      scores[i] = s;
      if (rec.cands[i].id === rec.targetId) targetScore = s;
    }
    if (targetScore === null) continue; // target never made the top-K candidate set; no weight recovers it
    for (let i = 0; i < rec.cands.length; i += 1) {
      const c = rec.cands[i];
      if (c.id === rec.targetId) continue;
      if (scores[i] > targetScore || (scores[i] === targetScore && c.id < rec.targetId)) betterThanTarget += 1;
    }
    if (betterThanTarget < 10) hits += 1;
  }
  return hits / records.length;
}

function perFamily(records, weightVector) {
  const byFamily = new Map();
  for (const rec of records) {
    if (!byFamily.has(rec.family)) byFamily.set(rec.family, []);
    byFamily.get(rec.family).push(rec);
  }
  const out = {};
  for (const [family, recs] of [...byFamily].sort()) out[family] = recallAt10(recs, weightVector);
  return out;
}

async function fit(dumpPath, gridSpec) {
  const dumped = JSON.parse(await readFile(dumpPath, 'utf8'));
  const { features, records } = dumped;
  const start = features.map((name) => config.rerank.weights[name] ?? 0);

  const baseline = recallAt10(records, start);
  console.log(`fit-rerank: ${records.length} dev queries, ceiling (target in top-${config.rerank.topK}) = ${
    (records.filter((r) => r.cands.some((c) => c.id === r.targetId)).length / records.length).toFixed(3)}`);
  console.log(`start weights ${JSON.stringify(Object.fromEntries(features.map((n, i) => [n, start[i]])))} -> dev recall@10 ${baseline.toFixed(4)}`);

  const grid = gridSpec ?? DEFAULT_GRID;
  let current = [...start];
  let currentScore = baseline;

  for (let round = 1; round <= 6; round += 1) {
    let improvedThisRound = false;
    for (let k = 0; k < features.length; k += 1) {
      let bestValue = current[k];
      let bestScore = currentScore;
      for (const candidate of grid) {
        if (candidate === current[k]) continue;
        const trial = [...current];
        trial[k] = candidate;
        const score = recallAt10(records, trial);
        // Strict improvement only: a tie keeps the incumbent, so the fit does
        // not wander across equal-scoring plateaus and overfit their edges.
        if (score > bestScore) {
          bestScore = score;
          bestValue = candidate;
        }
      }
      if (bestValue !== current[k]) {
        console.log(`  round ${round}: ${features[k]} ${current[k]} -> ${bestValue} (dev recall@10 ${currentScore.toFixed(4)} -> ${bestScore.toFixed(4)})`);
        current[k] = bestValue;
        currentScore = bestScore;
        improvedThisRound = true;
      }
    }
    if (!improvedThisRound) {
      console.log(`  round ${round}: no coordinate improved; converged`);
      break;
    }
  }

  console.log(`\nfitted weights: ${JSON.stringify(Object.fromEntries(features.map((n, i) => [n, current[i]])), null, 2)}`);
  console.log(`dev recall@10: ${baseline.toFixed(4)} -> ${currentScore.toFixed(4)} (+${(currentScore - baseline).toFixed(4)})`);
  console.log('\nper-family (fitted):');
  const before = perFamily(records, start);
  const after = perFamily(records, current);
  for (const family of Object.keys(after)) {
    console.log(`  ${family.padEnd(18)} ${before[family].toFixed(3)} -> ${after[family].toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 2b: fit-logistic -- rerank.weights by logistic regression instead of
// coordinate descent, over the same cached top-K features --dump wrote.
// ---------------------------------------------------------------------------

function sigmoid(z) {
  // The textbook two-branch form: exp(-z) overflows for very negative z if
  // computed the other way, and 25 features' worth of dot products can land
  // there during early gradient-descent iterations.
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

// One training example per dev candidate in the production top-K set: label
// 1 for the ground-truth target, 0 for everything else. Skips queries whose
// target never made the candidate set, same population --fit's coordinate
// descent scores against (recallAt10 above) -- no weight can recover those.
function buildLogisticDataset(records) {
  const X = [];
  const y = [];
  for (const rec of records) {
    if (!rec.cands.some((c) => c.id === rec.targetId)) continue;
    for (const c of rec.cands) {
      X.push(c.f);
      y.push(c.id === rec.targetId ? 1 : 0);
    }
  }
  return { X, y };
}

// z-scores each column for gradient-descent stability; returns the per-column
// std so trained coefficients can be mapped back to raw feature units.
function standardize(X) {
  const n = X.length;
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  const variance = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j += 1) mean[j] += row[j];
  for (let j = 0; j < d; j += 1) mean[j] /= n;
  for (const row of X) for (let j = 0; j < d; j += 1) { const dv = row[j] - mean[j]; variance[j] += dv * dv; }
  const std = variance.map((v) => {
    const s = Math.sqrt(v / n);
    return s < 1e-9 ? 1 : s; // a constant column contributes nothing; do not divide by ~0
  });
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { Z, std };
}

// Batch gradient descent on L2-regularized logistic loss. Returns
// coefficients in the ORIGINAL (unstandardized) feature space -- the fitted
// intercept is dropped rather than folded back in, because it becomes a
// single constant shared by every candidate of every query once unstandardized
// (mean/std are corpus-wide, not per-query), and rerankScore only ever
// compares candidates WITHIN one query's set. A constant that cannot change
// which candidate outranks another cannot change Recall@10, so dropping it
// matches what rerank.mjs's intercept-free scorer actually needs.
function trainLogistic(X, y, { l2 = 1e-3, lr = 0.3, iters = 2000 } = {}) {
  const { Z, std } = standardize(X);
  const n = Z.length;
  const d = Z[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it += 1) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i += 1) {
      let z = b;
      for (let j = 0; j < d; j += 1) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j += 1) gradW[j] += err * Z[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j += 1) w[j] -= lr * (gradW[j] / n + l2 * w[j]);
    b -= lr * (gradB / n);
  }
  return w.map((wj, j) => wj / std[j]);
}

// Percentile bootstrap over a WEIGHT VECTOR fit, not a scalar mean, so
// lib/stats.mjs's bootstrapCI (which averages scalars) does not apply here:
// each resample refits the whole vector, and the CI is taken per coordinate
// across resamples.
function bootstrapWeightVectors(records, refit, { resamples = 200, level = 0.95, seed } = {}) {
  const rng = makeRng(seed);
  const n = records.length;
  const samples = [];
  for (let r = 0; r < resamples; r += 1) {
    const resampled = new Array(n);
    for (let i = 0; i < n; i += 1) resampled[i] = records[rng.int(0, n - 1)];
    samples.push(refit(resampled));
  }
  const dims = samples[0].length;
  const alpha = 1 - level;
  const cis = [];
  for (let j = 0; j < dims; j += 1) {
    const col = samples.map((s) => s[j]).sort((a, b) => a - b);
    cis.push({
      lower: col[Math.floor((alpha / 2) * resamples)],
      upper: col[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)],
    });
  }
  return cis;
}

async function fitLogistic(dumpPath, { resamples = 0 } = {}) {
  const dumped = JSON.parse(await readFile(dumpPath, 'utf8'));
  const { features, records } = dumped;
  const usable = records.filter((r) => r.cands.some((c) => c.id === r.targetId));
  console.log(`fit-logistic: ${records.length} dev queries (${usable.length} with target in top-${config.rerank.topK})`);

  const { X, y } = buildLogisticDataset(usable);
  const learned = trainLogistic(X, y);

  const committed = features.map((name) => config.rerank.weights[name] ?? 0);
  const committedScore = recallAt10(records, committed);
  const learnedScore = recallAt10(records, learned);

  console.log(`committed rerank weights            -> dev recall@10 ${committedScore.toFixed(4)}`);
  console.log(`logistic-fit rerank weights: ${JSON.stringify(Object.fromEntries(features.map((n, i) => [n, Number(learned[i].toFixed(4))])))}`);
  console.log(`logistic-fit rerank weights          -> dev recall@10 ${learnedScore.toFixed(4)} (${learnedScore >= committedScore ? '+' : ''}${(learnedScore - committedScore).toFixed(4)})`);

  console.log('\nper-family (logistic vs committed):');
  const before = perFamily(records, committed);
  const after = perFamily(records, learned);
  for (const family of Object.keys(after)) {
    console.log(`  ${family.padEnd(18)} ${before[family].toFixed(3)} -> ${after[family].toFixed(3)}`);
  }

  let cis = null;
  if (resamples > 0) {
    console.log(`\nbootstrapping ${resamples} dev resamples for logistic weight CIs...`);
    const boot = bootstrapWeightVectors(
      usable,
      (sample) => {
        const built = buildLogisticDataset(sample);
        return trainLogistic(built.X, built.y, { iters: 400 }); // lighter for CI speed; the point estimate above uses the full run
      },
      { resamples, seed: 'recall-bench/fit-rerank/logistic-bootstrap' },
    );
    cis = features.map((name, i) => ({ name, point: learned[i], lower: boot[i].lower, upper: boot[i].upper }));
    for (const c of cis) console.log(`  ${c.name.padEnd(10)} ${c.point.toFixed(3)}  [${c.lower.toFixed(3)}, ${c.upper.toFixed(3)}]`);
  }

  return { features, committed, committedScore, learned, learnedScore, cis };
}

// ---------------------------------------------------------------------------
// Phase 2c: fit-lanes -- coordinate descent over the lane-weight multipliers
// in config.weighting, recombining RRF from wideCands' raw per-lane ranks.
// ---------------------------------------------------------------------------

function committedDialGroups() {
  return {
    base: { and: config.weighting.base.and, or: config.weighting.base.or, vector: config.weighting.base.vector },
    paraphraseBoost: { ...config.weighting.paraphraseBoost },
    typoBoost: { ...config.weighting.typoBoost },
    entityBoost: { ...config.weighting.entityBoost },
    dateBoost: { ...config.weighting.dateBoost },
  };
}

function dialsFromVector(vector) {
  const dials = committedDialGroups();
  DIAL_SPEC.forEach(([group, key], i) => { dials[group][key] = vector[i]; });
  return dials;
}

// Recombines one query's wide candidate pool under an already-computed
// per-lane weight map, cuts to the production topK, and hands the result to
// the REAL rerank() -- the one function neither this file nor engine.mjs
// re-derives, so a change to its normalization or dupPenalty logic cannot
// silently drift from what this search scores.
function recombineAndRerank(rec, laneW, rrfK, topK, rerankCfg) {
  const scored = rec.wideCands.map((c) => {
    let rrf = 0;
    for (const lane of LANES) {
      const rnk = c.laneRanks[lane];
      if (rnk == null) continue;
      rrf += (laneW[lane] ?? 0) / (rrfK[lane] + rnk);
    }
    return { id: c.id, rrf, features: c.features };
  });
  scored.sort((a, b) => b.rrf - a.rrf || a.id - b.id);
  const top = scored.slice(0, topK).map((c) => ({ id: c.id, rrf: c.rrf, rerankScore: null, features: { ...c.features } }));
  return rerank(rec.qf, top, rerankCfg);
}

// Single-record convenience wrapper (builds the trial configs fresh each
// call), used outside the search's hot loop -- the paired-delta check and the
// final combined evaluation below, where clarity matters more than avoiding
// one extra object per query.
function pipelineTopK(rec, weightingDials, rerankWeights, rrfK, topK) {
  const trialCfg = { ...config, weighting: { ...config.weighting, ...weightingDials } };
  const rerankCfg = { ...config, rerank: { ...config.rerank, weights: rerankWeights } };
  const laneW = laneWeights(rec.qf, config.profiles.tuned, trialCfg);
  return recombineAndRerank(rec, laneW, rrfK, topK, rerankCfg);
}

// Hot-loop version: builds each trial's config objects ONCE, not once per
// query, since neither depends on which query is being scored.
// Denominator is ALWAYS records.length, matching bench-recall.mjs's
// computeMetrics: a query with an empty candidate pool is a MISS, not an
// exclusion. Excluding it would shrink the denominator and inflate the
// score -- the same bug --dump's own "ceiling" line deliberately avoids by
// dividing recallAt10 by records.length rather than by however many queries
// had a candidate at all.
function pipelineRecallAt10(records, weightingDials, rerankWeights, rrfK, topK) {
  const trialCfg = { ...config, weighting: { ...config.weighting, ...weightingDials } };
  const rerankCfg = { ...config, rerank: { ...config.rerank, weights: rerankWeights } };
  let hits = 0;
  for (const rec of records) {
    if (rec.wideCands.length === 0) continue; // no candidates at all: correctly scored as a miss below
    const laneW = laneWeights(rec.qf, config.profiles.tuned, trialCfg);
    const ranked = recombineAndRerank(rec, laneW, rrfK, topK, rerankCfg);
    if (ranked.slice(0, 10).some((c) => c.id === rec.targetId)) hits += 1;
  }
  return records.length === 0 ? 0 : hits / records.length;
}

function pipelinePerFamily(records, weightingDials, rerankWeights, rrfK, topK) {
  const byFamily = new Map();
  for (const rec of records) {
    if (!byFamily.has(rec.family)) byFamily.set(rec.family, []);
    byFamily.get(rec.family).push(rec);
  }
  const out = {};
  for (const [family, recs] of [...byFamily].sort()) out[family] = pipelineRecallAt10(recs, weightingDials, rerankWeights, rrfK, topK);
  return out;
}

// Pure coordinate descent over DIAL_SPEC. Shared by the point-estimate fit
// and each bootstrap resample (with a lighter grid/round count for speed);
// `verbose` controls per-move logging so the bootstrap loop stays quiet.
function fitLaneWeightsCore(records, rrfK, topK, rerankWeights, { grid, rounds = 6, verbose = false } = {}) {
  const dialGroups = committedDialGroups();
  const start = DIAL_SPEC.map(([group, key]) => dialGroups[group][key]);
  const evaluate = (vector) => pipelineRecallAt10(records, dialsFromVector(vector), rerankWeights, rrfK, topK);

  const gridValues = grid ?? DEFAULT_GRID;
  let current = [...start];
  let currentScore = evaluate(current);
  const baseline = currentScore;

  for (let round = 1; round <= rounds; round += 1) {
    let improvedThisRound = false;
    for (let k = 0; k < DIAL_SPEC.length; k += 1) {
      let bestValue = current[k];
      let bestScore = currentScore;
      for (const candidate of gridValues) {
        if (candidate === current[k]) continue;
        const trial = [...current];
        trial[k] = candidate;
        const score = evaluate(trial);
        if (score > bestScore) {
          bestScore = score;
          bestValue = candidate;
        }
      }
      if (bestValue !== current[k]) {
        if (verbose) {
          const [group, key] = DIAL_SPEC[k];
          console.log(`  round ${round}: ${group}.${key} ${current[k]} -> ${bestValue} (dev recall@10 ${currentScore.toFixed(4)} -> ${bestScore.toFixed(4)})`);
        }
        current[k] = bestValue;
        currentScore = bestScore;
        improvedThisRound = true;
      }
    }
    if (!improvedThisRound) {
      if (verbose) console.log(`  round ${round}: no coordinate improved; converged`);
      break;
    }
  }
  return { start, baseline, current, score: currentScore };
}

// Local-refinement search used ONLY for the bootstrap: starts from an
// already-fitted point (not the committed defaults) and searches small
// deltas around each coordinate. This is what makes the bootstrap CI
// meaningful rather than an artifact of grid truncation -- a coarse ABSOLUTE
// grid that does not happen to include the point estimate (e.g. a grid
// topping out at 2 when the fitted value is 2.6) produces a CI that cannot
// even contain the point it is supposed to bracket around. Centering on the
// fitted point and searching +/- small steps avoids that by construction,
// and is cheaper besides (4 deltas x 10 dials x 1 round, against 7 x 10 x 2).
function refineLaneWeights(records, rrfK, topK, rerankWeights, start, deltas, rounds) {
  const evaluate = (vector) => pipelineRecallAt10(records, dialsFromVector(vector), rerankWeights, rrfK, topK);
  let current = [...start];
  let currentScore = evaluate(current);
  for (let round = 1; round <= rounds; round += 1) {
    let improvedThisRound = false;
    for (let k = 0; k < DIAL_SPEC.length; k += 1) {
      let bestValue = current[k];
      let bestScore = currentScore;
      for (const d of deltas) {
        if (d === 0) continue;
        const trial = [...current];
        trial[k] = current[k] + d;
        const score = evaluate(trial);
        if (score > bestScore) {
          bestScore = score;
          bestValue = trial[k];
        }
      }
      if (bestValue !== current[k]) {
        current[k] = bestValue;
        currentScore = bestScore;
        improvedThisRound = true;
      }
    }
    if (!improvedThisRound) break;
  }
  return current;
}

async function fitLanes(dumpPath, rerankWeights, { resamples = 0 } = {}) {
  const dumped = JSON.parse(await readFile(dumpPath, 'utf8'));
  const { records, rrfK, topK } = dumped;
  if (!records[0] || !('wideCands' in records[0])) {
    throw new Error('fit-rerank.mjs --fit-lanes: dump has no wideCands; re-run --dump with the current script version');
  }
  const nonEmpty = records.filter((r) => r.wideCands.length > 0).length;
  console.log(`fit-lanes: ${records.length} dev queries (${nonEmpty} with a non-empty candidate pool), searching ${DIAL_SPEC.length} dials`);

  // pipelineRecallAt10 divides by the full population, not just nonEmpty --
  // this MUST run over `records`, never a pre-filtered subset (a dropped
  // query would shrink the denominator and inflate every score).
  const { baseline, current, score } = fitLaneWeightsCore(records, rrfK, topK, rerankWeights, { verbose: true });
  const fittedDials = dialsFromVector(current);

  console.log(`\nfitted lane dials: ${JSON.stringify(fittedDials, null, 2)}`);
  console.log(`dev recall@10: ${baseline.toFixed(4)} -> ${score.toFixed(4)} (${score >= baseline ? '+' : ''}${(score - baseline).toFixed(4)})`);

  console.log('\nper-family (fitted lane dials):');
  const before = pipelinePerFamily(records, {}, rerankWeights, rrfK, topK);
  const after = pipelinePerFamily(records, fittedDials, rerankWeights, rrfK, topK);
  for (const family of Object.keys(after)) {
    console.log(`  ${family.padEnd(18)} ${before[family].toFixed(3)} -> ${after[family].toFixed(3)}`);
  }

  let cis = null;
  if (resamples > 0) {
    console.log(`\nbootstrapping ${resamples} dev resamples for lane-weight CIs (local refinement around the fitted point, for speed)...`);
    const deltas = [-0.6, -0.3, 0, 0.3, 0.6];
    const boot = bootstrapWeightVectors(
      records,
      (sample) => refineLaneWeights(sample, rrfK, topK, rerankWeights, current, deltas, 2),
      { resamples, seed: 'recall-bench/fit-rerank/lanes-bootstrap' },
    );
    cis = DIAL_SPEC.map(([group, key], i) => ({ name: `${group}.${key}`, point: current[i], lower: boot[i].lower, upper: boot[i].upper }));
    for (const c of cis) console.log(`  ${c.name.padEnd(20)} ${c.point.toFixed(3)}  [${c.lower.toFixed(3)}, ${c.upper.toFixed(3)}]`);
  }

  return { dialSpec: DIAL_SPEC, baseline, current, score, fittedDials, cis };
}

// Paired bootstrap over dev queries: within each resample, the same drawn
// queries feed both arms, so noise shared by both (an easy or hard query
// drawn twice) cancels instead of inflating the interval. This is the number
// that decides whether the test invocation gets spent, not a raw score
// comparison against a different split's number.
function pairedDeltaCI(records, learnedDials, learnedRerankWeights, committedDials, committedRerankWeights, rrfK, topK, opts = {}) {
  const perQueryLearned = records.map((rec) => (
    pipelineTopK(rec, learnedDials, learnedRerankWeights, rrfK, topK).slice(0, 10).some((c) => c.id === rec.targetId) ? 1 : 0
  ));
  const perQueryCommitted = records.map((rec) => (
    pipelineTopK(rec, committedDials, committedRerankWeights, rrfK, topK).slice(0, 10).some((c) => c.id === rec.targetId) ? 1 : 0
  ));
  const deltas = perQueryLearned.map((h, i) => h - perQueryCommitted[i]);
  return bootstrapCI(deltas, { resamples: opts.resamples ?? 10_000, level: opts.level ?? 0.95, seed: opts.seed ?? 'recall-bench/fit-rerank/paired-delta' });
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      tier: { type: 'string', default: 'quality50k' },
      dump: { type: 'boolean', default: false },
      fit: { type: 'boolean', default: false },
      'fit-logistic': { type: 'boolean', default: false },
      'fit-lanes': { type: 'boolean', default: false },
      bootstrap: { type: 'boolean', default: false },
      resamples: { type: 'string', default: '200' },
      file: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const dumpPath = args.file ?? path.join(outDirFor(args.tier), 'rerank-dump-dev.json');
  const resamples = Number.parseInt(args.resamples, 10);

  if (args.dump) await dump(args.tier, dumpPath);
  if (args.fit) await fit(dumpPath, null);

  let logisticResult = null;
  if (args['fit-logistic']) {
    logisticResult = await fitLogistic(dumpPath, { resamples: args.bootstrap ? resamples : 0 });
  }

  if (args['fit-lanes']) {
    const dumped = JSON.parse(await readFile(dumpPath, 'utf8'));
    const committedRerankVector = dumped.features.map((n) => config.rerank.weights[n] ?? 0);
    const committedRerankObj = Object.fromEntries(dumped.features.map((n, i) => [n, committedRerankVector[i]]));
    // Hold rerank weights at whichever arm scored better on dev so far: the
    // logistic fit if it actually won, the committed values otherwise. A
    // lane search built on top of a worse rerank scorer would be answering
    // the wrong question.
    const useLogistic = Boolean(logisticResult) && logisticResult.learnedScore > logisticResult.committedScore;
    const rerankVectorForLanes = useLogistic ? logisticResult.learned : committedRerankVector;
    const rerankObjForLanes = Object.fromEntries(dumped.features.map((n, i) => [n, rerankVectorForLanes[i]]));
    console.log(`\nfit-lanes: holding rerank weights at ${useLogistic ? 'the logistic fit' : 'the committed values'}`);

    const lanesResult = await fitLanes(dumpPath, rerankObjForLanes, { resamples: args.bootstrap ? resamples : 0 });

    // The FULL population, never a pre-filtered subset -- see
    // pipelineRecallAt10's own comment on why an empty candidate pool has to
    // stay in the denominator as a miss, not drop out of it.
    const learnedDevRecall = pipelineRecallAt10(dumped.records, lanesResult.fittedDials, rerankObjForLanes, dumped.rrfK, dumped.topK);
    // The recombination check: this MUST reproduce a live `bench-recall.mjs
    // --profile tuned --split dev` run (both dials empty, i.e. fully
    // committed) to within noise, or the offline objective is scoring
    // something other than what actually gets evaluated.
    const handTunedDevRecall = pipelineRecallAt10(dumped.records, {}, committedRerankObj, dumped.rrfK, dumped.topK);
    console.log(`\ncombined (learned lanes + ${useLogistic ? 'logistic' : 'committed'} rerank) dev recall@10 = ${learnedDevRecall.toFixed(4)}`);
    console.log(`hand-tuned (committed lanes + committed rerank) dev recall@10 = ${handTunedDevRecall.toFixed(4)}`);

    const deltaCI = pairedDeltaCI(dumped.records, lanesResult.fittedDials, rerankObjForLanes, {}, committedRerankObj, dumped.rrfK, dumped.topK);
    console.log(`paired bootstrap delta (learned - hand-tuned) on dev: ${deltaCI.point.toFixed(4)} [${deltaCI.lower.toFixed(4)}, ${deltaCI.upper.toFixed(4)}]`);
    const wins = deltaCI.lower > 0;
    console.log(wins
      ? 'DECISION: learned beats hand-tuned on dev (95% CI excludes 0) -- spend the test invocation.'
      : 'DECISION: learned does not clearly beat hand-tuned on dev (95% CI does not exclude 0) -- do not spend the test invocation.');

    const outPath = args.out ?? path.join(outDirFor(args.tier), 'learned-weights.json');
    await writeFile(outPath, JSON.stringify({
      tier: args.tier,
      generatedAt: new Date().toISOString(),
      devQueries: dumped.records.length,
      rerank: {
        method: 'logistic-regression',
        usedForLaneSearch: useLogistic,
        committed: committedRerankObj,
        learned: logisticResult ? Object.fromEntries(dumped.features.map((n, i) => [n, logisticResult.learned[i]])) : null,
        committedDevRecallAt10: logisticResult ? logisticResult.committedScore : null,
        learnedDevRecallAt10: logisticResult ? logisticResult.learnedScore : null,
        weightCIs: logisticResult?.cis ?? null,
      },
      lanes: {
        method: 'coordinate-descent',
        dialsSearched: lanesResult.dialSpec.map(([g, k]) => `${g}.${k}`),
        dialsExcluded: ['rareTermBoost.and', 'rareTermBoost.trigram', 'base.trigram'],
        committedDevRecallAt10: lanesResult.baseline,
        learnedDevRecallAt10: lanesResult.score,
        fitted: lanesResult.fittedDials,
        weightCIs: lanesResult.cis,
      },
      combined: {
        learnedDevRecallAt10: learnedDevRecall,
        handTunedDevRecallAt10: handTunedDevRecall,
        pairedDeltaCI: deltaCI,
        beatsHandTunedOnDev: wins,
      },
    }, null, 2));
    console.log(`\nlearned weights + comparison written: ${outPath}`);
  }

  if (!args.dump && !args.fit && !args['fit-logistic'] && !args['fit-lanes']) {
    throw new Error('fit-rerank.mjs: pass --dump, --fit, --fit-logistic, and/or --fit-lanes');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
