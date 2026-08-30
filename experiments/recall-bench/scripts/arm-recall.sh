#!/bin/zsh
# Whole-pipeline recall for one build-strategy arm, on the same instrument the
# 1M frontier was measured with (DESIGN.md 7.4).
#
#   ./scripts/arm-recall.sh bench_bs_bulk1m bulk
#
# The question this answers is the one that decides whether the incremental
# build strategy is usable at all: an HNSW graph grown one insert at a time is
# not the same graph a bulk build produces, and pgvector makes no promise that
# it retrieves as well. So every arm is swept at the tier's pinned ef_search 48
# against the identical query pool, and a difference is a finding to report with
# numbers rather than a detail to leave out.
#
# The arm's rows were copied from bench_r1m, so its term statistics are
# bench_r1m's exactly -- cloned rather than rebuilt, both because it is a second
# of work instead of a minute and because rebuilding them would put a second
# variable inside a recall comparison.
set -u
cd "$(dirname "$0")/.." || exit 1

SCHEMA=${1:?usage: arm-recall.sh <schema> <label>}
LABEL=${2:?usage: arm-recall.sh <schema> <label>}
EF=${EF:-48}
DUR=${DUR:-40}
WARM=${WARM:-10}
OUT=.out/build-strategy
PSQL=(/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 55433 -U bench -d recallbench -v ON_ERROR_STOP=1)

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery -- a single-stream p50 is not trustworthy here."; exit 1; }

echo "[$(date +%T)] cloning bench_r1m term statistics into ${SCHEMA}"
"${PSQL[@]}" <<SQL || exit 1
drop table if exists ${SCHEMA}.lexeme_stats;
drop table if exists ${SCHEMA}.term_stats;
create table ${SCHEMA}.lexeme_stats as select * from bench_r1m.lexeme_stats;
create table ${SCHEMA}.term_stats   as select * from bench_r1m.term_stats;
alter table ${SCHEMA}.lexeme_stats add primary key (lexeme);
alter table ${SCHEMA}.term_stats   add primary key (term);
create index ${SCHEMA}_term_stats_trgm on ${SCHEMA}.term_stats using gin (term gin_trgm_ops);
analyze ${SCHEMA}.lexeme_stats;
analyze ${SCHEMA}.term_stats;
SQL

echo "[$(date +%T)] whole-pipeline recall at hnsw.ef_search ${EF}, single stream, full pass over the query pool"
BENCH_CONFIG_OVERRIDE="{\"tiers\":{\"rehearsal1m\":{\"schema\":\"${SCHEMA}\"}},\"lanes\":{\"scale\":{\"efSearch\":${EF}}}}" \
  node bench-load.mjs --tier rehearsal1m --profile tunedScale --mode closed \
    --sweep 1 --sweep-duration "$DUR" --sweep-warmup "$WARM" \
    --skip-select1-probe --recall-sample-rate 1.0 \
    --out "$OUT/recall-$LABEL.json" 2>&1 | grep -vE '^(target|schema size|query pool|report written)'

node -e '
const r = require(process.argv[1]).closedSweep[0];
const rec = r.recall;
console.log(`  ${process.argv[2]}: R@10 mix ${rec.mixWeighted.recallAt10.toFixed(4)}  R@10 unweighted ${rec.unweighted.recallAt10.toFixed(4)}`
  + `  R@1 mix ${rec.mixWeighted.recallAt1.toFixed(4)}  probes ${rec.probes}  p50 ${r.latencyMs.p50.toFixed(2)}ms  qps ${r.qpsCompleted.toFixed(0)}`
  + `  window ${r.window.valid ? "valid" : "INVALID: " + r.window.reason}`);
for (const [f, v] of Object.entries(rec.families)) console.log(`    ${f.padEnd(18)} n=${String(v.n).padStart(5)}  R@10 ${v.recallAt10.toFixed(4)}`);
' "$PWD/$OUT/recall-$LABEL.json" "$LABEL"
