#!/usr/bin/env bash
# Apply incremental store migrations (0003–0007) to an existing Postgres schema.
# Safe to re-run: later migrations use IF NOT EXISTS / DO blocks where possible.
#
# Usage:
#   DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" \
#     ./scripts/db-migrate-incremental.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgres://syndicate:syndicate@localhost:5433/syndicate_local}"

MIGRATIONS=(
  0003_drop_oracle_delay_window_sec.sql
  0003_signed_intents.sql
  0004_prediction_blinding.sql
  0005_profile_metadata.sql
  0006_match_lifecycle_columns.sql
  0007_match_config_hash.sql
)

echo "Applying incremental migrations to ${DATABASE_URL}"
for file in "${MIGRATIONS[@]}"; do
  path="$ROOT_DIR/services/store/migrations/$file"
  echo "→ $file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$path"
done
echo "Incremental migrations complete."
