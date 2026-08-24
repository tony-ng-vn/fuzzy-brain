#!/bin/zsh
# The owed measurement (DESIGN.md rung 3 gate 2): what IVFFlat costs in recall
# against HNSW at 50K, since the projected 10M HNSW build blew the 90-minute
# gate and the scale tier now runs IVFFlat.
#
#   cd /Users/minhthiennguyen/Desktop/fuzzy-brain/experiments/recall-bench
#   nohup ./scripts/ivf-vs-hnsw.sh > .out/quality50k/ivf-vs-hnsw.log 2>&1 &
#
# It never touches bench_q50k. A tuning agent owns that schema and its HNSW
# index, and dropping an index under a running tuning loop would corrupt their
# measurement and mine. Instead the 50K table is cloned once into
# bench_q50k_ivf and BOTH arms run there, so the only difference between the
# two numbers is which vector index exists -- not the schema, not the row
# order, not the planner's statistics.
#
# Only naive and fixedRrf are run. The tuned profile is fitted against this
# corpus and would confound an index comparison with a weighting comparison;
# the design asks for the index delta specifically.
set -u
cd "$(dirname "$0")/.." || exit 1

PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)
SRC=bench_q50k
DST=bench_q50k_ivf
OUT=.out/quality50k
SPLIT=${SPLIT:-test}
# sqrt(50_000) and the quality tier's configured probes, matching what
# load.mjs would build and what config.lanes.quality pins.
LISTS=224

echo "[$(date +%T)] cloning $SRC -> $DST (leaves $SRC untouched)"
"${PSQL[@]}" <<SQL
drop schema if exists $DST cascade;
create schema $DST;
create table $DST.memories (like $SRC.memories including defaults including constraints including generated);
-- Columns listed explicitly: fts is GENERATED ALWAYS and cannot be inserted
-- into, so a plain "select *" would fail. It recomputes from body on insert,
-- which is what makes the clone a faithful copy rather than a snapshot.
insert into $DST.memories
  (id, kind, title, body, raw, people, places, tags, occurred_at, cluster_id, dup_group, rare_token, embedding)
select id, kind, title, body, raw, people, places, tags, occurred_at, cluster_id, dup_group, rare_token, embedding
from $SRC.memories;
create index on $DST.memories using gin (fts);
alter table $DST.memories add primary key (id);
analyze $DST.memories;
SQL

run_arm() {
  local arm=$1
  echo "[$(date +%T)] === $arm ==="
  for profile in naive fixedRrf; do
    BENCH_CONFIG_OVERRIDE="{\"tiers\":{\"quality50k\":{\"schema\":\"$DST\"}}}" \
      node bench-recall.mjs --tier quality50k --profile "$profile" --split "$SPLIT" \
        --out "$OUT/ivfhnsw-$arm-$profile.json" > "$OUT/ivfhnsw-$arm-$profile.log" 2>&1
    local r10=$(grep -E '^recall@10 ' "$OUT/ivfhnsw-$arm-$profile.log" | head -1 | awk '{print $2}')
    local r1=$(grep -E '^recall@1 ' "$OUT/ivfhnsw-$arm-$profile.log" | head -1 | awk '{print $2}')
    local n=$(grep -E '^n ' "$OUT/ivfhnsw-$arm-$profile.log" | head -1 | awk '{print $2}')
    echo "  $arm $profile: n=$n recall@1=$r1 recall@10=$r10"
  done
}

echo "[$(date +%T)] building HNSW (m=16, ef_construction=200)"
"${PSQL[@]}" -c "\timing on" \
  -c "create index memories_embedding_hnsw on $DST.memories using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 200);"
run_arm hnsw

echo "[$(date +%T)] swapping HNSW out for IVFFlat (lists = $LISTS)"
"${PSQL[@]}" -c "\timing on" \
  -c "drop index $DST.memories_embedding_hnsw;" \
  -c "create index memories_embedding_ivfflat on $DST.memories using ivfflat (embedding vector_cosine_ops) with (lists = $LISTS);"
run_arm ivfflat

echo "[$(date +%T)] dropping the clone; $SRC was never modified"
"${PSQL[@]}" -c "drop schema $DST cascade;"
echo "[$(date +%T)] IVF-VS-HNSW COMPLETE"
