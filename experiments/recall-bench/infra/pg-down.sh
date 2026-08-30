#!/usr/bin/env bash
# Stop the disposable recall-bench cluster and delete its data directory
# (DESIGN.md section 2). Destructive SQL and destructive filesystem ops are
# fine here and only here: recallbench is created, filled, measured, and
# thrown away (section 0).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PGDATA="$BENCH_DIR/.data/pgdata"

PGHOST="127.0.0.1"
PGPORT="55433"
PGUSER="bench"
PGDB="recallbench"

KEEP_DATA=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-data)
      KEEP_DATA=1
      shift
      ;;
    *)
      echo "pg-down.sh: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

echo "target: postgres://${PGUSER}@${PGHOST}:${PGPORT}/${PGDB}"

if [[ -d "$PGDATA" ]]; then
  if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    echo "pg-down.sh: stopping cluster"
    "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast
  else
    echo "pg-down.sh: cluster already stopped"
  fi
else
  echo "pg-down.sh: no data directory at $PGDATA; nothing to stop"
fi

if [[ "$KEEP_DATA" -eq 1 ]]; then
  echo "pg-down.sh: --keep-data, leaving $PGDATA in place"
  exit 0
fi

# Guard the deletion: refuse on an empty variable, and refuse on any path
# that does not unambiguously resolve to this bench's own throwaway data
# directory, so a bad variable expansion never turns into `rm -rf` of
# something else.
if [[ -z "$PGDATA" ]]; then
  echo "abort: PGDATA resolved empty, refusing to delete anything" >&2
  exit 1
fi
case "$PGDATA" in
  */experiments/recall-bench/.data/pgdata) ;;
  *)
    echo "abort: refusing to delete unexpected path: $PGDATA" >&2
    exit 1
    ;;
esac

if [[ -d "$PGDATA" ]]; then
  echo "pg-down.sh: deleting $PGDATA"
  rm -rf "$PGDATA"
fi

echo "pg-down.sh: done"
