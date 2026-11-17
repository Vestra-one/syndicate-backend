#!/usr/bin/env bash
# Build + deploy the v2 app stack on the current host (devnet flavor).
#
#   cp deploy/.env.example deploy/.env   # fill in first
#   scripts/deploy-devnet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f deploy/.env ] || { echo "deploy/.env missing (cp deploy/.env.example deploy/.env)"; exit 1; }
for f in postgres-password operator-keypair.json price-signer.key session-signing-key; do
  [ -f "deploy/secrets/$f" ] || { echo "deploy/secrets/$f missing (see deploy/secrets/README.md)"; exit 1; }
done

COMPOSE=(docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.devnet.yml --env-file deploy/.env)

# House bots start with the stack once scripts/house-bots-setup.sh has provisioned them.
BUILD=(game-server chain-worker signed-price-server)
if [ -f deploy/secrets/house-bot-1.json ] && [ -f deploy/secrets/house-bot-2.json ]; then
  COMPOSE+=(--profile bots)
  BUILD+=(house-bots)
  echo "house bots: enabled"
else
  echo "house bots: off (run scripts/house-bots-setup.sh to keep a table always open)"
fi

"${COMPOSE[@]}" config -q
echo "building images…"
"${COMPOSE[@]}" build "${BUILD[@]}"
echo "starting stack…"
"${COMPOSE[@]}" up -d

echo "waiting for health…"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:18080/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

GAME_SERVER_URL=http://127.0.0.1:18080 \
CHAIN_WORKER_URL=http://127.0.0.1:18084 \
PRICE_URL=http://127.0.0.1:18088 \
  bash scripts/smoke-test.sh

echo "devnet stack deployed."
