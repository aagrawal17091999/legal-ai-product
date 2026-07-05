#!/bin/bash
set -euo pipefail

# Nightly logical backup of the IRREPLACEABLE application data — users, chats,
# workspaces, payments/credits, audit. This is the data that, if lost, cannot be
# regenerated (unlike the case-law reference tables, which are rebuildable from
# the R2 reference dump). So the nightly backup deliberately EXCLUDES the ~12GB
# reference tables: it stays small (a few MB → seconds), cheap to keep many of,
# and fast to restore.
#
# This is the daily safety net. For minute-level point-in-time recovery, pair it
# with WAL archiving (wal-g) — see deploy/postgres/tuning.conf + walg.env.example.
#
# Usage:
#   ENV_FILE=.env.production.local bash scripts/backup-app-data.sh           # -> local dump
#   ENV_FILE=.env.production.local bash scripts/backup-app-data.sh --upload  # + encrypt + push to R2
#
# Encryption: if BACKUP_ENC_PASSPHRASE is set (env or ENV_FILE), the artifact is
# encrypted with openssl AES-256 before leaving the box. Strongly recommended —
# this dump contains personal + payment data.

# Reference tables whose DATA is excluded (schema is still captured so the dump
# restores standalone). Keep in sync with scripts/dump-reference-data.sh.
EXCLUDE_DATA=(supreme_court_cases high_court_cases case_chunks case_paragraphs)

ENV_FILE="${ENV_FILE:-.env.local}"
UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1
read_var() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then DATABASE_URL="$(read_var DATABASE_URL)"; fi
if [ -z "${DATABASE_URL:-}" ]; then echo "ERROR: DATABASE_URL not set (looked in ${ENV_FILE})." >&2; exit 1; fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="app-data-${TS}.dump"

EXCL_ARGS=()
for t in "${EXCLUDE_DATA[@]}"; do EXCL_ARGS+=("--exclude-table-data=$t"); done

echo "Backing up application data (excluding reference table data) -> ${OUT}"
pg_dump "$DATABASE_URL" -Fc --no-owner --no-privileges "${EXCL_ARGS[@]}" -f "$OUT"
echo "Wrote ${OUT} ($(du -h "$OUT" | cut -f1))"

UPFILE="$OUT"
PASS="${BACKUP_ENC_PASSPHRASE:-$(read_var BACKUP_ENC_PASSPHRASE)}"
if [ -n "${PASS:-}" ]; then
  echo "Encrypting (AES-256)..."
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$OUT" -out "${OUT}.enc" -pass pass:"$PASS"
  rm -f "$OUT"
  UPFILE="${OUT}.enc"
elif [ "$UPLOAD" = "1" ]; then
  echo "WARNING: BACKUP_ENC_PASSPHRASE not set — uploading UNENCRYPTED personal/payment data." >&2
fi

if [ "$UPLOAD" = "1" ]; then
  R2_ENDPOINT="${R2_ENDPOINT:-$(read_var R2_ENDPOINT)}"
  R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(read_var R2_BUCKET_NAME)}"
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(read_var R2_ACCESS_KEY_ID)}"
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(read_var R2_SECRET_ACCESS_KEY)}"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  # Partition by month so an R2 lifecycle rule can expire old backups server-side.
  KEY="app-backups/$(date +%Y/%m)/${UPFILE}"
  echo "Uploading to R2: ${KEY}"
  aws s3 cp "$UPFILE" "s3://${R2_BUCKET_NAME}/${KEY}" --endpoint-url "$R2_ENDPOINT"
  rm -f "$UPFILE"
  echo "Uploaded. (Set an R2 lifecycle rule on app-backups/ for retention, and TEST a restore.)"
fi
