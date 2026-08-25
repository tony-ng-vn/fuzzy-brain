#!/bin/zsh
# Price one config change as INTERLEAVED A/B pairs, because sequential arms on
# this machine do not measure anything (DESIGN.md 7.4's cut hunt).
#
#   ./scripts/ab-pairs.sh topk25 '{"rerank":{"topK":25}}'
#   TIER=full10m PAIRS=4 ./scripts/ab-pairs.sh ef44 '{"lanes":{"scale":{"efSearch":44}}}'
#   TIER=full10m ./scripts/ab-pairs.sh control '{}'      # the drift measurement itself
#
# The method, and why it is the only valid one here. Run as sequential arms,
# every candidate came back a slowdown -- including re-running the identical
# baseline, which drifted 0.51 ms of p50 over half an hour of sustained load,
# three times the effect being measured. An A/B pair run back to back shares
# that environment, so the DIFFERENCE survives even when neither absolute
# number does.
#
# `control` is not optional ceremony. Running this with an empty override
# measures the drift between two adjacent identical windows, and a candidate
# whose paired delta is inside that band is NOT resolvable -- which is a
# different statement from "measured as zero" and has to be reported as one.
set -u
cd "$(dirname "$0")/.." || exit 1

LABEL=${1:?usage: ab-pairs.sh <label> <json-override-for-arm-B>}
OVERRIDE=${2:?usage: ab-pairs.sh <label> <json-override-for-arm-B>}
TIER=${TIER:-rehearsal1m}
OUT=${OUT:-.out/$TIER}
PAIRS=${PAIRS:-4}
DUR=${DUR:-30}
WARM=${WARM:-8}
BASE_OVERRIDE=${BASE_OVERRIDE:-'{}'}

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery."; exit 1; }

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuner busy on bench_q50k, waiting (${waited}s)"
    sleep 15; waited=$((waited + 15))
  done
}

run_window() {
  local override=$1 out=$2
  BENCH_CONFIG_OVERRIDE="$override" node bench-load.mjs --tier "$TIER" --profile tunedScale \
    --mode closed --sweep 1 --sweep-duration "$DUR" --sweep-warmup "$WARM" \
    --skip-select1-probe --recall-sample-rate 1.0 --out "$out" > /dev/null 2>&1
}

echo "[$(date +%T)] ${LABEL}: ${PAIRS} interleaved pairs on ${TIER}, ${WARM}s warmup + ${DUR}s measured per window"
echo "[$(date +%T)]   A = ${BASE_OVERRIDE}"
echo "[$(date +%T)]   B = ${OVERRIDE}"
for i in $(seq 1 "$PAIRS"); do
  wait_for_tuner
  on_ac || { echo "ABORT: dropped to battery"; exit 1; }
  run_window "$BASE_OVERRIDE" "$OUT/ab-$LABEL-A-$i.json"
  run_window "$OVERRIDE"      "$OUT/ab-$LABEL-B-$i.json"
  echo "[$(date +%T)]   pair $i done"
done

OUT=$OUT LABEL=$LABEL PAIRS=$PAIRS node -e '
const fs = require("fs");
const { OUT, LABEL, PAIRS } = process.env;
const read = (arm, i) => JSON.parse(fs.readFileSync(`${OUT}/ab-${LABEL}-${arm}-${i}.json`, "utf8")).closedSweep[0];
const d = [];
console.log("pair   A p50   B p50   delta    A R@10   B R@10   A qps   B qps");
for (let i = 1; i <= Number(PAIRS); i++) {
  const a = read("A", i), b = read("B", i);
  const delta = b.latencyMs.p50 - a.latencyMs.p50;
  d.push({ delta, ra: a.recall.mixWeighted.recallAt10, rb: b.recall.mixWeighted.recallAt10 });
  console.log(String(i).padEnd(6)
    + a.latencyMs.p50.toFixed(2).padStart(6) + b.latencyMs.p50.toFixed(2).padStart(8)
    + delta.toFixed(2).padStart(8)
    + a.recall.mixWeighted.recallAt10.toFixed(4).padStart(9)
    + b.recall.mixWeighted.recallAt10.toFixed(4).padStart(9)
    + a.qpsCompleted.toFixed(0).padStart(8) + b.qpsCompleted.toFixed(0).padStart(8)
    + (a.window.valid && b.window.valid ? "" : "   INVALID WINDOW"));
}
const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
const md = mean(d.map((x) => x.delta));
const neg = d.filter((x) => x.delta < 0).length;
// Sign consistency is what makes a paired delta credible on a machine whose
// absolute numbers drift: a real effect points the same way in every pair.
console.log(`\npaired mean delta p50 : ${md.toFixed(3)} ms  (negative = B is faster), negative in ${neg} of ${d.length} pairs`);
console.log(`recall  A ${mean(d.map((x) => x.ra)).toFixed(4)}   B ${mean(d.map((x) => x.rb)).toFixed(4)}`);
'
