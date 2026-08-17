#!/bin/bash
set -euo pipefail

# Shared alert sender for the box's watchdogs (error-rate, search canary, disk).
#
#   send-alert.sh "<subject>" "<body>"
#   send-alert.sh --test                 # send a test alert and report the result
#
# Delivery order: email (msmtp) -> webhook -> stderr. Every path is best-effort
# and NEVER fails the caller: a watchdog that dies because its own alert channel
# is down is worse than useless, since it takes the signal with it. Failures to
# deliver are printed, and systemd captures them in journald.
#
# Email config (read from $ENV_FILE, default .env.production.local):
#   ALERT_EMAIL_TO     recipient; email is skipped entirely when unset
#   ALERT_EMAIL_FROM   envelope sender (defaults to SMTP_USER)
#   SMTP_HOST          e.g. smtp.gmail.com
#   SMTP_PORT          default 587 (STARTTLS)
#   SMTP_USER          SMTP username
#   SMTP_PASS          SMTP password / app password
#
# Optional fallback:
#   ALERT_WEBHOOK_URL  Slack/Discord-style incoming webhook

APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production.local}"

read_var() {
  # `|| true` is load-bearing: grep exits 1 when the key is absent, and under
  # `set -e` + `pipefail` that non-zero status propagates out of the command
  # substitution and kills the caller before it ever runs its check. An absent
  # optional key must read as empty, not as a fatal error.
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2- \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

TO="${ALERT_EMAIL_TO:-$(read_var ALERT_EMAIL_TO)}"
SMTP_HOST="${SMTP_HOST:-$(read_var SMTP_HOST)}"
SMTP_PORT="${SMTP_PORT:-$(read_var SMTP_PORT)}"
SMTP_USER="${SMTP_USER:-$(read_var SMTP_USER)}"
SMTP_PASS="${SMTP_PASS:-$(read_var SMTP_PASS)}"
FROM="${ALERT_EMAIL_FROM:-$(read_var ALERT_EMAIL_FROM)}"
FROM="${FROM:-$SMTP_USER}"
WEBHOOK="${ALERT_WEBHOOK_URL:-$(read_var ALERT_WEBHOOK_URL)}"
HOST="$(hostname)"

if [ "${1:-}" = "--test" ]; then
  SUBJECT="Legal Brain test alert"
  BODY="This is a test alert from $HOST at $(date -u '+%Y-%m-%d %H:%M:%S UTC').

If you are reading this in your inbox, production alerting is working."
else
  SUBJECT="${1:?usage: send-alert.sh <subject> <body>}"
  BODY="${2:-}"
fi

sent=0

# ── email ────────────────────────────────────────────────────
if [ -n "$TO" ] && [ -n "$SMTP_HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ]; then
  if command -v msmtp >/dev/null 2>&1; then
    # Config on stdin via --read-envelope-from would still need a file, so pass
    # every setting as a flag and keep the password out of argv (it would be
    # visible in `ps`) by handing msmtp a passwordeval that reads an env var.
    if SMTP_PASS="$SMTP_PASS" printf 'From: %s\nTo: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
        "$FROM" "$TO" "[Legal Brain] $SUBJECT" "$BODY" \
      | msmtp \
          --host="$SMTP_HOST" \
          --port="${SMTP_PORT:-587}" \
          --auth=on \
          --tls=on \
          --tls-starttls=on \
          --user="$SMTP_USER" \
          --passwordeval='printf %s "$SMTP_PASS"' \
          --from="$FROM" \
          --read-recipients 2>/tmp/msmtp-alert.err
    then
      sent=1
      echo "alert emailed to $TO: $SUBJECT"
    else
      echo "ALERT EMAIL FAILED ($(head -c 300 /tmp/msmtp-alert.err 2>/dev/null)): $SUBJECT" >&2
    fi
  else
    echo "msmtp not installed; cannot email alert: $SUBJECT" >&2
  fi
fi

# ── webhook fallback ─────────────────────────────────────────
if [ "$sent" -eq 0 ] && [ -n "$WEBHOOK" ]; then
  if curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
      --data-binary "$(printf '%s' "$SUBJECT: $BODY" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')" \
      "$WEBHOOK" >/dev/null 2>&1; then
    sent=1
    echo "alert posted to webhook: $SUBJECT"
  else
    echo "alert webhook failed: $SUBJECT" >&2
  fi
fi

# ── last resort ──────────────────────────────────────────────
if [ "$sent" -eq 0 ]; then
  echo "UNDELIVERED ALERT — $SUBJECT" >&2
  echo "$BODY" >&2
  if [ -z "$TO" ]; then
    echo "(set ALERT_EMAIL_TO + SMTP_* in $ENV_FILE to receive these by email)" >&2
  fi
  exit 0
fi
