#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export APP_ENV="${APP_ENV:-devnet}"
export SOLANA_CLUSTER="${SOLANA_CLUSTER:-devnet}"

required_vars=(
  DATABASE_URL
  REDIS_URL
  NATS_URL
  SOLANA_RPC_URL_PRIMARY
  PYTH_HERMES_URL
  PYTH_API_KEY
  PYTH_RECEIVER_PROGRAM_ID
  PYTH_WORMHOLE_PROGRAM_ID
  PYTH_PUSH_ORACLE_PROGRAM_ID
  SYNDICATE_PROGRAM_ID
  SETTLEMENT_CHAIN_AUTH_TOKEN_FILE
  SETTLEMENT_SIGNER_KEYPAIR_PATH
  DEPLOYER_MULTISIG_ADDRESS
)

for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing required environment variable: $name" >&2
    exit 1
  fi
done

./scripts/test-all.sh

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f deploy/docker-compose.localnet.yml config >/dev/null
  docker compose -f deploy/docker-compose.app.yml config >/dev/null
else
  echo "docker compose not available; skipping compose syntax validation"
fi

if ! command -v anchor >/dev/null 2>&1; then
  echo "anchor is required for devnet deployment" >&2
  exit 1
fi

(cd services/programs && anchor build)

echo "Devnet build checks passed."
echo "Deploy/upgrade must be executed through the configured devnet authority workflow."
