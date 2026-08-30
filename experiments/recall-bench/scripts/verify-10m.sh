#!/bin/zsh
# Does the 10M tier actually retrieve? Everything that has to be true before a
# single throughput number is worth reporting (DESIGN.md 6.8's rule).
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   nohup ./scripts/verify-10m.sh > .out/full10m/verify.log 2>&1 &
#
# Four steps, in the order that makes a miss attributable rather than arguable:
#
#   1. GEOMETRY. 7.3 solved the jitter/drift pair against the 10M noise floor
#      (0.283 at 256 dims) rather than the 1M one (0.251), specifically so the
#      corpus would not have to be regenerated at this tier. That is a
#      prediction, and this measures it on the corpus as loaded.
#   2. NEAR-EXACT CEILING. The whole-pipeline recall the pipeline reaches when
#      the vector lane is allowed to search far past any affordable setting.
#      7.4 measured 0.990 at 1M this way and the number is what let it say the
#      remaining gap belonged to the index rather than to the corpus.
#   3. THE FRONTIER. The ef_search sweep, and the smallest value clearing 0.90.
#
# Step 1 carries its own exact control: geometry-probe computes the top-30 with
# index scans disabled, so its "target rank 1 under exact cosine" column is the
# vector lane measured without any index at all. That is what keeps step 2's
# ef_search 4000 honest -- at 10M that is a far smaller fraction of the corpus
# than the ef_search 1000 that produced 7.4's 0.990 at 1M.
#
# If step 2 comes back under 0.90 the sweep in step 3 cannot reach it either,
# and the honest output is the ceiling plus its per-family breakdown -- not a
# throughput run.
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=.out/full10m
TIER=full10m
EFS=${EFS:-"32 48 64 100 200"}
CEIL_DUR=${CEIL_DUR:-300}
mkdir -p "$OUT"

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery."; exit 1; }

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuner busy on bench_q50k, waiting (${waited}s)"
    sleep 15; waited=$((waited + 15))
  done
}

echo "[$(date +%T)] ============ step 1: geometry, as loaded at 10M ============"
wait_for_tuner
TIER=$TIER SPLIT=test N=${GEO_N:-60} NCLUSTERS=${GEO_CLUSTERS:-20} MEMBERS=${GEO_MEMBERS:-10} \
  node scripts/geometry-probe.mjs 2>&1 | tee "$OUT/geometry.log"

echo ""
echo "[$(date +%T)] ============ step 2: near-exact whole-pipeline ceiling ============"
wait_for_tuner
BENCH_CONFIG_OVERRIDE='{"lanes":{"scale":{"efSearch":4000,"filteredEfSearch":4000,"filteredMaxScanTuples":20000000}}}' \
  node bench-load.mjs --tier "$TIER" --profile tunedScale --mode closed \
    --sweep 1 --sweep-duration "$CEIL_DUR" --sweep-warmup 10 \
    --skip-select1-probe --recall-sample-rate 1.0 \
    --out "$OUT/ceiling-nearexact.json" 2>&1 | tee "$OUT/ceiling-nearexact.log"

echo ""
echo "[$(date +%T)] ============ step 3: the ef_search frontier at 10M ============"
wait_for_tuner
TIER=$TIER OUT=$OUT EFS="$EFS" WARM=${WARM:-15} DUR=${DUR:-90} ./scripts/pipeline-ef-sweep.sh 2>&1 | tee "$OUT/pipeline-ef-sweep.log"

echo ""
echo "[$(date +%T)] 10M VERIFICATION COMPLETE"
