#!/bin/zsh
# Build the scale tier's HNSW index, under the two constraints that replaced the
# 90-minute wall-clock gate (DESIGN.md 7.1): the graph must not spill out of
# maintenance_work_mem, and disk stays inside the budget.
#
#   ./scripts/hnsw-build.sh bench_r1m           # the 1M rehearsal
#   ./scripts/hnsw-build.sh bench_x10m          # the 10M claim build
#
# maintenance_work_mem is SIZED, not guessed. Measured on this machine with
# scripts/hnsw-mem-probe.sh: pgvector reported the graph outgrowing a 128 MiB
# budget after 109,390 tuples of halfvec(256) at m = 16, which is 1,227 bytes
# per tuple. The session asks for that per row plus a 30% margin, and the build
# is watched for the spill NOTICE anyway -- the arithmetic is a prediction and
# the NOTICE is the measurement.
#
# Why spilling matters more than slowness: past the spill point pgvector drops
# to a much slower disk-based path, so a spilled build is not merely a longer
# build, it is one whose duration no longer extrapolates from a smaller tier.
# Catching that was the original point of rung 3 and it still is.
set -u
cd "$(dirname "$0")/.." || exit 1

SCHEMA=${1:?usage: hnsw-build.sh <schema>}
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)

BYTES_PER_TUPLE=1227
MARGIN_PCT=30
MIN_FREE_GB=10
M=${M:-16}
EF_CONSTRUCTION=${EF_CONSTRUCTION:-200}

free_gb() { df -g /System/Volumes/Data | awk 'NR==2 {print $4}'; }

FREE=$(free_gb)
if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
  echo "ABORT: only ${FREE} GB free on the data volume, under the ${MIN_FREE_GB} GB floor."
  exit 1
fi

ROWS=$("${PSQL[@]}" -tAc "select count(*) from ${SCHEMA}.memories where embedding is not null")
NEED_MB=$(( ROWS * BYTES_PER_TUPLE / 1048576 ))
MWM_MB=$(( NEED_MB * (100 + MARGIN_PCT) / 100 ))
[ "$MWM_MB" -lt 512 ] && MWM_MB=512

echo "[$(date +%T)] schema      : ${SCHEMA}"
echo "[$(date +%T)] rows        : ${ROWS}"
echo "[$(date +%T)] graph needs : ~${NEED_MB} MB at ${BYTES_PER_TUPLE} bytes/tuple (measured, hnsw-mem-probe.sh)"
echo "[$(date +%T)] mwm request : ${MWM_MB} MB (+${MARGIN_PCT}% margin)"
echo "[$(date +%T)] free disk   : ${FREE} GB"
echo "[$(date +%T)] host memory : $(top -l 1 -n 0 | grep PhysMem)"

# A co-running rate window on this cluster loses a core per parallel maintenance
# worker, which is a real error on someone else's measurement, not just noise.
if pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; then
  echo "[$(date +%T)] tuning agent is running bench-recall; waiting for it to finish before taking cores"
  waited=0
  while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
    [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)]   still waiting (${waited}s)"
    sleep 15
    waited=$((waited + 15))
  done
fi

# Progress and disk are sampled alongside the build: at 10M this runs for hours
# and a build with no progress line is indistinguishable from a hung one.
( while :; do
    sleep 60
    "${PSQL[@]}" -tAc "select '  [progress] ' || coalesce(phase,'?') || ' ' ||
       coalesce(tuples_done::text,'0') || '/' || coalesce(nullif(tuples_total,0)::text,'?') || ' tuples'
       from pg_stat_progress_create_index limit 1" 2>/dev/null | grep . || true
    F=$(free_gb)
    echo "  [disk] ${F} GB free"
    if [ "$F" -lt "$MIN_FREE_GB" ]; then
      echo "  [disk] ABORT THRESHOLD CROSSED: ${F} GB free, cancelling the build"
      "${PSQL[@]}" -tAc "select pg_cancel_backend(pid) from pg_stat_activity where query like 'create index%hnsw%'" >/dev/null 2>&1
    fi
  done ) &
WATCH=$!
trap "kill $WATCH 2>/dev/null" EXIT

echo "[$(date +%T)] building hnsw (m = ${M}, ef_construction = ${EF_CONSTRUCTION}); watch for the spill NOTICE"
"${PSQL[@]}" <<SQL
set maintenance_work_mem = '${MWM_MB}MB';
\timing on
create index ${SCHEMA}_memories_embedding_hnsw on ${SCHEMA}.memories
  using hnsw (embedding halfvec_cosine_ops) with (m = ${M}, ef_construction = ${EF_CONSTRUCTION});
SQL
STATUS=$?

kill $WATCH 2>/dev/null
if [ $STATUS -ne 0 ]; then
  echo "[$(date +%T)] BUILD FAILED (exit ${STATUS}) -- nothing was dropped, the old index is untouched"
  exit $STATUS
fi

"${PSQL[@]}" -c "select relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = '${SCHEMA}' order by pg_total_relation_size(c.oid) desc;"
echo "[$(date +%T)] free disk after: $(free_gb) GB"
echo "[$(date +%T)] HNSW BUILD COMPLETE -- if no spill NOTICE appeared above, constraint (i) held"
