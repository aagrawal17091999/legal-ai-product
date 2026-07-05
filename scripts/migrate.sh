#!/bin/bash
set -euo pipefail

# Apply database migrations EXACTLY ONCE each, tracked in a schema_migrations
# ledger. This replaces the old loop that blindly re-ran every migrations/*.sql
# on every invocation — which silently re-executed the destructive TRUNCATE in
# 009_embeddings_v2.sql and wiped all embeddings. Never again: an already-applied
# migration is skipped, and 009 is itself guarded to be non-destructive on re-run.

# Load DATABASE_URL from the environment's dotenv file unless it is already
# exported. ENV_FILE selects the environment (defaults to .env.local so local
# usage is unchanged); deploy.sh sets ENV_FILE=.env.production.local /
# .env.staging.local so the right database is migrated.
ENV_FILE="${ENV_FILE:-.env.local}"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d '=' -f 2-)
  export DATABASE_URL
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Set it in ${ENV_FILE} or export it before running this script." >&2
  exit 1
fi

# ON_ERROR_STOP makes psql fail the script on any SQL error (with set -e).
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)

# Ledger of applied migrations. The first run on an already-migrated DB will
# re-apply the older files, but every one is idempotent (IF NOT EXISTS / ADD
# COLUMN IF NOT EXISTS / the guarded 009), so this transition is safe and
# self-correcting — and from then on each file runs at most once.
"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);"

echo "Running migrations against database..."
applied=0
skipped=0
for migration in migrations/*.sql; do
  name="$(basename "$migration")"
  already="$("${PSQL[@]}" -tAc "SELECT 1 FROM schema_migrations WHERE filename = '${name}'")"
  if [ "${already}" = "1" ]; then
    echo "  - skip   ${name} (already applied)"
    skipped=$((skipped + 1))
    continue
  fi
  echo "  + apply  ${name}"
  "${PSQL[@]}" -f "${migration}"
  "${PSQL[@]}" -c "INSERT INTO schema_migrations (filename) VALUES ('${name}') ON CONFLICT DO NOTHING;"
  applied=$((applied + 1))
done

echo "All migrations applied. ${applied} applied, ${skipped} skipped."
