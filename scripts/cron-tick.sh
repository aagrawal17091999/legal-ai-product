#!/bin/bash
set -euo pipefail

# Fire an internal cron endpoint from the box's own scheduler.
#
# This wrapper is what a systemd timer calls to hit a /api/cron/* endpoint
# locally with the CRON_SECRET the route expects. Every scheduled job on the box
# goes through it; see deploy/systemd/ for the units.
#
# Usage:
#   ENV_FILE=.env.production.local scripts/cron-tick.sh /api/cron/rag-retention
#
# Env:
#   ENV_FILE           dotenv to read CRON_SECRET from (default .env.local)
#   CRON_TARGET_BASE   base URL of the local app (default http://127.0.0.1:3000)

ENV_FILE="${ENV_FILE:-.env.local}"
BASE="${CRON_TARGET_BASE:-http://127.0.0.1:3000}"
PATH_ARG="${1:?usage: cron-tick.sh /api/cron/<name>}"

read_var() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

CRON_SECRET="${CRON_SECRET:-$(read_var CRON_SECRET)}"
if [ -z "${CRON_SECRET:-}" ]; then
  echo "ERROR: CRON_SECRET not set (looked in ${ENV_FILE})." >&2
  exit 1
fi

# -f fails the command on HTTP >=400 so systemd records the run as failed and
# `systemctl status` / journald surface it. --max-time guards a hung request.
#
# MAX_TIME must stay ABOVE the endpoint's own budget and below anything that
# would look like a hang. The batch worker drains waves up to
# BATCH_WORKER_BUDGET_MS (~210s) and now enforces that bound mid-wave, so a
# healthy tick returns well inside 300s. This used to be 600s, and when a wave
# ran unbounded curl hit it and killed the request with "0 bytes received" —
# losing the in-flight work and stalling the queue for a full ten minutes.
MAX_TIME="${CRON_MAX_TIME:-300}"

curl -fsS --max-time "${MAX_TIME}" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${BASE}${PATH_ARG}"
echo   # newline after the JSON body in logs
