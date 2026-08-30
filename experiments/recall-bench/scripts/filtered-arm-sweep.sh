#!/bin/zsh
# The filtered vector lane's own frontier, swept separately because its knobs
# are separate (DESIGN.md 7.2 flagged this as a defect in its own method: with
# filteredEfSearch and filteredMaxScanTuples pinned while efSearch swept,
# date_filter -- 15% of the mix and the worst family -- contributed a fixed
# floor to every row, and the flat portion of that frontier was the floor
# rather than ef_search saturating).
#
#   EF=48 ./scripts/filtered-arm-sweep.sh 2>&1 | tee .out/rehearsal1m/filtered-arm.log
#
# 7.2 also established which axis actually moves this lane: max_scan_tuples,
# not ef_search, because iterative scan keeps widening the scan until it has
# enough rows that pass the filter and the bound is what stops it. So that is
# the axis swept here, at a fixed unfiltered ef_search.
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=.out/rehearsal1m
EF=${EF:-48}
TUPLES=${TUPLES:-"2000 8000 20000 50000"}
WARM=${WARM:-10}
DUR=${DUR:-45}

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery."; exit 1; }

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuning agent busy, waiting (${waited}s)"
    sleep 15
    waited=$((waited + 15))
  done
}

echo "[$(date +%T)] filtered arm at ef_search ${EF}: max_scan_tuples $TUPLES"
for T in ${=TUPLES}; do
  wait_for_tuner
  on_ac || { echo "ABORT: dropped to battery"; exit 1; }
  echo ""
  echo "[$(date +%T)] ---------------- filteredMaxScanTuples = $T ----------------"
  BENCH_CONFIG_OVERRIDE="{\"lanes\":{\"scale\":{\"efSearch\":$EF,\"filteredMaxScanTuples\":$T}}}" \
    node bench-load.mjs --tier rehearsal1m --profile tunedScale --mode closed \
      --sweep 1 --sweep-duration "$DUR" --sweep-warmup "$WARM" \
      --skip-select1-probe --recall-sample-rate 1.0 \
      --out "$OUT/filt-$T.json" 2>&1 | grep -vE '^(target|schema size|query pool|report written)'
done

echo ""
echo "[$(date +%T)] ================ filtered frontier ================"
node -e '
const fs = require("fs");
console.log("max_scan_tuples  date_filter R@10  R@10(mix)  p50 ms   qps   window");
for (const t of process.argv.slice(1)) {
  const p = `.out/rehearsal1m/filt-${t}.json`;
  if (!fs.existsSync(p)) continue;
  const w = JSON.parse(fs.readFileSync(p, "utf8")).closedSweep[0];
  const df = w.recall.families?.date_filter;
  console.log(
    String(t).padEnd(16)
    + (df ? df.recallAt10.toFixed(3) : "  n/a").padStart(16)
    + w.recall.mixWeighted.recallAt10.toFixed(3).padStart(11)
    + w.latencyMs.p50.toFixed(2).padStart(8)
    + w.qpsCompleted.toFixed(0).padStart(7)
    + "   " + (w.window.valid ? "valid" : "INVALID: " + w.window.reason));
}
' ${=TUPLES}
echo "[$(date +%T)] FILTERED SWEEP COMPLETE"
