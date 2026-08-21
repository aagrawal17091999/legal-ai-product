#!/bin/bash
set -euo pipefail

# Install + configure Grafana Alloy on the Hetzner box to ship logs to Grafana
# Cloud Loki. Idempotent: safe to re-run after editing deploy/alloy/config.alloy.
#
#   sudo bash scripts/install-alloy.sh
#
# Reads three keys from .env.production.local (Grafana Cloud → Loki → Details):
#   LOKI_URL       https://logs-prod-<n>.grafana.net/loki/api/v1/push
#   LOKI_USER      the numeric Loki instance/user id
#   LOKI_PASSWORD  a Grafana Cloud access policy token with logs:write
#
# The box is ARM (Ampere/CAX21), so the apt repo below must resolve arm64 —
# Grafana publishes it; a hardcoded amd64 .deb would install and then refuse to
# execute.

APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production.local}"

# `|| true` is load-bearing — grep exits 1 on a missing key and, under
# `set -e` + `pipefail`, that status escapes the command substitution and kills
# this script before it can report which key is missing. Same shape as
# scripts/send-alert.sh; every watchdog on this box has to guard it.
read_var() {
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d= -f2- \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (needs apt + /etc/alloy)." >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found." >&2; exit 1; }

LOKI_URL="${LOKI_URL:-$(read_var LOKI_URL)}"
LOKI_USER="${LOKI_USER:-$(read_var LOKI_USER)}"
LOKI_PASSWORD="${LOKI_PASSWORD:-$(read_var LOKI_PASSWORD)}"

MISSING=""
[ -n "$LOKI_URL" ]      || MISSING="$MISSING LOKI_URL"
[ -n "$LOKI_USER" ]     || MISSING="$MISSING LOKI_USER"
[ -n "$LOKI_PASSWORD" ] || MISSING="$MISSING LOKI_PASSWORD"
if [ -n "$MISSING" ]; then
  echo "ERROR: missing in $ENV_FILE:$MISSING" >&2
  echo "Get them from Grafana Cloud -> Connections -> Loki -> Details." >&2
  exit 1
fi

# --- package -----------------------------------------------------------------
if ! command -v alloy >/dev/null 2>&1; then
  echo "Installing Grafana Alloy..."
  apt-get install -y gnupg2 curl ca-certificates >/dev/null
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
    > /etc/apt/sources.list.d/grafana.list
  apt-get update -qq
  apt-get install -y alloy
else
  echo "Alloy already installed ($(alloy --version 2>&1 | head -1))."
fi

# --- pm2 log location --------------------------------------------------------
# The config globs /root/.pm2/logs. If pm2 runs as another user the path differs
# and Alloy would tail nothing at all while looking perfectly healthy — so fail
# loudly here rather than debug silence later.
PM2_LOG_DIR="${PM2_LOG_DIR:-/root/.pm2/logs}"
if ! compgen -G "$PM2_LOG_DIR/nyayasearch*.log" >/dev/null; then
  echo "WARNING: no pm2 logs matched $PM2_LOG_DIR/nyayasearch*.log" >&2
  echo "         Find the real path with: pm2 describe nyayasearch | grep -i 'log path'" >&2
  echo "         then edit deploy/alloy/config.alloy and re-run." >&2
fi

# --- config ------------------------------------------------------------------
install -d -m 755 /etc/alloy
cp "$APP_DIR/deploy/alloy/config.alloy" /etc/alloy/config.alloy
echo "Wrote /etc/alloy/config.alloy"

# Secrets go in a 600 EnvironmentFile, NOT into config.alloy — that file is a
# copy of one tracked in git, and a token pasted into it would be one bad
# `git add` away from the incident this repo has already had once.
install -m 600 /dev/null /etc/default/alloy
cat > /etc/default/alloy <<ENVEOF
LOKI_URL=${LOKI_URL}
LOKI_USER=${LOKI_USER}
LOKI_PASSWORD=${LOKI_PASSWORD}
HOSTNAME=$(hostname)
CUSTOM_ARGS=--disable-reporting
ENVEOF
chmod 600 /etc/default/alloy
echo "Wrote /etc/default/alloy (0600)"

# --- run as root -------------------------------------------------------------
# Alloy's package runs it as the unprivileged `alloy` user, which cannot read
# /root/.pm2/logs (mode 700) or /var/log/nginx. Rather than loosen those, run
# the collector as root on this single-tenant box. The alternative — setfacl on
# both directories — silently reverts whenever pm2 recreates a log file.
install -d -m 755 /etc/systemd/system/alloy.service.d
cat > /etc/systemd/system/alloy.service.d/override.conf <<'OVEOF'
[Service]
User=root
Group=root
OVEOF

systemctl daemon-reload
systemctl enable alloy >/dev/null 2>&1 || true

# Validate before restarting — a bad config would otherwise leave the collector
# dead and the box silently unmonitored.
if alloy validate /etc/alloy/config.alloy; then
  systemctl restart alloy
  sleep 3
  systemctl --no-pager --lines=15 status alloy || true
  echo
  echo "Done. Verify in Grafana Cloud -> Explore -> Loki:"
  echo '  {job="nyayasearch"}'
  echo '  {job="nyayasearch"} | userId=`937`'
else
  echo "ERROR: config failed validation; Alloy NOT restarted." >&2
  exit 1
fi
