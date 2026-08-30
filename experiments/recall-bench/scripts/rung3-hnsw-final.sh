#!/bin/zsh
# The rung 3 measurement set, re-run on HNSW with real drifted query vectors
# (DESIGN.md 7.1 / 7.2). Everything decision 3 through decision 5 asks for, in
# one unattended pass, because each step needs the one before it and the machine
# should not sit idle between them.
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   nohup ./scripts/rung3-hnsw-final.sh > .out/rehearsal1m/rung3-final.log 2>&1 &
#
#   1. restore the tier's pinned m = 16 graph (a denser m = 32 was measured and
#      is not kept -- see 7.2)
#   2. whole-pipeline recall / single-stream p50 frontier over ef_search
#   3. plan-node profile at the pinned ef_search
#   4. full validation: closed-loop sweep, then open-loop upward
#
# Every rate window carries the three guards this machine can violate: AC power,
# the suspend verdict, and a contention sampler for the co-running agent's
# bench_q50k bursts. Recall now rides in every report, so no throughput number
# here can be read without the recall it was produced at.
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=.out/rehearsal1m
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)
WARM=${WARM:-60}
DUR=${DUR:-120}
PIN_EF=${PIN_EF:-40}

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery -- no rate window here is trustworthy."; exit 1; }

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuner busy on bench_q50k, waiting (${waited}s)"
    sleep 15; waited=$((waited + 15))
  done
}

sampled() {
  local marker=$(mktemp)
  ( while :; do pgrep -f 'bench-recall.mjs' >/dev/null 2>&1 && echo x >> "$marker"; sleep 5; done ) &
  local s=$!
  "$@"
  kill $s 2>/dev/null
  local n=$(wc -l < "$marker" | tr -d ' '); rm -f "$marker"
  [ "$n" -gt 0 ] \
    && echo "[$(date +%T)] CONTENDED in $n of the 5s samples -- floor, not a result" \
    || echo "[$(date +%T)] clean: no competing bench-recall in this window"
}

echo "[$(date +%T)] ============ step 1: restore the pinned m = 16 graph ============"
wait_for_tuner
HAVE16=$("${PSQL[@]}" -tAc "select count(*) from pg_indexes where schemaname='bench_r1m' and indexdef ilike '%m=''16''%'")
if [ "$HAVE16" -eq 0 ]; then
  "${PSQL[@]}" -c "set maintenance_work_mem='3GB';" -c "\timing on" \
    -c "create index bench_r1m_memories_embedding_hnsw on bench_r1m.memories using hnsw (embedding halfvec_cosine_ops) with (m=16, ef_construction=200);"
fi
"${PSQL[@]}" -c "drop index if exists bench_r1m.m32_hnsw;"
"${PSQL[@]}" -c "analyze bench_r1m.memories;"
"${PSQL[@]}" -tAc "select '  index: ' || indexname from pg_indexes where schemaname='bench_r1m' and indexdef ilike '%hnsw%'"

echo ""
echo "[$(date +%T)] ============ step 2: whole-pipeline recall / p50 frontier ============"
wait_for_tuner
./scripts/pipeline-ef-sweep.sh 2>&1 | tee "$OUT/pipeline-ef-sweep.log"

echo ""
echo "[$(date +%T)] ============ step 3: plan-node profile at ef_search ${PIN_EF} ============"
wait_for_tuner
BENCH_CONFIG_OVERRIDE="{\"lanes\":{\"scale\":{\"efSearch\":${PIN_EF}}}}" \
  N=8 node scripts/explain-scale.mjs 2>&1 | tee "$OUT/explain-scale-hnsw.log"

echo ""
echo "[$(date +%T)] ============ step 4: closed-loop ceiling sweep ============"
wait_for_tuner
on_ac || { echo "ABORT: dropped to battery"; exit 1; }
sampled node bench-load.mjs --tier rehearsal1m --profile tunedScale --mode closed \
  --sweep 1,8,16,32,64 --sweep-duration "$DUR" --sweep-warmup "$WARM" \
  --out "$OUT/hnsw-closed.json"
node -e '
const r = require(process.argv[1]);
console.log("  conc   qps    p50ms   p95ms   p99ms  R@10(mix)  window");
for (const w of r.closedSweep ?? []) {
  console.log("  " + String(w.concurrency).padStart(4)
    + (w.qpsCompleted ?? 0).toFixed(0).padStart(7)
    + (w.latencyMs?.p50 ?? 0).toFixed(2).padStart(8)
    + (w.latencyMs?.p95 ?? 0).toFixed(2).padStart(8)
    + (w.latencyMs?.p99 ?? 0).toFixed(2).padStart(8)
    + (w.recall ? w.recall.mixWeighted.recallAt10.toFixed(3) : "n/a").padStart(11)
    + "  " + (w.window?.valid ? "valid" : "INVALID: " + w.window?.reason));
}' "$PWD/$OUT/hnsw-closed.json"

for RATE in 1400 1800 2100 2400; do
  echo ""
  echo "[$(date +%T)] ============ step 4: open-loop, offered ${RATE} QPS ============"
  wait_for_tuner
  on_ac || { echo "ABORT: dropped to battery"; exit 1; }
  sampled node bench-load.mjs --tier rehearsal1m --profile tunedScale --mode open \
    --offered-qps "$RATE" --duration "$DUR" --warmup "$WARM" --skip-select1-probe \
    --out "$OUT/hnsw-open-$RATE.json"
  node -e '
    const r = require(process.argv[1]); const o = r.open ?? {}; const w = o.window ?? {};
    console.log(`  offered=${o.offeredQps} completed=${(o.qpsCompleted ?? 0).toFixed(1)}`
      + ` p50=${(o.latencyMs?.p50 ?? 0).toFixed(2)}ms p95=${(o.latencyMs?.p95 ?? 0).toFixed(2)}ms`
      + ` inFlightGrowing=${o.inFlightGrowing}`
      + ` R@10=${o.recall ? o.recall.mixWeighted.recallAt10.toFixed(3) : "n/a"}`
      + ` window=${w.valid === true ? "valid" : "INVALID: " + w.reason}`
      + ` gate=${r.gate?.pass ? "PASS" : "FAIL"}`);
  ' "$PWD/$OUT/hnsw-open-$RATE.json"
done

echo ""
echo "[$(date +%T)] RUNG 3 HNSW FINAL COMPLETE -- a window marked CONTENDED or INVALID is not a result"
