#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export APP_ENV="${APP_ENV:-localnet}"
export SOLANA_CLUSTER="${SOLANA_CLUSTER:-localnet}"
export DATABASE_URL="${DATABASE_URL:-postgres://syndicate:syndicate@localhost:5433/syndicate_local}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6380/0}"
export NATS_URL="${NATS_URL:-nats://localhost:4223}"
export ACTION_FEED_OBJECT_STORE_DIR="${ACTION_FEED_OBJECT_STORE_DIR:-/tmp/syndicate-localnet/replays}"

echo "Syndicate localnet deployment"
echo "APP_ENV=$APP_ENV"
echo "SOLANA_CLUSTER=$SOLANA_CLUSTER"

if ! command -v cargo >/dev/null 2>&1; then
  echo "missing cargo" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "missing node" >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose -f deploy/docker-compose.localnet.yml config >/dev/null
  docker compose -f deploy/docker-compose.app.yml config >/dev/null
  if [[ "${START_INFRA:-0}" == "1" ]]; then
    docker compose -f deploy/docker-compose.localnet.yml up -d
  fi
  if [[ "${START_APP:-0}" == "1" ]]; then
    docker compose -f deploy/docker-compose.app.yml up -d --build
  fi
else
  echo "docker compose not available; skipping local infra compose validation"
fi

./scripts/test-all.sh

if command -v anchor >/dev/null 2>&1; then
  (cd services/programs && anchor build)
else
  echo "anchor not installed; skipping local Anchor build"
fi

if [[ "${RUN_MIGRATIONS:-0}" == "1" ]]; then
  ./scripts/db-migrate-local.sh
fi

echo "Localnet prerequisite checks passed."
echo "Set START_INFRA=1 to start Postgres/Redis/NATS/MinIO/Prometheus/Grafana with Docker Compose."
echo "Set START_APP=1 to build/start gateway, matchmaking, action-feed, and settlement-worker."
echo "Set RUN_MIGRATIONS=1 after Postgres is healthy to apply the production persistence migration."
