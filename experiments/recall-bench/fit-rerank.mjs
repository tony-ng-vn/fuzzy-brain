// Fits config.rerank.weights on the dev split by coordinate descent
// (DESIGN.md 6.5: "Weights are fit on the dev split by coordinate descent over
// a small grid, and the fitted vector is written into config.rerank.weights and
// committed, so the reported run is reproducible from the repo alone").
//
// Two phases, because the rerank is a LINEAR scorer over features the
// retrieval statement already returned:
//
//   --dump  one pass over the dev split, writing each query's top-50
//           candidates with their eight rerank features already computed.
//   --fit   coordinate descent over that cached dump, with no database at all.
//
// The split is sound because none of the eight features depends on the rerank
// weights. `lexical` is normalized against the best candidate in the same
// query's set, and `dupPenalty` counts same-group members above a candidate in
// the FUSED order -- both fixed before any weight is applied. So one database
// pass feeds thousands of weight evaluations, which is what makes a real
// coordinate descent affordable at all.
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
import { retrieve } from './engine.mjs';
import { rerank } from './rerank.mjs';

const FEATURES = ['fused', 'lexical', 'cosine', 'entity', 'recency', 'dateFit', 'rareHit', 'titleHit', 'dupPenalty'];

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
async function dump(tierName, dumpPath) {
  const tierCfg = resolveTier(tierName);
  console.log(`fit-rerank: target=${config.db.url} tier=${tierName} schema=${tierCfg.schema} phase=dump`);
  assertBenchTarget(config.db.url);

  const outDir = outDirFor(tierName);
  const memories = await loadJsonlArray(path.join(outDir, 'memories.jsonl'));
  const vocab = buildMemoryIndex(memories);
  const queries = await loadJsonlArray(path.join(outDir, 'queries-dev.jsonl'));
  const vectorFor = await loadDevVectors(path.join(outDir, 'query-vectors.f32'), tierCfg.dims, queries.length);

  const client = benchClient();
  await client.connect();
  const records = [];
  try {
    for (let i = 0; i < queries.length; i += 1) {
      const q = queries[i];
      let captured = null;
      const ctx = {
        tier: tierCfg,
        cfg: config,
        vocab,
        queryVector: vectorFor(i),
        profile: config.profiles.tuned,
        // rerank() attaches the eight computed features onto each candidate,
        // so running it once with the committed weights is also how the dump
        // gets its features -- no second implementation to drift.
        rerank: (qf, candidates, cfg) => {
          const out = rerank(qf, candidates, cfg);
          captured = out.map((c) => ({
            id: c.id,
            f: FEATURES.map((name) => Number(c.features?.[name] ?? 0)),
          }));
          return out;
        },
      };
      await retrieve(client, { text: q.text }, ctx);
      records.push({ qid: q.qid, family: q.family, targetId: q.targets[0], cands: captured ?? [] });
      if ((i + 1) % 100 === 0) console.log(`  dumped ${i + 1}/${queries.length}`);
    }
  } finally {
    await client.end();
  }

  await writeFile(dumpPath, JSON.stringify({ tier: tierName, features: FEATURES, records }));
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
    if (targetScore === null) continue; // target never made the top-50; no weight recovers it
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
  console.log(`fit-rerank: ${records.length} dev queries, ceiling (target in top-50) = ${
    (records.filter((r) => r.cands.some((c) => c.id === r.targetId)).length / records.length).toFixed(3)}`);
  console.log(`start weights ${JSON.stringify(Object.fromEntries(features.map((n, i) => [n, start[i]])))} -> dev recall@10 ${baseline.toFixed(4)}`);

  const grid = gridSpec ?? [-2, -1.4, -1, -0.7, -0.4, -0.2, 0, 0.2, 0.4, 0.7, 1, 1.4, 2, 2.6, 3.2, 4];
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

async function main() {
  const { values: args } = parseArgs({
    options: {
      tier: { type: 'string', default: 'quality50k' },
      dump: { type: 'boolean', default: false },
      fit: { type: 'boolean', default: false },
      file: { type: 'string' },
    },
  });
  const dumpPath = args.file ?? path.join(outDirFor(args.tier), 'rerank-dump-dev.json');
  if (args.dump) await dump(args.tier, dumpPath);
  if (args.fit) await fit(dumpPath, null);
  if (!args.dump && !args.fit) throw new Error('fit-rerank.mjs: pass --dump and/or --fit');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
