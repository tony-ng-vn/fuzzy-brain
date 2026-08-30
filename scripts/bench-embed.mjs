// Measures query-embedding latency for scripts/lib/embeddings.mjs, the path
// every recall.mjs call runs before it can search anything. Rerun with:
//   node scripts/bench-embed.mjs
//
// This machine is shared, so we print os.loadavg() before and after the run:
// a p95 that moves while load moves is contention noise, not a regression.
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { embedQuery, embedQueryCached, LruCache } from "./lib/embeddings.mjs";

const WARM_CALLS = 200;
const CACHE_HIT_CALLS = 1000;

// 5-to-30-word questions, the shape recall.mjs actually receives, so token
// count and padding behavior match production rather than one fixed string.
const QUESTIONS = [
  "where does my girlfriend live?",
  "what did I decide about the database migration last week?",
  "who introduced me to the idea of keeping a fuzzy brain in the first place?",
  "when is the deadline for the recall benchmark writeup?",
  "what was the reasoning behind switching from fp32 to a quantized model, if we ever did?",
  "did I ever finish the graph engineering audit?",
  "what do I need to remember before tomorrow's standup?",
  "why did we decide against auto-linking nodes in the brain?",
  "what's the story about the arizona long distance thing?",
  "which lesson did I write down after the last incident review?",
  "what goals did I set for this quarter and have I made progress on any of them?",
  "who was at the dinner where we talked about the new apartment?",
  "what's the current status of the pgvector index rebuild on the 10 million row table?",
  "did Tony ever mark the onboarding doc as complete?",
  "what reminders are still open from last month?",
  "how did the CoreML experiment turn out on the M4 Pro?",
  "what quote did I save about slow, deliberate work?",
  "when did we last talk about moving the brain schema?",
  "what unfinished work is sitting in the backlog right now?",
  "who gave me the advice about not auto-linking memories?",
  "what happened during the incremental load test that rebuilt the primary key?",
  "is there a decision on record about the ef_search bound for hnsw?",
  "what's the plan for the next benchmark run at 10 million rows?",
  "did anyone ever explain why the why-sentence rule exists on edges?",
];

function percentile(sortedValues, p) {
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

function summarize(label, durationsMs) {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  console.log(
    `${label}: n=${sorted.length} min=${min.toFixed(3)}ms p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`,
  );
  return { p50, p95, min, max };
}

async function main() {
  console.log(`load average before (1/5/15m): ${loadavg().map((x) => x.toFixed(2)).join(" / ")}`);

  // Cold = first embedQuery call in this process, includes pipeline() model
  // load. The OS page cache from any prior run still applies, so this is
  // "warm-disk cold," not a true first-ever download.
  const coldStart = performance.now();
  await embedQuery(QUESTIONS[0]);
  const coldMs = performance.now() - coldStart;
  console.log(`cold (first call, includes model load): ${coldMs.toFixed(1)}ms`);

  // Warm: raw, uncached embedQuery over a rotating pool of realistic
  // questions, so results reflect real per-call cost, not a cache hit.
  const warmDurations = [];
  for (let i = 0; i < WARM_CALLS; i++) {
    const question = QUESTIONS[i % QUESTIONS.length];
    const start = performance.now();
    await embedQuery(question);
    warmDurations.push(performance.now() - start);
  }
  summarize(`warm embedQuery (uncached, ${WARM_CALLS} calls)`, warmDurations);

  // Cache hit: prime one entry, then repeatedly hit it through
  // embedQueryCached to measure the cache path in isolation.
  const cache = new LruCache(10);
  await embedQueryCached(QUESTIONS[0], { cache });
  const hitDurations = [];
  for (let i = 0; i < CACHE_HIT_CALLS; i++) {
    const start = performance.now();
    await embedQueryCached(QUESTIONS[0], { cache });
    hitDurations.push(performance.now() - start);
  }
  summarize(`cache hit (${CACHE_HIT_CALLS} calls)`, hitDurations);

  console.log(`load average after (1/5/15m): ${loadavg().map((x) => x.toFixed(2)).join(" / ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
