#!/bin/zsh
# The recall/latency frontier the scale tier's ef_search is chosen from
# (DESIGN.md 7.1, decision 3): the smallest hnsw.ef_search whose WHOLE-PIPELINE
# recall on real drifted query vectors clears 0.90.
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   ./scripts/pipeline-ef-sweep.sh 2>&1 | tee .out/rehearsal1m/pipeline-ef-sweep.log
#
# One instrument for both axes. bench-load at concurrency 1 is the single-stream
# latency measurement rung 3 already reports p50 from, and since the
# deviation-2 fix it reports whole-pipeline recall from the same window -- so
# each row of the frontier is one run and the two numbers cannot drift apart by
# being measured differently.
#
# Concurrency 1 on purpose: this sweep is choosing a recall floor, and a
# saturated machine's p50 would fold queueing into a number meant to price the
# index. The throughput consequences are section 8's job, measured afterwards by
# full-validation.sh at the ef_search this picks.
#
# recall-sample-rate 1.0 and a window long enough for a full pass over the 4,000
# distinct queries: recall is deterministic per query, so a pass is all the
# information there is and further cycles only re-measure it.
set -u
cd "$(dirname "$0")/.." || exit 1

# TIER is overridable so the same instrument sweeps rung 4 at 10M; the default
# reproduces 7.4's 1M frontier with no environment set.
TIER=${TIER:-rehearsal1m}
OUT=${OUT:-.out/$TIER}
EFS=${EFS:-"40 64 100 200 400"}
WARM=${WARM:-10}
DUR=${DUR:-40}

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery. Even a single-stream p50 is not trustworthy here -- plug in first."; exit 1; }

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuning agent busy on bench_q50k, waiting (${waited}s)"
    sleep 15
    waited=$((waited + 15))
  done
}

echo "[$(date +%T)] ef_search sweep: $EFS  (warmup ${WARM}s, measured ${DUR}s, single stream)"
for EF in ${=EFS}; do
  wait_for_tuner
  on_ac || { echo "ABORT: dropped to battery"; exit 1; }
  echo ""
  echo "[$(date +%T)] ---------------- hnsw.ef_search = $EF ----------------"
  BENCH_CONFIG_OVERRIDE="{\"lanes\":{\"scale\":{\"efSearch\":$EF}}}" \
    node bench-load.mjs --tier "$TIER" --profile tunedScale --mode closed \
      --sweep 1 --sweep-duration "$DUR" --sweep-warmup "$WARM" \
      --skip-select1-probe --recall-sample-rate 1.0 \
      --out "$OUT/ef-$EF.json" 2>&1 | grep -vE '^(target|schema size|query pool|report written)'
done

echo ""
echo "[$(date +%T)] ================ frontier ================"
OUT=$OUT node -e '
const fs = require("fs");
const efs = process.argv.slice(1);
console.log("ef_search  R@10(mix)  R@10(unweighted)  R@1(mix)  p50 ms   qps   window");
for (const ef of efs) {
  const p = `${process.env.OUT}/ef-${ef}.json`;
  if (!fs.existsSync(p)) continue;
  const w = JSON.parse(fs.readFileSync(p, "utf8")).closedSweep[0];
  const r = w.recall;
  console.log(
    String(ef).padEnd(10)
    + r.mixWeighted.recallAt10.toFixed(3).padStart(9)
    + r.unweighted.recallAt10.toFixed(3).padStart(18)
    + r.mixWeighted.recallAt1.toFixed(3).padStart(10)
    + w.latencyMs.p50.toFixed(2).padStart(8)
    + w.qpsCompleted.toFixed(0).padStart(7)
    + "   " + (w.window.valid ? "valid" : "INVALID: " + w.window.reason));
}
' ${=EFS}
echo "[$(date +%T)] SWEEP COMPLETE"
