// Sequential single-query probe: per-family median/mean sqlMs plus the per-query
// spread and lane row counts, on one connection. FAMILIES=a,b PER=12 node famprobe.mjs
//
// Reports medians (a suspend or a contending job inflates one sample rather than
// the result) and prints the per-query sorted sqlMs so an outlier is visible
// rather than averaged away.
import { readFileSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Bench root, resolved from this file rather than the caller's cwd.
const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const { config, resolveTier } = await import(`${BENCH}/config.mjs`);
const engine = await import(`${BENCH}/engine.mjs`);
const { loadTermStats } = await import(`${BENCH}/lib/term-stats.mjs`);
const { benchClient } = await import(`${BENCH}/lib/safety.mjs`);
const { rerank } = await import(`${BENCH}/rerank.mjs`);

// TIER is overridable so the same instrument profiles rung 4 at 10M; the
// default reproduces the 1M numbers with no environment set.
const TIER_NAME = process.env.TIER ?? 'rehearsal1m';
const tier = resolveTier(TIER_NAME);
const PER = Number(process.env.PER ?? 12);
const REPS = Number(process.env.REPS ?? 3);
const OUT = process.env.OUT ?? '';
const profile = config.profiles[process.env.PROFILE ?? 'tunedScale'];

const rows = readFileSync(`${BENCH}/.out/${TIER_NAME}/queries-test.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const only = process.env.FAMILIES ? new Set(process.env.FAMILIES.split(',')) : null;
const byFamily = new Map();
for (const r of rows) {
  if (only && !only.has(r.family)) continue;
  const arr = byFamily.get(r.family) ?? [];
  if (arr.length < PER) arr.push(r);
  byFamily.set(r.family, arr);
}

const client = benchClient();
await client.connect();
const vocab = await loadTermStats(client, tier);
const ctx = { tier, profile, vocab, cfg: config, rerank: profile.rerank ? rerank : undefined };

const vecCache = new Map();
async function vectorFor(id) {
  if (!vecCache.has(id)) {
    const { rows: r } = await client.query(`select embedding from ${tier.schema}.memories where id = $1`, [id]);
    vecCache.set(id, Float32Array.from(r[0].embedding.slice(1, -1).split(',').map(Number)));
  }
  return vecCache.get(id);
}

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const mix = config.corpus.familyMix;
const out = {};

for (const [family, qs] of byFamily) {
  const per = [];
  for (const q of qs) {
    const queryVector = await vectorFor(q.targets[0]);
    await engine.retrieve(client, { text: q.text }, { ...ctx, queryVector });
    const samples = [];
    let lanes = {};
    let rerankMs = 0;
    for (let i = 0; i < REPS; i += 1) {
      const res = await engine.retrieve(client, { text: q.text }, { ...ctx, queryVector });
      samples.push(res.timings.sqlMs);
      lanes = res.lanes;
      rerankMs = res.timings.rerankMs;
    }
    per.push({
      text: q.text, qid: q.qid, sql: med(samples), rerankMs,
      lanes: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.length])),
    });
  }
  per.sort((a, b) => a.sql - b.sql);
  out[family] = {
    median: med(per.map((p) => p.sql)),
    mean: mean(per.map((p) => p.sql)),
    p90: per[Math.min(per.length - 1, Math.floor(per.length * 0.9))].sql,
    per,
  };
}

let wMed = 0;
let wMean = 0;
console.log(`\nfamily            mix   median    mean     p90   spread (sorted sqlMs)`);
for (const [f, r] of Object.entries(out)) {
  wMed += (mix[f] ?? 0) * r.median;
  wMean += (mix[f] ?? 0) * r.mean;
  const spread = r.per.map((p) => p.sql.toFixed(0)).join(' ');
  console.log(`${f.padEnd(17)}${String(mix[f] ?? 0).padStart(5)}${r.median.toFixed(2).padStart(9)}${r.mean.toFixed(2).padStart(8)}${r.p90.toFixed(2).padStart(8)}   ${spread}`);
}
console.log(`\nmix-weighted median-of-family : ${wMed.toFixed(2)} core-ms`);
console.log(`mix-weighted mean-of-family   : ${wMean.toFixed(2)} core-ms`);
console.log(`projected QPS (12 cores / weighted-median): ${(12000 / wMed).toFixed(0)}`);

console.log(`\nlane row counts (mean over queries, of the top-${config.rerank.topK} fused rows)`);
for (const [f, r] of Object.entries(out)) {
  const keys = new Set(r.per.flatMap((p) => Object.keys(p.lanes)));
  const parts = [...keys].map((k) => `${k} ${mean(r.per.map((p) => p.lanes[k] ?? 0)).toFixed(1)}`);
  console.log(`${f.padEnd(17)} ${parts.join(', ')}`);
}

if (OUT) writeFileSync(OUT, JSON.stringify({ out, wMed, wMean }, null, 2));
await client.end();
