#!/bin/bash
set -euo pipefail

# One-shot production bring-up for the Hetzner box. Idempotent — safe to re-run.
# It does the boring, error-prone wiring; it deliberately does NOT run certbot
# (interactive, needs ports 80/443 open first) or create your secrets file.
#
# PREREQUISITES (do these first):
#   1. SSH in:  ssh root@204.168.160.193
#   2. cd /opt/legal-ai-product && git pull origin main
#   3. Create the secrets file:
#        cp .env.production.local.example .env.production.local
#        nano .env.production.local     # fill in real values
#        chmod 600 .env.production.local
#   4. Open ports 80 + 443 in the Hetzner Cloud Firewall (console) if you use one.
#
# Then:  sudo bash scripts/bootstrap-box.sh
#
# After it finishes, run the certbot line it prints to turn on HTTPS.

APP_DIR="$(pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"   # the user pm2 / the app run as
DOMAINS="getlegalbrain.com www.getlegalbrain.com staging.getlegalbrain.com"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$APP_DIR/.env.production.local" ] || die "Missing .env.production.local in $APP_DIR (see step 3 above)."
[ -f "$APP_DIR/ecosystem.config.js" ]   || die "Run this from the app checkout (ecosystem.config.js not found)."

# --- 1. System packages -----------------------------------------------------
say "Ensuring nginx + certbot are installed"
if ! command -v nginx >/dev/null;   then apt-get update -y && apt-get install -y nginx; fi
if ! command -v certbot >/dev/null; then apt-get install -y certbot python3-certbot-nginx; fi

# --- 2. Postgres tuning -----------------------------------------------------
PG_CONFD="$(find /etc/postgresql -maxdepth 3 -type d -name conf.d 2>/dev/null | head -1)"
if [ -n "$PG_CONFD" ]; then
  say "Installing Postgres tuning -> $PG_CONFD/zz-nyayasearch.conf"
  cp deploy/postgres/tuning.conf "$PG_CONFD/zz-nyayasearch.conf"
  systemctl restart postgresql
  sudo -u postgres psql -tAc "SHOW shared_buffers;" | sed 's/^/    shared_buffers = /'
else
  echo "    (Postgres conf.d not found — skipping tuning; apply deploy/postgres/tuning.conf by hand.)"
fi

# --- 3. App: build + migrate + cluster-mode pm2 -----------------------------
say "Building app and running migrations"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm ci && npm run build"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && ENV_FILE=.env.production.local bash scripts/migrate.sh"

say "Starting app under pm2 (cluster mode)"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && pm2 delete nyayasearch 2>/dev/null; pm2 start ecosystem.config.js --only nyayasearch && pm2 save"
# Enable pm2 on boot for this user (prints nothing if already set).
env PATH="$PATH" pm2 startup systemd -u "$RUN_USER" --hp "/home/$RUN_USER" >/dev/null 2>&1 || true

# --- 4. systemd timers (batch worker, retention cron, backup, disk watchdog) -
say "Installing systemd timers"
for unit in process-batches credit-refill rag-retention backup disk-alert; do
  # Adapt the shipped units to this box's user + checkout path.
  sed -e "s#^User=.*#User=$RUN_USER#" \
      -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
      "deploy/systemd/nyayasearch-${unit}.service" > "/etc/systemd/system/nyayasearch-${unit}.service"
  cp "deploy/systemd/nyayasearch-${unit}.timer" "/etc/systemd/system/nyayasearch-${unit}.timer"
done
systemctl daemon-reload
systemctl enable --now nyayasearch-process-batches.timer nyayasearch-credit-refill.timer \
                       nyayasearch-rag-retention.timer nyayasearch-backup.timer \
                       nyayasearch-disk-alert.timer
systemctl list-timers | grep nyayasearch || true

# --- 5. nginx (HTTP-only; certbot adds TLS after) ---------------------------
say "Installing nginx site"
cp deploy/nginx/nyayasearch.conf /etc/nginx/sites-available/nyayasearch
ln -sf /etc/nginx/sites-available/nyayasearch /etc/nginx/sites-enabled/nyayasearch
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# --- 6. Local firewall (Hetzner Cloud Firewall is separate — see prereqs) ---
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Opening HTTP/HTTPS in ufw"
  ufw allow 'Nginx Full'
fi

say "Bootstrap complete."
cat <<EOF

Next, turn on HTTPS (needs ports 80/443 reachable from the internet):

  sudo certbot --nginx -d getlegalbrain.com -d www.getlegalbrain.com -d staging.getlegalbrain.com

Then verify:
  curl -I https://getlegalbrain.com/api/health      # expect HTTP/2 200

If you get 502 Bad Gateway, the app isn't answering on :3000 — check: pm2 status
EOF
