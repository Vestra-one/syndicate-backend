#!/usr/bin/env bash
# Stop every localnet process started by up.sh (state under .localnet/ is kept for logs).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${LOCALNET_DIR:-$ROOT/.localnet}"
for f in "$STATE"/pids/*; do
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  if kill "$pid" 2>/dev/null; then echo "stopped $(basename "$f") ($pid)"; fi
  rm -f "$f"
done
# The throwaway Postgres container, if up.sh had to start one.
if command -v docker >/dev/null 2>&1 && docker ps -aq --filter name=syndicate-localnet-pg 2>/dev/null | grep -q .; then
  docker rm -f syndicate-localnet-pg >/dev/null 2>&1 && echo "removed Docker Postgres (syndicate-localnet-pg)"
fi
