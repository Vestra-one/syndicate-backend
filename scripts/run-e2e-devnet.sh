#!/usr/bin/env bash
# Full-lifecycle e2e against a deployed v2 stack (devnet or local compose).
#
# Prereqs:
#   - stack up (scripts/deploy-devnet.sh) with the v2 program deployed + protocol initialized
#   - PLAYER1_KEYPAIR / PLAYER2_KEYPAIR funded with SOL + chips tokens (ATAs existing)
#   - CHIPS_TOKEN_MINT set (or in deploy/.env)
#
#   GAME_SERVER_URL=http://127.0.0.1:18080 \
#   PLAYER1_KEYPAIR=$HOME/.config/solana/id.json PLAYER2_KEYPAIR=/tmp/player2.json \
#   CHIPS_TOKEN_MINT=<mint> scripts/run-e2e-devnet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GAME_SERVER_URL="${GAME_SERVER_URL:-http://127.0.0.1:18080}"
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

# Load mint/program from deploy/.env if present and unset.
if [ -f deploy/.env ]; then
  set -a; # shellcheck disable=SC1091
  source deploy/.env; set +a
fi
: "${CHIPS_TOKEN_MINT:?set CHIPS_TOKEN_MINT}"

echo "== preflight =="
curl -fsS --max-time 5 "$GAME_SERVER_URL/healthz" >/dev/null || {
  echo "game-server not reachable at $GAME_SERVER_URL"; exit 1;
}

echo "== lifecycle e2e (create → join → lock → seal/no-seal → live → settle → claim) =="
cargo run -p syndicate-e2e --bin e2e-devnet --release

echo "== ws load sanity =="
CONNECTIONS="${CONNECTIONS:-1000}" HOLD_SEC="${HOLD_SEC:-30}" \
  cargo run -p syndicate-e2e --bin load-sanity --release

echo "E2E + LOAD PASSED"
