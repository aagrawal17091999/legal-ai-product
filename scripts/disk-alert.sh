#!/bin/bash
set -euo pipefail

# Disk-space watchdog for the single box. On a co-located app+DB server a full
# disk is the classic total outage: Postgres stops accepting writes AND the app
# can't log or serve — both die together. This warns BEFORE that happens.
#
# Runs from a systemd timer every 15 min. If usage crosses the threshold it POSTs
# to ALERT_WEBHOOK_URL (Slack/Discord-style incoming webhook) when set; otherwise
# it prints to stderr, which journald/systemd captures.
#
# Env:
#   DISK_ALERT_PCT     integer threshold, default 80
#   DISK_ALERT_PATH    filesystem to check, default / (holds /opt + PG data)
#   ALERT_WEBHOOK_URL  optional incoming-webhook URL

ENV_FILE="${ENV_FILE:-.env.local}"
read_var() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

THRESHOLD="${DISK_ALERT_PCT:-80}"
TARGET="${DISK_ALERT_PATH:-/}"
WEBHOOK="${ALERT_WEBHOOK_URL:-$(read_var ALERT_WEBHOOK_URL)}"

USED_PCT="$(df -P "$TARGET" | awk 'NR==2 {gsub("%","",$5); print $5}')"
AVAIL="$(df -Ph "$TARGET" | awk 'NR==2 {print $4}')"

if [ "$USED_PCT" -ge "$THRESHOLD" ]; then
  MSG="⚠️ Disk on $(hostname) at ${USED_PCT}% (${AVAIL} free) on ${TARGET} — over ${THRESHOLD}%. Postgres + app share this disk; act before it fills."
  if [ -n "${WEBHOOK:-}" ]; then
    curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
      -d "$(printf '{"text":"%s"}' "$MSG")" "$WEBHOOK" >/dev/null || echo "alert webhook failed: $MSG" >&2
  else
    echo "$MSG" >&2
  fi
  exit 0
fi

echo "disk ${USED_PCT}% (${AVAIL} free) on ${TARGET} — ok"
