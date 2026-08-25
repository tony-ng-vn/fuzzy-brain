#!/bin/zsh
# Build the 10M tier (DESIGN.md rung 4, claim B), in the shape the 1M
# build-strategy rehearsal picked.
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   nohup ./scripts/build-10m.sh > .out/full10m/build.log 2>&1 &
#   tail -f .out/full10m/build.log
#
# Three phases, and the middle one is the whole point:
#
#   1. STREAM the corpus into a staging heap with no indexes on it. No 10M
#      JSONL touches disk and no 10M plan is ever resident -- see
#      scripts/stream-corpus.mjs for why load.mjs --stream cannot do this.
#   2. INSERT it into the real schema, whose HNSW index already exists and is
#      therefore maintained one row at a time, across 8 concurrent streams.
#      This is what replaces the bulk build's ~15.9 GB maintenance_work_mem
#      requirement with a per-insert cost that does not scale with corpus size.
#   3. Build the lexical indexes AFTER the rows, not before. Holding GIN back
#      costs nothing on the insert side (measured: an incremental insert runs at
#      the same rate with and without it) and avoids leaving 10M rows' worth of
#      GIN pending list for the first query to walk.
#
# The staging heap costs a second copy of the 9.8 GB heap and is dropped as soon
# as the insert phase verifies its row count. Peak footprint is therefore about
# 28 GB, checked against the disk floor before anything starts.
set -u
cd "$(dirname "$0")/.." || exit 1

OUT=.out/full10m
SCHEMA=bench_x10m
STAGE=bench_x10m_stage
STREAMS=${STREAMS:-8}
ROWS=${ROWS:-10000000}
# Peak is the staging heap plus the finished schema; abort rather than fill the
# volume four hours into an unattended build.
MIN_FREE_GB=${MIN_FREE_GB:-32}
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)

mkdir -p "$OUT"

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
free_gb() { df -g /System/Volumes/Data | awk 'NR==2 {print $4}'; }

on_ac || { echo "ABORT: on battery. A multi-hour build timed on battery times the power manager."; exit 1; }
FREE=$(free_gb)
if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
  echo "ABORT: ${FREE} GB free, under the ${MIN_FREE_GB} GB floor this build needs at peak."
  exit 1
fi
echo "[$(date +%T)] free disk ${FREE} GB, rows ${ROWS}, streams ${STREAMS}"
echo "[$(date +%T)] $(top -l 1 -n 0 | grep PhysMem)"

wait_for_tuner() {
  local waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuning agent busy on bench_q50k, waiting (${waited}s)"
    sleep 15
    waited=$((waited + 15))
  done
}

# Disk is sampled throughout: at 10M this runs for hours, and a build that fills
# the volume unattended is worse than one that stops itself.
( while :; do
    sleep 120
    F=$(free_gb)
    echo "  [disk] ${F} GB free  [$(date +%T)]"
    if [ "$F" -lt 10 ]; then
      # Log the row count BEFORE cancelling. Phase 2 runs 8 insert streams, so a
      # cancel leaves the schema partially loaded, and a log that does not say
      # how far it got makes the wreckage unreadable.
      echo "  [disk] ABORT THRESHOLD CROSSED at ${F} GB"
      echo "  [disk] rows in ${SCHEMA}.memories at cancel: $("${PSQL[@]}" -tAc "select count(*) from ${SCHEMA}.memories" 2>/dev/null || echo '?')"
      "${PSQL[@]}" -tAc "select pg_cancel_backend(pid) from pg_stat_activity where datname = 'recallbench' and state = 'active' and pid <> pg_backend_pid()" >/dev/null 2>&1
    fi
  done ) &
WATCH=$!
trap "kill $WATCH 2>/dev/null" EXIT

echo ""
echo "[$(date +%T)] ============ phase 1: stream the corpus into ${STAGE} ============"
wait_for_tuner
node --max-old-space-size=4000 scripts/stream-corpus.mjs --tier full10m --rows "$ROWS" \
  --schema "$STAGE" --out-dir "$OUT" || exit 1

echo ""
echo "[$(date +%T)] ============ phase 2: incremental HNSW into ${SCHEMA}, ${STREAMS} streams ============"
wait_for_tuner
on_ac || { echo "ABORT: dropped to battery"; exit 1; }
node scripts/build-arm.mjs --arm incremental --streams "$STREAMS" --pre-index hnsw \
  --rows "$ROWS" --chunk-rows 25000 --source "${STAGE}.memories" --schema "$SCHEMA" \
  --out "$OUT/build-arm.json" || exit 1

echo ""
echo "[$(date +%T)] ============ phase 3: term statistics, and give the staging heap back ============"
node load.mjs --tier full10m --term-stats || exit 1
"${PSQL[@]}" -c "drop schema ${STAGE} cascade;" || exit 1

"${PSQL[@]}" -c "analyze ${SCHEMA}.memories;"
"${PSQL[@]}" -c "select c.relname, pg_size_pretty(pg_relation_size(c.oid)) as size
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = '${SCHEMA}' and c.relkind in ('r','i')
  order by pg_relation_size(c.oid) desc;"
"${PSQL[@]}" -c "select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as schema_total
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = '${SCHEMA}' and c.relkind = 'r';"

echo "[$(date +%T)] free disk after: $(free_gb) GB"
echo "[$(date +%T)] 10M BUILD COMPLETE"
