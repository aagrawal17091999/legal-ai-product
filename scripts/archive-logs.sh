#!/bin/bash
set -euo pipefail

# Archive rotated logs to R2. This is the long-retention half of the logging
# setup: Grafana Cloud's free tier keeps 14 days, and some questions ("when did
# this account first hit the error", "what did we serve during the July
# incident") are asked much later than that. R2 costs ~$0.015/GB-month with the
# first 10GB free and no egress charge, and gzipped JSON logs compress ~10x, so
# a year of this is expected to stay inside the free tier.
#
#   ENV_FILE=.env.production.local bash scripts/archive-logs.sh          # dry run
#   ENV_FILE=.env.production.local bash scripts/archive-logs.sh --upload
#   ENV_FILE=.env.production.local bash scripts/archive-logs.sh --upload --prune
#
# --prune DELETES local files after a verified upload. It is opt-in because the
# box's disk is shared with Postgres: reclaiming space is the point, but doing
# it on an unverified upload would destroy the only copy.
#
# Rotation itself is pm2-logrotate's job, not this script's:
#   pm2 install pm2-logrotate
#   pm2 set pm2-logrotate:compress true
#   pm2 set pm2-logrotate:retain 14
# Without it pm2 writes one ever-growing file that is never rotated, so there is
# nothing here to archive and the disk fills instead.

APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production.local}"
PM2_LOG_DIR="${PM2_LOG_DIR:-/root/.pm2/logs}"
NGINX_LOG_DIR="${NGINX_LOG_DIR:-/var/log/nginx}"

UPLOAD=0
PRUNE=0
for arg in "$@"; do
  case "$arg" in
    --upload) UPLOAD=1 ;;
    --prune)  PRUNE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# See scripts/send-alert.sh — the `|| true` stops a missing optional key from
# killing the script under `set -e` + `pipefail`.
read_var() {
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2- \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

R2_ENDPOINT="${R2_ENDPOINT:-$(read_var R2_ENDPOINT)}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(read_var R2_BUCKET_NAME)}"
AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(read_var R2_ACCESS_KEY_ID)}"
AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(read_var R2_SECRET_ACCESS_KEY)}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

if [ "$UPLOAD" = "1" ]; then
  for v in R2_ENDPOINT R2_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || { echo "ERROR: $v not set (looked in $ENV_FILE)." >&2; exit 1; }
  done
fi

HOST="$(hostname)"
UPLOADED=0
SKIPPED=0
BYTES=0

# Collect ROTATED files only — never the file pm2 or nginx is currently writing
# to. pm2-logrotate names them <app>-out__2026-08-21_00-00-00.log(.gz); nginx
# uses <name>.log.1(.gz). Matching the live *.log would upload a truncated
# snapshot and, with --prune, delete a file the writer still holds open (which
# frees no space until the process restarts anyway).
# Plain while-read rather than `mapfile`: mapfile is bash 4+, which makes the
# script impossible to exercise on a macOS dev machine (bash 3.2) and turns a
# smoke test into "push to the box and hope".
CANDIDATES=()
while IFS= read -r line; do
  [ -n "$line" ] && CANDIDATES+=("$line")
done < <(
  find "$PM2_LOG_DIR" -maxdepth 1 -type f \
       \( -name '*__*.log' -o -name '*__*.log.gz' \) 2>/dev/null || true
  find "$NGINX_LOG_DIR" -maxdepth 1 -type f \
       \( -name '*.log.[0-9]*' -o -name '*.log.*.gz' \) 2>/dev/null || true
)

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "No rotated logs found in $PM2_LOG_DIR or $NGINX_LOG_DIR — nothing to archive."
  echo "(If pm2 has never rotated, run: pm2 install pm2-logrotate)"
  exit 0
fi

echo "Found ${#CANDIDATES[@]} rotated log file(s)."

for f in "${CANDIDATES[@]}"; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  # Partition by the file's own mtime, not today's date: a backlog uploaded
  # after a week of downtime must land under the day it belongs to, otherwise
  # the prefix stops being a usable time index.
  mtime="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"
  day="$(date -u -d "@${mtime}" +%Y/%m/%d 2>/dev/null || date -u -r "${mtime}" +%Y/%m/%d)"

  # Compress anything not already compressed. pm2-logrotate does this when
  # compress=true; nginx's logrotate usually does too.
  tmp=""
  if [[ "$f" == *.gz ]]; then
    src="$f"
  else
    tmp="$(mktemp -t archivelog.XXXXXX)"
    gzip -9 -c "$f" > "$tmp"
    src="$tmp"
    base="${base}.gz"
  fi

  key="logs/${HOST}/${day}/${base}"
  size="$(stat -c %s "$src" 2>/dev/null || stat -f %z "$src")"

  if [ "$UPLOAD" = "1" ]; then
    if aws s3 cp "$src" "s3://${R2_BUCKET_NAME}/${key}" \
         --endpoint-url "$R2_ENDPOINT" --only-show-errors; then
      # Verify the object is actually there before considering the local copy
      # expendable. `cp` exiting 0 is not on its own proof of a durable object.
      if aws s3api head-object --bucket "$R2_BUCKET_NAME" --key "$key" \
           --endpoint-url "$R2_ENDPOINT" >/dev/null 2>&1; then
        UPLOADED=$((UPLOADED + 1))
        BYTES=$((BYTES + size))
        [ "$PRUNE" = "1" ] && rm -f "$f"
      else
        echo "WARNING: upload reported success but HEAD failed for $key — keeping $f" >&2
        SKIPPED=$((SKIPPED + 1))
      fi
    else
      echo "WARNING: upload failed for $f — keeping it locally" >&2
      SKIPPED=$((SKIPPED + 1))
    fi
  else
    echo "  would upload $f -> s3://${R2_BUCKET_NAME}/${key} ($(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B"))"
  fi

  [ -n "$tmp" ] && rm -f "$tmp"
done

if [ "$UPLOAD" = "1" ]; then
  echo "Archived ${UPLOADED} file(s), $(numfmt --to=iec "$BYTES" 2>/dev/null || echo "${BYTES}B") compressed. ${SKIPPED} skipped."
  [ "$PRUNE" = "1" ] && echo "Local copies of archived files removed."
  # A silent archive failure is the kind you discover when you need the data, so
  # surface repeated failures through the same channel as the other watchdogs.
  if [ "$SKIPPED" -gt 0 ] && [ -x "$APP_DIR/scripts/send-alert.sh" ]; then
    bash "$APP_DIR/scripts/send-alert.sh" \
      "Log archive: ${SKIPPED} file(s) failed to upload" \
      "archive-logs.sh on ${HOST} could not upload ${SKIPPED} of $((UPLOADED + SKIPPED)) rotated log files to R2. They are still on local disk. Check R2 credentials and disk space." || true
  fi
else
  echo "Dry run — nothing uploaded. Re-run with --upload (and --prune to reclaim disk)."
fi
