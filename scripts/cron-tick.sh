#!/bin/bash
set -euo pipefail

# Fire an internal cron endpoint from the box's own scheduler.
#
# On Hetzner there is NO Vercel cron runner, so the schedules declared in
# vercel.json never execute. This wrapper is what a systemd timer (or crontab)
# calls to hit a /api/cron/* endpoint locally with the CRON_SECRET the route
# expects — reproducing what Vercel's cron would have done.
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
curl -fsS --max-time 600 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${BASE}${PATH_ARG}"
echo   # newline after the JSON body in logs
