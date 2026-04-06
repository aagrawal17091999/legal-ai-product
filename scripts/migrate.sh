#!/bin/bash
set -e

# Load DATABASE_URL from .env.local if it exists
if [ -f .env.local ]; then
  DATABASE_URL=$(grep '^DATABASE_URL=' .env.local | cut -d '=' -f 2-)
  export DATABASE_URL
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Set it in .env.local or export it before running this script."
  exit 1
fi

echo "Running migrations against database..."

for migration in migrations/*.sql; do
  echo "  Applying $migration..."
  psql "$DATABASE_URL" -f "$migration"
done

echo "All migrations applied successfully."
