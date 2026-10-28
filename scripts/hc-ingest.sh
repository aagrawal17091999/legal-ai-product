#!/bin/bash
set -euo pipefail

# High Court ingestion wrapper: owns the Python venv, checks Tesseract is
# installed, and turns a failed run into an alert. The work is in
# pipeline/ingest_hc.py; the systemd units call this. Runbook:
# pipeline/HC_INGEST.md.
#
# Usage (any arguments are passed through to ingest_hc.py):
#   ENV_FILE=.env.production.local scripts/hc-ingest.sh batch --size 1000
#   ENV_FILE=.env.production.local scripts/hc-ingest.sh sync
#   ENV_FILE=.env.production.local scripts/hc-ingest.sh status

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
export ENV_FILE="${ENV_FILE:-.env.production.local}"

if ! command -v tesseract >/dev/null; then
  echo "tesseract is not installed. As root: apt-get install -y tesseract-ocr tesseract-ocr-{eng,hin,kan,tam,tel,mal,ben,guj,mar,ori,pan,urd,asm,nep}" >&2
  exit 2
fi

VENV="${PIPELINE_VENV:-$APP_DIR/.venv}"
REQS="$APP_DIR/pipeline/requirements.txt"
STAMP="$VENV/.requirements.sha"
want="$( (sha256sum "$REQS" 2>/dev/null || shasum -a 256 "$REQS") | cut -d' ' -f1)"
if [ ! -x "$VENV/bin/python" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$want" ]; then
  echo "Setting up pipeline venv at $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$REQS"
  echo "$want" > "$STAMP"
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

set +e
PYTHONWARNINGS=ignore "$VENV/bin/python" pipeline/ingest_hc.py "$@" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e

if [ "$STATUS" -ne 0 ]; then
  SUMMARY="$(grep '^BATCH_SUMMARY' "$LOG" | tail -1 || true)"
  bash "$APP_DIR/scripts/send-alert.sh" \
    "High Court ingestion '$1' failed (exit $STATUS)" \
    "$(printf '%s\n\nLast output:\n%s' "${SUMMARY:-no summary — the run died early}" "$(tail -40 "$LOG")")" || true
fi
exit "$STATUS"
