#!/bin/bash
set -euo pipefail

# Critical-error watchdog.
#
# On 2026-08-17 the Voyage API key was rejected for 96 minutes. `error_logs`
# recorded 81 critical rows the whole time and nobody read them — the outage was
# discovered by a user noticing a hedged answer. This closes that gap: it reads
# the table the app already writes to, and emails when criticals appear.
#
# Runs from a systemd timer. Env (from $ENV_FILE, default .env.production.local):
#   ERROR_ALERT_WINDOW_MIN   look-back window, default 15
#   ERROR_ALERT_THRESHOLD    criticals in window before alerting, default 3
#   ERROR_ALERT_COOLDOWN_MIN silence after an alert, default 60
#
# The cooldown matters: a sustained outage writes an error on every request, and
# an alert per tick would train you to ignore the channel. One alert, then quiet
# until the cooldown lapses or the error signature changes.

APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production.local}"
STATE_FILE="${ERROR_ALERT_STATE:-/var/lib/nyayasearch/error-alert.state}"

read_var() {
  # `|| true`: grep exits 1 on a missing key, which under `set -e` + `pipefail`
  # would kill the watchdog before it checks anything. Absent means empty.
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2- \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//'
}

DB_URL="${DATABASE_URL:-$(read_var DATABASE_URL)}"
if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL not found in $ENV_FILE — cannot check errors" >&2
  exit 1
fi

WINDOW="${ERROR_ALERT_WINDOW_MIN:-$(read_var ERROR_ALERT_WINDOW_MIN)}"; WINDOW="${WINDOW:-15}"
THRESHOLD="${ERROR_ALERT_THRESHOLD:-$(read_var ERROR_ALERT_THRESHOLD)}"; THRESHOLD="${THRESHOLD:-3}"
COOLDOWN="${ERROR_ALERT_COOLDOWN_MIN:-$(read_var ERROR_ALERT_COOLDOWN_MIN)}"; COOLDOWN="${COOLDOWN:-60}"

COUNT="$(psql "$DB_URL" -At -c \
  "select count(*) from error_logs where severity='critical' and created_at > now() - interval '$WINDOW minutes';" 2>/dev/null || echo "")"

if [ -z "$COUNT" ]; then
  echo "could not query error_logs (database unreachable?)" >&2
  exit 1
fi

if [ "$COUNT" -lt "$THRESHOLD" ]; then
  echo "criticals in last ${WINDOW}m: $COUNT (threshold $THRESHOLD) — ok"
  exit 0
fi

# Signature = the distinct error shapes seen. A NEW signature always alerts, even
# inside the cooldown, so a second unrelated failure during an outage isn't
# swallowed by the first one's silence.
SUMMARY="$(psql "$DB_URL" -At -F'|' -c \
  "select category, count(*), left(regexp_replace(message, '[0-9]{2,}', 'N', 'g'), 120)
     from error_logs
    where severity='critical' and created_at > now() - interval '$WINDOW minutes'
    group by category, 3
    order by 2 desc
    limit 10;" 2>/dev/null || echo "")"

SIGNATURE="$(printf '%s' "$SUMMARY" | cut -d'|' -f1,3 | sort -u | md5sum | cut -d' ' -f1)"

mkdir -p "$(dirname "$STATE_FILE")"
NOW="$(date +%s)"
LAST_SIG=""; LAST_TS=0
if [ -f "$STATE_FILE" ]; then
  LAST_SIG="$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null || echo "")"
  LAST_TS="$(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null || echo 0)"
fi
[ -z "$LAST_TS" ] && LAST_TS=0

if [ "$SIGNATURE" = "$LAST_SIG" ] && [ $((NOW - LAST_TS)) -lt $((COOLDOWN * 60)) ]; then
  MINS_LEFT=$(( (COOLDOWN * 60 - (NOW - LAST_TS)) / 60 ))
  echo "criticals: $COUNT — same signature, cooling down (${MINS_LEFT}m left)"
  exit 0
fi

SAMPLE="$(psql "$DB_URL" -At -F' | ' -c \
  "select to_char(created_at,'HH24:MI:SS'), category, left(message, 200)
     from error_logs
    where severity='critical' and created_at > now() - interval '$WINDOW minutes'
    order by id desc limit 5;" 2>/dev/null || echo "")"

BODY="$COUNT critical errors in the last ${WINDOW} minutes on $(hostname).

BY CATEGORY (category | count | message shape):
$SUMMARY

MOST RECENT:
$SAMPLE

Check: https://getlegalbrain.com/admin/errors
Box:   ssh root@$(hostname -I | awk '{print $1}') && pm2 logs nyayasearch"

bash "$(dirname "$0")/send-alert.sh" "$COUNT critical errors in ${WINDOW}m" "$BODY" || true

printf '%s %s\n' "$SIGNATURE" "$NOW" > "$STATE_FILE"
echo "alerted: $COUNT criticals in ${WINDOW}m (signature $SIGNATURE)"
