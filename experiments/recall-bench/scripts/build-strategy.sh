#!/bin/zsh
# The build-strategy comparison at 1M, which decides how (and whether) the 10M
# tier can be built on this machine.
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   nohup ./scripts/build-strategy.sh > .out/build-strategy/arms-1m.log 2>&1 &
#
# DESIGN.md 7.4 stopped the 10M rung on one number: a BULK HNSW build holds the
# whole graph in maintenance_work_mem, which is ~15.9 GB at 10M on a 24 GB
# machine already 7 GB into swap. Three ways out, and this prices all three at
# 1M where they are cheap, on the same day and the same machine so the arms are
# comparable to each other rather than to a number from a previous session:
#
#   bulk        rows first, index after. The known baseline (6 min 04 s, 7.4).
#               Needs the full graph resident, which is the constraint.
#   incremental index first, rows after. Memory per insert is independent of
#               corpus size. Costs wall clock; 7.1 already accepts hours.
#   bulk-spill  rows first, index after, but with maintenance_work_mem set to
#               what a 10M build could actually be given. pgvector spills to
#               its on-disk path partway through, so this measures the 10M
#               build's real shape at a size that fits.
#
# Each arm is followed by a whole-pipeline recall run at the tier's pinned
# ef_search 48, because an incrementally grown graph is not the same graph a
# bulk build produces and pgvector promises nothing about the difference. An
# arm that builds fast and retrieves worse is not a cheaper build.
#
# Guards: AC power (a build timed on battery times the power manager), a disk
# floor, and a wait for the co-running tuning agent. Nothing here touches
# bench_r1m or bench_q50k -- every arm writes a bench_bs_* scratch schema and
# reads bench_r1m through a plain SELECT.
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=.out/build-strategy
ROWS=${ROWS:-1000000}
MIN_FREE_GB=12
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)

# What a 10M bulk build could plausibly be given on this machine, scaled down to
# the rehearsal size so the spill fraction matches. 10M would need 15.9 GB and
# could be given ~4 GB after dropping shared_buffers, so 25% of the requirement;
# at 1M that is 25% of 1,521 MB.
SPILL_MWM_MB=${SPILL_MWM_MB:-380}

mkdir -p "$OUT"

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
free_gb() { df -g /System/Volumes/Data | awk 'NR==2 {print $4}'; }

on_ac || { echo "ABORT: on battery. A build timed on battery times the power manager."; exit 1; }

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuning agent busy on bench_q50k, waiting (${waited}s)"
    sleep 15
    waited=$((waited + 15))
  done
}

# One arm: build, measure recall on the graph it produced, then give the disk
# back. Dropping between arms is what keeps four 1.8 GB schemas from competing
# for the same volume the next arm is about to write to.
arm() {
  local label=$1; shift
  local schema="bench_bs_${label}"

  local free=$(free_gb)
  if [ "$free" -lt "$MIN_FREE_GB" ]; then
    echo "[$(date +%T)] ABORT: ${free} GB free, under the ${MIN_FREE_GB} GB floor -- not starting arm ${label}"
    exit 1
  fi
  on_ac || { echo "ABORT: dropped to battery"; exit 1; }
  wait_for_tuner

  echo ""
  echo "[$(date +%T)] ================ arm ${label} ================"
  node scripts/build-arm.mjs --schema "$schema" --rows "$ROWS" --out "$OUT/arm-$label.json" "$@" || exit 1

  echo "[$(date +%T)] ---- recall equivalence for arm ${label} ----"
  ./scripts/arm-recall.sh "$schema" "$label" || exit 1

  "${PSQL[@]}" -c "drop schema ${schema} cascade;" > /dev/null
  echo "[$(date +%T)] dropped ${schema}; $(free_gb) GB free"
}

echo "[$(date +%T)] clearing leftover scratch schemas"
"${PSQL[@]}" -tAc "select 'drop schema ' || nspname || ' cascade;' from pg_namespace where nspname like 'bench_bs_%'" \
  | "${PSQL[@]}" -q > /dev/null 2>&1
echo "[$(date +%T)] free disk: $(free_gb) GB, rows per arm: ${ROWS}"

arm bulk1m        --arm bulk --streams 1 --chunk-rows 250000
arm inc8_1m       --arm incremental --streams 8 --chunk-rows 25000
arm bulkspill1m   --arm bulk --streams 1 --chunk-rows 250000 --mwm-mb "$SPILL_MWM_MB"
arm inc4_1m       --arm incremental --streams 4 --chunk-rows 25000

echo ""
echo "[$(date +%T)] BUILD STRATEGY COMPARISON COMPLETE"
