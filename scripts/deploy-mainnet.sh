#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export APP_ENV="${APP_ENV:-mainnet}"
export SOLANA_CLUSTER="${SOLANA_CLUSTER:-mainnet-beta}"

required_vars=(
  DATABASE_URL
  REDIS_URL
  NATS_URL
  SOLANA_RPC_URL_PRIMARY
  SOLANA_RPC_URL_SECONDARY
  PYTH_API_KEY
  SYNDICATE_PROGRAM_ID
  SETTLEMENT_CHAIN_AUTH_TOKEN_FILE
  SETTLEMENT_SIGNER_KEYPAIR_PATH
  DRAND_API
  DRAND_CHAIN_HASH
  DRAND_EXPECTED_SCHEME_ID
  MAINNET_RELEASE_TAG
  AUDIT_APPROVAL_ID
  BUG_BOUNTY_URL
  DEPLOYER_MULTISIG_ADDRESS
  RELEASE_CONFIG_HASH
)

for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing required environment variable: $name" >&2
    exit 1
  fi
done

if [[ -z "${PYTH_RECEIVER_STACK:-}" ]]; then
  for name in PYTH_HERMES_URL PYTH_RECEIVER_PROGRAM_ID PYTH_WORMHOLE_PROGRAM_ID PYTH_PUSH_ORACLE_PROGRAM_ID; do
    if [[ -z "${!name:-}" ]]; then
      echo "missing required environment variable: $name (or set PYTH_RECEIVER_STACK=legacy|upgraded)" >&2
      exit 1
    fi
  done
fi

current_ref="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_ref" != "main" ]]; then
  echo "mainnet deploy must run from main, current ref is $current_ref" >&2
  exit 1
fi

if [[ "$(git status --porcelain)" != "" ]]; then
  echo "mainnet deploy requires a clean working tree" >&2
  exit 1
fi

./scripts/test-all.sh

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f deploy/docker-compose.localnet.yml config >/dev/null
  docker compose -f deploy/docker-compose.app.yml config >/dev/null
else
  echo "docker compose not available; skipping compose syntax validation"
fi

if ! command -v anchor >/dev/null 2>&1; then
  echo "anchor is required for mainnet deployment" >&2
  exit 1
fi

(cd services/programs && anchor build)

echo "Mainnet preflight checks passed."
echo "Program deployment must proceed through multisig/timelock using release tag $MAINNET_RELEASE_TAG."
