#!/bin/bash
set -euo pipefail

# Dump the READ-ONLY case-law reference dataset (judgments + embeddings) into a
# single compressed artifact. This is the expensive-to-build data: 16GB of raw
# judgments processed through the offline OCR/chunk pipeline and embedded with
# Voyage (real $$). It is IDENTICAL across environments, so we build it ONCE and
# restore the same artifact into prod and staging — instead of re-embedding twice.
#
# It deliberately does NOT include per-environment application data (users, chats,
# payments, workspaces, audit/trace). Those must stay isolated per environment.
#
# Usage:
#   ENV_FILE=.env.production.local bash scripts/dump-reference-data.sh            # -> ./reference-data-<ts>.dump
#   ENV_FILE=.env.production.local bash scripts/dump-reference-data.sh --upload   # + push to R2
#
# Restore the produced artifact with scripts/restore-reference-data.sh.

# The reference tables. Keep this list in sync when new courts/reference tables
# are added (see docs/deployment.md). Everything else is per-environment app data.
REFERENCE_TABLES=(
  supreme_court_cases
  high_court_cases
  case_chunks
  case_paragraphs
)

ENV_FILE="${ENV_FILE:-.env.local}"
UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1

read_var() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL="$(read_var DATABASE_URL)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set (looked in ${ENV_FILE})." >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="reference-data-${TS}.dump"

TABLE_ARGS=()
for t in "${REFERENCE_TABLES[@]}"; do TABLE_ARGS+=("-t" "$t"); done

echo "Dumping reference tables (${REFERENCE_TABLES[*]}) -> ${OUT}"
# -Fc = custom compressed format (restorable with pg_restore, table-selectable).
pg_dump "$DATABASE_URL" "${TABLE_ARGS[@]}" -Fc --no-owner --no-privileges -f "$OUT"
echo "Wrote ${OUT} ($(du -h "$OUT" | cut -f1))"

if [ "$UPLOAD" = "1" ]; then
  R2_ENDPOINT="${R2_ENDPOINT:-$(read_var R2_ENDPOINT)}"
  R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(read_var R2_BUCKET_NAME)}"
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(read_var R2_ACCESS_KEY_ID)}"
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(read_var R2_SECRET_ACCESS_KEY)}"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  if [ -z "$R2_ENDPOINT" ] || [ -z "$AWS_ACCESS_KEY_ID" ]; then
    echo "ERROR: --upload needs R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in ${ENV_FILE}." >&2
    exit 1
  fi
  KEY_TS="reference-dumps/${OUT}"
  KEY_LATEST="reference-dumps/reference-data-latest.dump"
  echo "Uploading to R2 bucket '${R2_BUCKET_NAME}' as ${KEY_TS} (+ latest pointer)"
  aws s3 cp "$OUT" "s3://${R2_BUCKET_NAME}/${KEY_TS}"     --endpoint-url "$R2_ENDPOINT"
  aws s3 cp "$OUT" "s3://${R2_BUCKET_NAME}/${KEY_LATEST}" --endpoint-url "$R2_ENDPOINT"
  echo "Uploaded. Restore anywhere with: bash scripts/restore-reference-data.sh --from-r2"
fi
