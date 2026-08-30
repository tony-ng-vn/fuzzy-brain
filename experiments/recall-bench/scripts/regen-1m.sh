#!/bin/zsh
# Rebuild bench_r1m's vector lane at the recalibrated geometry (DESIGN.md 7.3).
#
#   ./scripts/regen-1m.sh 2>&1 | tee .out/rehearsal1m/regen.log
#
# Re-embed, not regenerate. The corpus TEXT stays exactly as loaded and every
# query file survives; only the embedding column moves, because only the
# geometry moved. scripts/reembed-synthetic.mjs's header carries the full
# reasoning, including the measurement that rules out `load.mjs --stream`
# (config.corpus has drifted since this tier was loaded, so a regenerated
# corpus would strand all 4,000 queries against targets that no longer contain
# what they ask for).
#
# The vector index and the lexical ones go with the swapped-out table and are
# rebuilt here: every vector in the old HNSW graph moved, so it could not have
# been kept in any case.
set -u
cd "$(dirname "$0")/.." || exit 1

SCHEMA=bench_r1m
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)
MIN_FREE_GB=10

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
free_gb() { df -g /System/Volumes/Data | awk 'NR==2 {print $4}'; }

on_ac || { echo "ABORT: on battery. A build timed on battery times the power manager."; exit 1; }

FREE=$(free_gb)
if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
  echo "ABORT: only ${FREE} GB free on the data volume, under the ${MIN_FREE_GB} GB floor."
  exit 1
fi

# A co-running measurement on this cluster loses cores to the COPY and the
# index build, which is a real error on someone else's numbers, not noise.
waited=0
while pgrep -f 'bench-recall.mjs' > /dev/null 2>&1; do
  [ $((waited % 60)) -eq 0 ] && echo "[$(date +%T)] tuning agent busy on bench_q50k, waiting (${waited}s)"
  sleep 15
  waited=$((waited + 15))
done

echo "[$(date +%T)] free disk before: ${FREE} GB"

echo "[$(date +%T)] === re-embedding at the recalibrated geometry ==="
node scripts/reembed-synthetic.mjs --tier rehearsal1m || exit 1

# Heredoc, not -c: psql's -c takes ONE command, and "\timing on" followed by
# SQL on the next line makes the whole thing a single meta-command line whose
# SQL is discarded as "extra arguments". That silently skipped both indexes.
echo "[$(date +%T)] === lexical indexes, and the primary key's name after the swap ==="
"${PSQL[@]}" <<SQL || exit 1
\timing on
alter index ${SCHEMA}.memories_regen_pkey rename to memories_pkey;
create index memories_fts_gin on ${SCHEMA}.memories using gin (fts);
create index memories_person_occurred_at_btree on ${SCHEMA}.memories (person_id, occurred_at);
SQL

echo "[$(date +%T)] === HNSW, guarded (spill watch, disk watch, progress) ==="
./scripts/hnsw-build.sh "${SCHEMA}" || exit 1

# load.mjs never analyzes and every scale-path plan choice in 6.7 depends on
# statistics existing; the sibling scripts all analyze by hand for this reason.
echo "[$(date +%T)] === analyze ==="
"${PSQL[@]}" -c "analyze ${SCHEMA}.memories;" || exit 1

"${PSQL[@]}" -c "select relname, pg_size_pretty(pg_total_relation_size(c.oid)) as size
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = '${SCHEMA}' and c.relkind in ('r','i')
  order by pg_total_relation_size(c.oid) desc;"
echo "[$(date +%T)] free disk after: $(free_gb) GB"
echo "[$(date +%T)] REGEN COMPLETE"
