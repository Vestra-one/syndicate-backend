#!/usr/bin/env bash
# Deploy the backend to a server from your own machine, in one command:
#
#   scripts/deploy-remote.sh root@<server-address>
#
# Copies this working tree to /opt/satoshi-table on the server (no git access needed
# there) and runs scripts/server-bootstrap.sh. You are asked for the server password once.
# Re-run it any time to ship new code: the bootstrap skips whatever is already done.
#
# Optional env, passed through: DOMAIN, SOLANA_RPC_URL, TLS_EMAIL.
set -euo pipefail

HOST="${1:?usage: scripts/deploy-remote.sh user@host}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/satoshi-table
CTL="$HOME/.ssh/satoshi-deploy-%C"
mkdir -p "$HOME/.ssh"
SSH=(ssh -o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=30m -o StrictHostKeyChecking=accept-new)

[ -f "$ROOT/services/programs/keys/syndicate_program_v2-keypair.json" ] ||
  { echo "missing services/programs/keys/syndicate_program_v2-keypair.json"; exit 1; }

echo "== connecting to $HOST"
# Root login disabled? Log in as a user with passwordless sudo and everything runs via sudo.
SUDO=""
[ "$("${SSH[@]}" "$HOST" id -u)" = 0 ] || SUDO="sudo -n -H"
"${SSH[@]}" "$HOST" "$SUDO mkdir -p $DEST && { command -v rsync >/dev/null || ($SUDO apt-get update -qq && $SUDO apt-get install -y -qq rsync >/dev/null); }"

echo "== copying the code"
rsync -az --delete -e "${SSH[*]}" ${SUDO:+--rsync-path="sudo -n rsync"} \
  --exclude '.git' --exclude 'target' --exclude 'node_modules' --exclude '.localnet' \
  --exclude 'apps/web/dist' --exclude 'apps/web/e2e-shots' \
  --exclude 'deploy/secrets/*' --exclude 'deploy/.env' \
  --exclude 'marketing_and_go_to_market' \
  "$ROOT/" "$HOST:$DEST/"

echo "== bootstrapping (first run builds everything: 20–40 minutes)"
"${SSH[@]}" -t "$HOST" "cd $DEST && $SUDO env DOMAIN='${DOMAIN:-}' SOLANA_RPC_URL='${SOLANA_RPC_URL:-}' TLS_EMAIL='${TLS_EMAIL:-}' EDGE_NETWORK='${EDGE_NETWORK:-}' bash -c '
  [ -n \"\$DOMAIN\" ] || unset DOMAIN; [ -n \"\$SOLANA_RPC_URL\" ] || unset SOLANA_RPC_URL; [ -n \"\$TLS_EMAIL\" ] || unset TLS_EMAIL; [ -n \"\$EDGE_NETWORK\" ] || unset EDGE_NETWORK
  bash scripts/server-bootstrap.sh'"
