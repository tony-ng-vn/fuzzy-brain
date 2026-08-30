#!/bin/zsh
# Claim B, measured end to end on one tier, with every guard section 8 asks for.
#
#   TIER=full10m nohup ./scripts/claim-b.sh > .out/full10m/claim-b.log 2>&1 &
#
# Four instruments in the order that makes the result readable:
#
#   0. the SELECT 1 client ceiling (section 8.1). If the trivial-query ceiling
#      is not far above the offered rate, every number after it is a
#      measurement of the client rather than the server.
#   1. the sequential per-family cost profile, one connection, no load
#      generator -- the core-ms figure the gap statement in step 6 divides by.
#   2. the plan-node profile, so a cost that moved between tiers can be
#      attributed to a plan shape rather than guessed at.
#   3. full-validation: the closed-loop ceiling sweep, then open-loop bracketed
#      from BELOW upward, 60 s warmup + 120 s measured, every window carrying
#      its own validity verdict, contention sample, and whole-pipeline recall.
#
# Bracketing from below is deliberate. DESIGN.md 7.4's first pass started at
# 1,400 offered and therefore never established where the gate stops passing;
# an INVALID window supports no conclusion in either direction, so a run that
# only produces invalid windows above the knee has not found the knee.
set -u
cd "$(dirname "$0")/.." || exit 1

TIER=${TIER:-rehearsal1m}
OUT=${OUT:-.out/$TIER}
CONC=${CONC:-8,16,32,64}
RATES=${RATES:-"800 1200 1600 2000 2400"}
TAG=${TAG:-claimb}
mkdir -p "$OUT"

on_ac() { pmset -g batt | head -1 | grep -q 'AC Power'; }
on_ac || { echo "ABORT: on battery. No rate window here is trustworthy."; exit 1; }

echo "[$(date +%T)] ============ step 0: SELECT 1 client ceiling ============"
node bench-load.mjs --tier "$TIER" --mode select1 --offered-qps 2400 \
  --out "$OUT/$TAG-select1.json" 2>&1 | grep -E "select1 ceiling|target:"

echo ""
echo "[$(date +%T)] ============ step 1: sequential per-family cost profile ============"
TIER=$TIER node scripts/family-profile.mjs 2>&1 | tee "$OUT/$TAG-family-profile.log"

echo ""
echo "[$(date +%T)] ============ step 2: plan-node profile at the pinned ef_search ============"
TIER=$TIER N=${EXPLAIN_N:-8} node scripts/explain-scale.mjs 2>&1 | tee "$OUT/$TAG-explain.log"

echo ""
echo "[$(date +%T)] ============ step 3: closed-loop ceiling, then open-loop from below ============"
TIER=$TIER OUT=$OUT CONC=$CONC RATES=$RATES TAG=$TAG ./scripts/full-validation.sh

echo ""
echo "[$(date +%T)] CLAIM B MEASUREMENT COMPLETE -- a window marked CONTENDED or INVALID is not a result"
