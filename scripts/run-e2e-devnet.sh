#!/usr/bin/env bash
# Full-lifecycle e2e against a deployed v2 stack (devnet or local compose).
#
# Prereqs:
#   - stack up (scripts/deploy-devnet.sh) with the v2 program deployed + protocol initialized
#   - PLAYER1_KEYPAIR / PLAYER2_KEYPAIR funded with SOL + chips tokens (ATAs existing)
#   - CHIPS_TOKEN_MINT set (or in deploy/.env)
#
#   GAME_SERVER_URL=https://api.devnet.satoshitable.fun \
#   PLAYER1_KEYPAIR=$HOME/.config/solana/id.json PLAYER2_KEYPAIR=/tmp/player2.json \
#   CHIPS_TOKEN_MINT=<mint> scripts/run-e2e-devnet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GAME_SERVER_URL="${GAME_SERVER_URL:-https://api.devnet.satoshitable.fun}"
export E2E_SCENARIOS="${E2E_SCENARIOS:-public}"

# Load only the keys this script needs from deploy/.env. Do not `source` the whole file:
# values like CORS_ALLOWED_ORIGINS may contain shell-significant spaces.
env_file_value() {
  local key="$1"
  if [ -f deploy/.env ]; then
    awk -F= -v key="$key" '$1 == key {print substr($0, length(key) + 2); exit}' deploy/.env
  fi
}

# Load mint/RPC from deploy/.env if present and unset.
if [ -f deploy/.env ]; then
  export CHIPS_TOKEN_MINT="${CHIPS_TOKEN_MINT:-$(env_file_value CHIPS_TOKEN_MINT)}"
  export SOLANA_RPC_URL="${SOLANA_RPC_URL:-$(env_file_value SOLANA_RPC_URL_PRIMARY)}"
fi
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
: "${CHIPS_TOKEN_MINT:?set CHIPS_TOKEN_MINT}"

echo "== preflight =="
curl -fsS --max-time 5 "$GAME_SERVER_URL/healthz" >/dev/null || {
  echo "game-server not reachable at $GAME_SERVER_URL"; exit 1;
}

echo "== lifecycle e2e (frontend public flow: create → join → seal → live betting all rounds → settle → claim) =="
cargo run -p syndicate-e2e --bin e2e-devnet --release

if [ "${RUN_LOAD:-0}" = "1" ]; then
  echo "== ws load sanity =="
  CONNECTIONS="${CONNECTIONS:-1000}" HOLD_SEC="${HOLD_SEC:-30}" \
    cargo run -p syndicate-e2e --bin load-sanity --release
fi

echo "E2E PASSED"
