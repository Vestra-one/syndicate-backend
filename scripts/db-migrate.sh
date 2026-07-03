#!/usr/bin/env bash
# Apply services/store/migrations/*.sql in lexical order, idempotently, tracking applied
# files in a schema_migrations table.
#
#   DATABASE_URL=postgres://syndicate:pw@127.0.0.1:5432/syndicate scripts/db-migrate.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/services/store/migrations"
: "${DATABASE_URL:?set DATABASE_URL}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" -c 'CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);'

applied=0
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  name="$(basename "$f")"
  done="$("${PSQL[@]}" -c "SELECT 1 FROM schema_migrations WHERE filename = '$name'")"
  if [ "$done" != "1" ]; then
    echo "applying $name"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
    "${PSQL[@]}" -c "INSERT INTO schema_migrations (filename) VALUES ('$name')"
    applied=$((applied + 1))
  fi
done

echo "migrations up to date ($applied applied this run)"
