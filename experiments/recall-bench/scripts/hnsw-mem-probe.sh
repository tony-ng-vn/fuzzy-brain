#!/bin/zsh
# How much memory an HNSW graph over halfvec(256) at m=16 actually needs, per
# million rows -- the constraint that replaced the 90-minute build gate
# (DESIGN.md 7.1 constraint (i)).
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   ./scripts/hnsw-mem-probe.sh
#
# Measured, not inferred from the on-disk index size. pgvector emits
#
#   NOTICE: hnsw graph no longer fits into maintenance_work_mem after N tuples
#
# the moment the in-memory graph outgrows its budget, so a build deliberately
# given a SMALL maintenance_work_mem reports the tuple count that exactly filled
# it. Bytes per tuple is then budget/N, and that extrapolates.
#
# Runs on a small throwaway clone rather than bench_r1m, because a spilled build
# is the slow disk-based path and nobody wants 1M rows of it. The clone carries
# only id and embedding: the graph is built from the vector column alone, so
# nothing else changes the answer.
#
# Single-threaded on purpose. A parallel maintenance build would take 7 of 12
# cores and corrupt any rate window a co-running agent has open on this cluster.
set -u
cd "$(dirname "$0")/.." || exit 1

PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)
SRC=bench_r1m
DST=bench_hnsw_probe
ROWS=${ROWS:-250000}
BUDGET_MB=${BUDGET_MB:-128}

echo "[$(date +%T)] cloning ${ROWS} rows of $SRC -> $DST (id + embedding only)"
"${PSQL[@]}" <<SQL
drop schema if exists $DST cascade;
create schema $DST;
create unlogged table $DST.probe as
  select id, embedding from $SRC.memories where embedding is not null limit $ROWS;
SQL

echo "[$(date +%T)] building HNSW at maintenance_work_mem = ${BUDGET_MB}MB to find the spill point"
"${PSQL[@]}" <<SQL
set maintenance_work_mem = '${BUDGET_MB}MB';
set max_parallel_maintenance_workers = 0;
\timing on
create index probe_hnsw on $DST.probe using hnsw (embedding halfvec_cosine_ops) with (m = 16, ef_construction = 200);
SQL

"${PSQL[@]}" -c "select pg_size_pretty(pg_relation_size('$DST.probe_hnsw')) as index_on_disk, count(*) as rows from $DST.probe;"
echo "[$(date +%T)] dropping the clone; $SRC untouched"
"${PSQL[@]}" -c "drop schema $DST cascade;"
echo "[$(date +%T)] MEM PROBE COMPLETE -- bytes/tuple = ${BUDGET_MB}MB / (tuples in the NOTICE above)"
