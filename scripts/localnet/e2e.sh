#!/usr/bin/env bash
# Run the full lifecycle + fund-theft suite (services/e2e) against the running localnet.
#
#   scripts/localnet/e2e.sh                         # every scenario
#   E2E_SCENARIOS=public,theft scripts/localnet/e2e.sh
#   STREET_SEC=30 ROUND_COUNT=2 scripts/localnet/e2e.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${LOCALNET_DIR:-$ROOT/.localnet}"
[ -f "$STATE/env" ] || { echo "localnet is not up — run scripts/localnet/up.sh first"; exit 1; }
set -a; . "$STATE/env"; set +a
export E2E_SCENARIOS="${E2E_SCENARIOS:-all}"
cd "$ROOT"
cargo run -q -p syndicate-e2e --bin e2e-devnet
echo "LOCALNET E2E PASSED"
