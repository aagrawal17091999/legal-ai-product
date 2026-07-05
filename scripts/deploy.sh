#!/bin/bash
set -euo pipefail

# Environment-aware deploy for the Hetzner CAX21 box (app + Postgres co-located).
# One repo, one logical "project", two isolated environments — production and
# staging — each with its own checkout dir, pm2 process, database, and env file.
#
#   bash scripts/deploy.sh              # deploy production (default)
#   bash scripts/deploy.sh staging      # deploy staging
#   REF=v1.4.2 bash scripts/deploy.sh   # deploy a specific tag/commit (rollback)
#
# What it does, in order: fetch -> checkout ref -> install -> build -> run DB
# migrations against THIS environment's database -> graceful pm2 reload -> tag.
# Migrations run BEFORE reload and gate the deploy: if a migration fails, the old
# process keeps serving (we never reload onto a schema that didn't apply).

ENV_NAME="${1:-production}"
REF="${REF:-origin/main}"

case "$ENV_NAME" in
  production)
    APP_DIR="${APP_DIR:-/opt/legal-ai-product}"
    PM2_APP="${PM2_APP:-nyayasearch}"
    ENV_FILE="${ENV_FILE:-.env.production.local}"
    ;;
  staging)
    APP_DIR="${APP_DIR:-/opt/legal-ai-product-staging}"
    PM2_APP="${PM2_APP:-nyayasearch-staging}"
    ENV_FILE="${ENV_FILE:-.env.staging.local}"
    ;;
  *)
    echo "ERROR: unknown environment '$ENV_NAME' (expected: production | staging)." >&2
    exit 1
    ;;
esac

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

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file '$ENV_FILE' not found in $APP_DIR." >&2
  echo "Each environment needs its own dotenv (never share prod secrets with staging)." >&2
  exit 1
fi

echo "==> Deploying '$ENV_NAME' ($PM2_APP) from $APP_DIR at ref '$REF'"

git fetch --tags --prune origin
git checkout --force "$REF"

npm ci

npm run build

echo "==> Running database migrations against '$ENV_NAME' database"
ENV_FILE="$ENV_FILE" bash scripts/migrate.sh

# Graceful reload (cluster mode) keeps in-flight requests — including active SSE
# chat streams — alive across the swap, unlike `restart` which kills them.
echo "==> Reloading $PM2_APP"
pm2 reload "$PM2_APP" --update-env

# Tag production releases so rollback is `REF=<tag> bash scripts/deploy.sh`.
if [ "$ENV_NAME" = "production" ]; then
  DEPLOY_TAG="prod-$(date +%Y%m%d-%H%M%S)"
  git tag -f "$DEPLOY_TAG" >/dev/null 2>&1 || true
  echo "==> Tagged release $DEPLOY_TAG"
fi

echo "==> Deployed '$ENV_NAME' ($PM2_APP) from $APP_DIR at $(date)"
