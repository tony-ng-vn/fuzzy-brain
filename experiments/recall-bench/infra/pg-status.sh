#!/usr/bin/env bash
# Report whether the disposable recall-bench cluster is up, reachable, and
# which tier schemas it currently holds. Read-only: never modifies the
# cluster. Not part of DESIGN.md's own CLI list (section 3.7 names only
# pg-up.sh, pg-down.sh, psql.sh) -- an operational convenience alongside them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PGDATA="$BENCH_DIR/.data/pgdata"

PGHOST="127.0.0.1"
PGPORT="55433"
PGUSER="bench"
PGDB="recallbench"

echo "target: postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDB}"

if [[ ! -d "$PGDATA" ]]; then
  echo "cluster: not initialized (no data directory at $PGDATA)"
  exit 1
fi

if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  echo "cluster: running"
else
  echo "cluster: stopped"
  exit 1
fi

if "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; then
  echo "database: reachable"
else
  echo "database: cluster is up but $PGDB is not reachable yet"
  exit 1
fi

DATA_SIZE="$(du -sh "$PGDATA" 2>/dev/null | awk '{print $1}')"
echo "data directory: $PGDATA (${DATA_SIZE})"

SCHEMAS="$("$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -tAc \
  "select nspname from pg_namespace where nspname like 'bench\_%' order by nspname")"
if [[ -z "$SCHEMAS" ]]; then
  echo "tier schemas: none loaded yet"
else
  echo "tier schemas:"
  echo "$SCHEMAS" | sed 's/^/  /'
fi
