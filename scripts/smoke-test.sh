#!/usr/bin/env bash
# Post-deploy smoke test: health endpoints, DB, price feed, operator signer balance.
#
#   GAME_SERVER_URL=http://127.0.0.1:18080 CHAIN_WORKER_URL=http://127.0.0.1:18084 \
#   PRICE_URL=http://127.0.0.1:18088 DATABASE_URL=postgres://... \
#   OPERATOR_PUBKEY=<pubkey> SOLANA_RPC_URL=https://api.devnet.solana.com \
#   scripts/smoke-test.sh
set -euo pipefail

GAME_SERVER_URL="${GAME_SERVER_URL:-http://127.0.0.1:18080}"
CHAIN_WORKER_URL="${CHAIN_WORKER_URL:-http://127.0.0.1:18084}"
PRICE_URL="${PRICE_URL:-http://127.0.0.1:18088}"

fail=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "ok   $label"
  else
    echo "FAIL $label"
    fail=1
  fi
}

check "game-server /healthz"    curl -fsS --max-time 5 "$GAME_SERVER_URL/healthz"
check "chain-worker /healthz"   curl -fsS --max-time 5 "$CHAIN_WORKER_URL/healthz"
check "price-server /health"    curl -fsS --max-time 5 "$PRICE_URL/health"
check "price-server /prices"    curl -fsS --max-time 5 "$PRICE_URL/prices"

if [ -n "${DATABASE_URL:-}" ]; then
  check "postgres SELECT 1"     psql "$DATABASE_URL" -qtAc "SELECT 1"
fi

if [ -n "${OPERATOR_PUBKEY:-}" ]; then
  rpc="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
  bal="$(curl -fsS --max-time 10 "$rpc" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$OPERATOR_PUBKEY\"]}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["value"])')" || bal=0
  if [ "$bal" -gt 100000000 ]; then # > 0.1 SOL
    echo "ok   operator balance ${bal} lamports"
  else
    echo "FAIL operator balance ${bal} lamports (< 0.1 SOL)"
    fail=1
  fi
fi

exit $fail
