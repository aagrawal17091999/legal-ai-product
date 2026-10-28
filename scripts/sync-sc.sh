#!/bin/bash
set -euo pipefail

# Daily incremental Supreme Court sync: index judgments upstream added since the
# last run (download -> load -> extract -> embed). The work is in
# pipeline/sync_sc.py; this wrapper is what the systemd timer calls. It owns the
# Python venv and turns a failed run into an alert.
#
# Usage:
#   ENV_FILE=.env.production.local scripts/sync-sc.sh             # normal run
#   ENV_FILE=.env.production.local scripts/sync-sc.sh --dry-run   # what is new?
# Any arguments are passed through to sync_sc.py.
#
# Upstream cadence (measured 2026-10-28): small SCR drops every 1-2 weeks, so a
# daily tick finds nothing most days, and then only downloads a <= 1 MB parquet.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
export ENV_FILE="${ENV_FILE:-.env.production.local}"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file '$ENV_FILE' not found in $APP_DIR. Run this on the box, in /opt/legal-ai-product." >&2
  exit 1
fi

VENV="${PIPELINE_VENV:-$APP_DIR/.venv}"
REQS="$APP_DIR/pipeline/requirements.txt"
STAMP="$VENV/.requirements.sha"
want="$( (sha256sum "$REQS" 2>/dev/null || shasum -a 256 "$REQS") | cut -d' ' -f1)"
if [ ! -x "$VENV/bin/python" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$want" ]; then
  echo "Setting up pipeline venv at $VENV (first run, or requirements changed)."
  echo "Installing packages; this takes a few minutes and prints nothing until it finishes..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$REQS"
  echo "$want" > "$STAMP"
  echo "Venv ready."
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

set +e
PYTHONWARNINGS=ignore "$VENV/bin/python" pipeline/sync_sc.py "$@" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e

if [ "$STATUS" -ne 0 ]; then
  SUMMARY="$(grep '^SYNC_SUMMARY' "$LOG" | tail -1 || true)"
  bash "$APP_DIR/scripts/send-alert.sh" \
    "Supreme Court sync failed (exit $STATUS)" \
    "$(printf '%s\n\nLast output:\n%s' "${SUMMARY:-no summary — the run died early}" "$(tail -40 "$LOG")")" || true
fi
exit "$STATUS"
