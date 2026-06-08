#!/bin/bash
set -euo pipefail

# Deploy the Next.js app on the CAX21 box (app + Postgres run on the same server).
# The app lives in /opt/legal-ai-product (it was previously /opt/nyayasearch; the
# old path here silently no-op'd). Override either value via env if the layout
# changes, e.g.:  APP_DIR=/srv/app PM2_APP=myapp bash scripts/deploy.sh
APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
PM2_APP="${PM2_APP:-nyayasearch}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "ERROR: $APP_DIR is not a git checkout. Set APP_DIR to the app directory." >&2
  exit 1
fi

# Fail fast (before building) if the pm2 process name is wrong.
if ! pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  echo "ERROR: pm2 process '$PM2_APP' not found. Run 'pm2 list' and set PM2_APP=<name>." >&2
  pm2 list || true
  exit 1
fi

cd "$APP_DIR"
echo "Deploying $PM2_APP from $APP_DIR ..."
git pull origin main
npm install
npm run build
pm2 restart "$PM2_APP" --update-env
echo "Deployed $PM2_APP from $APP_DIR at $(date)"
