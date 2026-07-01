#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgres://syndicate:syndicate@localhost:5433/syndicate_local}"

echo "Applying full store schema to ${DATABASE_URL}"

psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/services/store/migrations/0001_production_persistence.sql"

psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/services/store/migrations/0002_settlement_queue.sql"

# Incremental migrations (0003–0007) — idempotent where possible.
"$ROOT_DIR/scripts/db-migrate-incremental.sh"
