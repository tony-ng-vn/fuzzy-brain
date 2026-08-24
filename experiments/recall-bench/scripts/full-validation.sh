#!/bin/zsh
# Full claim-B validation for the scale profile at 1M, after the section 6.7
# cost work.
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   nohup ./scripts/full-validation.sh > .out/rehearsal1m/full-validation.log 2>&1 &
#   tail -f .out/rehearsal1m/full-validation.log
#
# Closed-loop ceiling sweep at 8/16/32/64, then open-loop at 1200/1800/2400,
# every window 60s warmup + 120s measured. Takes about 35 minutes.
#
# Three validity guards, because on this machine a window can lie three ways:
#
#  1. AC power. The battery profile carries `sleep 1` and `caffeinate -s` does
#     not hold on battery. A window spanning a Maintenance Sleep reports
#     offered == completed with a plausible QPS and a p50 in the hundreds of
#     seconds. Checked once up front and again before every window.
#  2. Suspend verdicts. bench-load's dispatch ticker fires every 10 ms, so a
#     multi-second gap between ticks means the machine stopped running us.
#     Every window carries its own verdict and this script prints it.
#  3. Contention. A tuning agent runs bench-recall against bench_q50k on the
#     same cluster in bursts. One of twelve cores held by someone else is a
#     real error on a rate measurement, and checking once before a window is
#     not enough -- a burst that starts ten seconds in still corrupts it. Each
#     window is sampled every 5 seconds throughout and the overlap is reported
#     rather than hidden.
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=.out/rehearsal1m
WARM=${WARM:-60}
DUR=${DUR:-120}

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }

if ! on_ac; then
  echo "ABORT: on battery. Rate windows are not trustworthy here -- plug in first."
  exit 1
fi

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuning agent busy on bench_q50k, waiting (${waited}s)"
    sleep 15
    waited=$((waited + 15))
  done
}

# Runs one command with a contention sampler alongside it; echoes the overlap
# count on the last line so the caller can label the window.
sampled() {
  local marker=$(mktemp)
  ( while :; do
      pgrep -f 'bench-recall.mjs' > /dev/null 2>&1 && echo x >> "$marker"
      sleep 5
    done ) &
  local sampler=$!
  "$@"
  kill $sampler 2>/dev/null
  local n=$(wc -l < "$marker" | tr -d ' ')
  rm -f "$marker"
  if [ "$n" -gt 0 ]; then
    echo "[$(date +%T)] CONTENDED: tuning agent overlapped this window in $n of the 5s samples -- treat the number as a floor, not a result"
  else
    echo "[$(date +%T)] clean: no competing bench-recall during this window"
  fi
}

echo "[$(date +%T)] ================ closed-loop ceiling sweep 8/16/32/64 ================"
echo "[$(date +%T)] warmup ${WARM}s, measured ${DUR}s per concurrency"
wait_for_tuner
on_ac || { echo "ABORT: dropped to battery"; exit 1; }
sampled node bench-load.mjs --tier rehearsal1m --profile tunedScale --mode closed \
  --sweep 8,16,32,64 --sweep-duration "$DUR" --sweep-warmup "$WARM" \
  --out "$OUT/final-closed.json"

cat > "$OUT/read-closed.cjs" <<'JS'
const r = require(process.argv[2]);
for (const w of r.closedSweep ?? []) {
  const v = w.window && w.window.valid === true ? 'valid' : `INVALID (${w.window && w.window.reason})`;
  console.log(`  c=${String(w.concurrency).padStart(2)}  qps=${(w.qpsCompleted ?? 0).toFixed(0).padStart(5)}`
    + `  p50=${(w.latencyMs?.p50 ?? 0).toFixed(2).padStart(7)}ms`
    + `  p95=${(w.latencyMs?.p95 ?? 0).toFixed(2).padStart(7)}ms`
    + `  p99=${(w.latencyMs?.p99 ?? 0).toFixed(2).padStart(7)}ms`
    + `  sqlMs=${(w.sqlMs?.mean ?? 0).toFixed(2).padStart(6)}  ${v}`);
}
JS
echo "[$(date +%T)] closed-loop windows:"
node "$OUT/read-closed.cjs" "$PWD/$OUT/final-closed.json"

for RATE in 1200 1800 2400; do
  echo ""
  echo "[$(date +%T)] ================ open-loop, offered ${RATE} QPS ================"
  wait_for_tuner
  on_ac || { echo "ABORT: dropped to battery"; exit 1; }
  sampled node bench-load.mjs --tier rehearsal1m --profile tunedScale --mode open \
    --offered-qps "$RATE" --duration "$DUR" --warmup "$WARM" --skip-select1-probe \
    --out "$OUT/final-open-$RATE.json"
  node -e '
    const r = require(process.argv[1]);
    const o = r.open ?? {};
    const w = o.window ?? {};
    console.log(`  offered=${o.offeredQps} completed=${(o.qpsCompleted ?? 0).toFixed(1)}`
      + ` p50=${(o.latencyMs?.p50 ?? 0).toFixed(2)}ms p95=${(o.latencyMs?.p95 ?? 0).toFixed(2)}ms`
      + ` p99=${(o.latencyMs?.p99 ?? 0).toFixed(2)}ms`
      + ` inFlightGrowing=${o.inFlightGrowing} window=${w.valid === true ? "valid" : "INVALID: " + w.reason}`
      + ` gate=${r.gate?.pass ? "PASS" : "FAIL"}`);
  ' "$PWD/$OUT/final-open-$RATE.json"
done

echo ""
echo "[$(date +%T)] VALIDATION COMPLETE -- a window labelled CONTENDED or INVALID is not a result"
