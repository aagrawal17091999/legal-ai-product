#!/bin/bash
set -euo pipefail

# Restore the case-law reference dataset (built once by dump-reference-data.sh)
# into a target environment's database. This is how staging/dev gets the SAME
# judgments + embeddings as production without re-running the expensive Voyage
# embedding pipeline.
#
# It replaces ONLY the reference tables in the target (--clean drops+recreates
# them); it never touches per-environment app data (users, chats, payments...).
#
# Usage:
#   # into staging DB from a local artifact:
#   ENV_FILE=.env.staging.local bash scripts/restore-reference-data.sh reference-data-20260629-101500.dump
#   # into staging DB, pulling the latest artifact from R2:
#   ENV_FILE=.env.staging.local bash scripts/restore-reference-data.sh --from-r2
#   # skip the confirmation prompt (CI):
#   ENV_FILE=.env.staging.local YES=1 bash scripts/restore-reference-data.sh --from-r2

ENV_FILE="${ENV_FILE:-.env.local}"
read_var() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL="$(read_var DATABASE_URL)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set (looked in ${ENV_FILE})." >&2
  exit 1
fi

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "ERROR: pass a dump file path, or --from-r2 to pull the latest artifact." >&2
  exit 1
fi

CLEANUP=""
if [ "$SRC" = "--from-r2" ]; then
  R2_ENDPOINT="${R2_ENDPOINT:-$(read_var R2_ENDPOINT)}"
  R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(read_var R2_BUCKET_NAME)}"
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(read_var R2_ACCESS_KEY_ID)}"
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(read_var R2_SECRET_ACCESS_KEY)}"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  SRC="reference-data-latest.dump"
  CLEANUP="$SRC"
  echo "Downloading latest reference dump from R2..."
  aws s3 cp "s3://${R2_BUCKET_NAME}/reference-dumps/reference-data-latest.dump" "$SRC" \
    --endpoint-url "$R2_ENDPOINT"
fi

if [ ! -f "$SRC" ]; then
  echo "ERROR: dump file '$SRC' not found." >&2
  exit 1
fi

# Show which database we are about to overwrite (host+db only, never the password).
SAFE_TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#')"
echo "About to RESTORE reference tables from '${SRC}' into:"
echo "    ${SAFE_TARGET}"
echo "This drops & recreates: supreme_court_cases, high_court_cases, case_chunks, case_paragraphs."
echo "App data (users/chats/payments/workspaces) is NOT touched."
if [ "${YES:-0}" != "1" ]; then
  read -r -p "Type the target database name to confirm: " CONFIRM
  DBNAME="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
  if [ "$CONFIRM" != "$DBNAME" ]; then
    echo "Confirmation '${CONFIRM}' != '${DBNAME}'. Aborting." >&2
    exit 1
  fi
fi

echo "Restoring... (this can take a while for case_chunks + HNSW indexes)"
# --clean --if-exists drops the target reference tables first; --no-owner keeps it
# portable across the prod/staging roles. Single transaction so a failure rolls back.
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction \
  -d "$DATABASE_URL" "$SRC"

[ -n "$CLEANUP" ] && rm -f "$CLEANUP"
echo "Reference data restored into ${SAFE_TARGET}."
