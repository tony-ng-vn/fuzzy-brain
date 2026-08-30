#!/bin/zsh
# Cut the scale tier over from IVFFlat to the HNSW index hnsw-build.sh just
# built, then measure the vector lane that results (DESIGN.md 7.1).
#
#   ./scripts/hnsw-cutover.sh bench_r1m
#
# The drop happens BEFORE any measurement, not after. With both indexes on the
# same column and opclass family the planner costs them against each other and
# may pick either, so a sweep run with both present would silently be measuring
# whichever one it chose rather than the one being chosen.
#
# The old DDL is echoed first so the restore path is one paste away; the IVFFlat
# index rebuilds in ~66 s at 1M, which is what makes dropping it cheap enough to
# do rather than work around.
set -u
cd "$(dirname "$0")/.." || exit 1

SCHEMA=${1:?usage: hnsw-cutover.sh <schema>}
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)

# ilike, not like: pg_indexes renders the clause as "USING hnsw", so a
# lowercase pattern matches nothing and the script aborts on a built index.
HAVE_HNSW=$("${PSQL[@]}" -tAc "select count(*) from pg_indexes where schemaname='${SCHEMA}' and indexdef ilike '%using hnsw%'")
if [ "$HAVE_HNSW" -eq 0 ]; then
  echo "ABORT: no HNSW index on ${SCHEMA}.memories -- run hnsw-build.sh first. Nothing dropped."
  exit 1
fi

echo "[$(date +%T)] indexes before:"
"${PSQL[@]}" -tAc "select '  ' || indexname || ' :: ' || indexdef from pg_indexes where schemaname='${SCHEMA}'"

IVF=$("${PSQL[@]}" -tAc "select indexname from pg_indexes where schemaname='${SCHEMA}' and indexdef ilike '%using ivfflat%' limit 1")
if [ -n "$IVF" ]; then
  echo "[$(date +%T)] restore path if this needs undoing:"
  "${PSQL[@]}" -tAc "select '  ' || indexdef || ';' from pg_indexes where schemaname='${SCHEMA}' and indexname='${IVF}'"
  echo "[$(date +%T)] dropping ${IVF} so the planner has exactly one vector index to choose"
  "${PSQL[@]}" -c "drop index ${SCHEMA}.${IVF};"
else
  echo "[$(date +%T)] no IVFFlat index present; nothing to drop"
fi

"${PSQL[@]}" -c "analyze ${SCHEMA}.memories;"
echo "[$(date +%T)] indexes after:"
"${PSQL[@]}" -tAc "select '  ' || indexname from pg_indexes where schemaname='${SCHEMA}'"

# Prove the planner actually reaches for HNSW rather than falling back to a seq
# scan, which is the failure mode that would make every latency number below
# meaningless while still returning correct rows.
#
# The probe vector is pulled out first and inlined as a literal. It cannot be a
# scalar subquery: pgvector cannot order by the index when the ordering
# expression contains one, which is the same un-orderable failure DESIGN.md 6.1
# records for a materialized q CTE. A subquery probe would print Seq Scan on a
# perfectly good index and teach the reader to ignore the check.
PROBE_VEC=$("${PSQL[@]}" -tAc "select embedding from ${SCHEMA}.memories where embedding is not null limit 1")
echo "[$(date +%T)] planner check on the bare vector lane:"
"${PSQL[@]}" -tAc "explain (costs off) select id from ${SCHEMA}.memories
  order by embedding <=> '${PROBE_VEC}'::halfvec limit 30" | sed 's/^/  /'
echo "[$(date +%T)] CUTOVER COMPLETE"
