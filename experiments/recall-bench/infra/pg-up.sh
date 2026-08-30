#!/usr/bin/env bash
# Create the disposable recall-bench Postgres cluster, verify prerequisites,
# and apply tuning (DESIGN.md section 2). Native Postgres, not Docker: the
# section 12 addendum supersedes every Docker reference in the earlier
# sections of DESIGN.md, since Docker Desktop does not start on this machine.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
DATA_DIR="$BENCH_DIR/.data"
PGDATA="$DATA_DIR/pgdata"
PGLOG="$DATA_DIR/postgres.log"
BENCH_CONF="$SCRIPT_DIR/postgresql.bench.conf"

PGHOST="127.0.0.1"
PGPORT="55433"
PGUSER="bench"
PGDB="recallbench"

TIER="quality50k"
RECREATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier)
      TIER="$2"
      shift 2
      ;;
    --recreate)
      RECREATE=1
      shift
      ;;
    *)
      echo "pg-up.sh: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Every script prints the resolved connection target and the tier schema on
# line one, so a wrong target is visible before anything runs (section 3.7).
echo "target: postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDB} (tier=${TIER})"

psql_bench() {
  "$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1 "$@"
}

# --- Rung 0: prerequisites (DESIGN.md section 7, native-Postgres form per
# section 12: no Docker daemon check, no Docker VM memory check). A failed
# gate aborts the script; it does not get waived (section 7 preamble).

FREE_KB=$(df -Pk "$BENCH_DIR" | awk 'NR==2 {print $4}')
FREE_GB=$(( FREE_KB / 1024 / 1024 ))
if [[ "$FREE_GB" -lt 40 ]]; then
  echo "abort: only ${FREE_GB} GB free on the volume backing $BENCH_DIR, need >= 40 GB" >&2
  exit 1
fi

if [[ "$RECREATE" -eq 1 && -d "$PGDATA" ]]; then
  echo "pg-up.sh: --recreate, stopping any running cluster and removing $PGDATA"
  "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
fi

mkdir -p "$DATA_DIR"

if [[ ! -d "$PGDATA" ]]; then
  echo "pg-up.sh: initializing cluster at $PGDATA"
  # Trust auth, loopback-only publication below: this cluster only ever
  # listens on 127.0.0.1:55433 and holds nothing but throwaway synthetic
  # data (section 0), so there is nothing password auth would protect here.
  "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER" --auth=trust --no-locale -E UTF8 >/dev/null

  # Apply bench tuning once, at init time, before the first start -- several
  # of these GUCs (shared_buffers, max_connections) need a restart to take
  # effect, so folding them in after the cluster is already up would be a lie.
  {
    echo ""
    echo "# --- infra/postgresql.bench.conf ---"
    cat "$BENCH_CONF"
  } >> "$PGDATA/postgresql.conf"
fi

if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "pg-up.sh: cluster already running"
else
  echo "pg-up.sh: starting cluster on port $PGPORT"
  # Socket paths under the repo exceed the 103-byte macOS limit (section 12),
  # so the socket directory is /tmp and every connection in this harness goes
  # over TCP instead.
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGLOG" \
    -o "-p $PGPORT -c unix_socket_directories=/tmp -c listen_addresses=$PGHOST" \
    start >/dev/null
fi

echo "pg-up.sh: waiting for the cluster to accept connections"
for _ in $(seq 1 30); do
  if "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres >/dev/null 2>&1; then
  echo "abort: cluster did not become ready within 30s; see $PGLOG" >&2
  exit 1
fi

if ! psql_bench -d postgres -tAc "select 1 from pg_database where datname = '${PGDB}'" | grep -q 1; then
  echo "pg-up.sh: creating database $PGDB"
  "$PGBIN/createdb" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDB"
fi

# Extensions present: vector, pg_trgm. Gate, not assumption (section 7) --
# these could not be verified while DESIGN.md was written.
#
# halfvec gate is two-part, not one: the type existing is not the same claim
# as the type accepting an HNSW (and IVFFlat) index with its cosine opclass,
# so this actually builds a throwaway index of each kind rather than just
# checking pg_type. Fallback on failure: vector(256), section 9.
GATE_SQL="
create extension if not exists vector;
create extension if not exists pg_trgm;
create temp table _bench_halfvec_gate (v halfvec(3));
create index on _bench_halfvec_gate using hnsw (v halfvec_cosine_ops);
create index on _bench_halfvec_gate using ivfflat (v halfvec_cosine_ops) with (lists = 1);
drop table _bench_halfvec_gate;
"
if ! psql_bench -d "$PGDB" -c "$GATE_SQL" >/dev/null; then
  cat >&2 <<'EOF'
abort: prerequisite gate failed (extensions vector/pg_trgm, or halfvec with
HNSW/IVFFlat halfvec_cosine_ops). Fallback per DESIGN.md section 9: switch
the synthetic-vector tiers to vector(256) in infra/schema.sql and re-run the
disk budget in section 3.5 (10M total goes from ~17.7 GB to ~23 GB) before
proceeding to the 1M rehearsal rung.
EOF
  exit 1
fi

echo "pg-up.sh: ready"
