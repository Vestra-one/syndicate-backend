#!/usr/bin/env bash
# Provision the house bots: three wallets (BOT_COUNT) that keep one public table open (see
# services/e2e/src/house.rs). Run on the host that runs the stack, once.
#
#   scripts/house-bots-setup.sh            # create keys, record their wallets in deploy/.env
#   FUND=1 scripts/house-bots-setup.sh     # …and fund them from the operator (devnet)
#   scripts/deploy-devnet.sh               # starts the bots along with the stack
#
# FUND=1 sends each bot SOL_EACH SOL (default 0.5) and CHIPS_EACH chips (default 200, UI
# units) from deploy/secrets/operator-keypair.json. The operator must hold the chips, or
# be the chip mint's authority (then they are minted). On mainnet fund the two wallets
# yourself: the script prints their addresses.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f deploy/.env ] || { echo "deploy/.env missing (cp deploy/.env.example deploy/.env)"; exit 1; }
command -v solana-keygen >/dev/null || { echo "solana-keygen not found (install the Solana CLI)"; exit 1; }

envval() { grep -E "^$1=" deploy/.env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//'; }
RPC="$(envval SOLANA_RPC_URL_PRIMARY)"
MINT="$(envval CHIPS_TOKEN_MINT)"
OPERATOR=deploy/secrets/operator-keypair.json

# Keys live in their own folder so the bots' container sees them and nothing else. Bots
# provisioned by an earlier version (deploy/secrets/house-bot-N.json) are moved across.
BOT_DIR=deploy/secrets/house-bots
BOT_COUNT="${BOT_COUNT:-3}"   # 3 bots + 1 visitor = a four-handed table
mkdir -p "$BOT_DIR" && chmod 755 "$BOT_DIR"
WALLETS=""
KEYPATHS=""
for i in $(seq 1 "$BOT_COUNT"); do
  key="$BOT_DIR/house-bot-$i.json"
  [ -f "$key" ] || { [ -f "deploy/secrets/house-bot-$i.json" ] && mv "deploy/secrets/house-bot-$i.json" "$key"; } || true
  [ -f "$key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$key" >/dev/null
  chmod 644 "$key" # read by an unprivileged in-container user, like the other secrets
  WALLETS="${WALLETS:+$WALLETS,}$(solana-keygen pubkey "$key")"
  KEYPATHS="${KEYPATHS:+$KEYPATHS,}/run/house-bots/house-bot-$i.json"
done
if grep -qE '^HOUSE_BOT_KEYPAIRS=' deploy/.env; then
  sed -i.bak -E "s|^HOUSE_BOT_KEYPAIRS=.*|HOUSE_BOT_KEYPAIRS=$KEYPATHS|" deploy/.env && rm -f deploy/.env.bak
else
  printf 'HOUSE_BOT_KEYPAIRS=%s\n' "$KEYPATHS" >>deploy/.env
fi

if grep -qE '^HOUSE_BOT_WALLETS=' deploy/.env; then
  sed -i.bak -E "s|^HOUSE_BOT_WALLETS=.*|HOUSE_BOT_WALLETS=$WALLETS|" deploy/.env && rm -f deploy/.env.bak
else
  printf '\n# House bots (scripts/house-bots-setup.sh) — labelled as bots in the UI.\nHOUSE_BOT_WALLETS=%s\n' "$WALLETS" >>deploy/.env
fi
echo "house bots: $WALLETS"
echo "recorded in deploy/.env as HOUSE_BOT_WALLETS"

if [ "${FUND:-0}" = "1" ]; then
  [ -f "$OPERATOR" ] || { echo "$OPERATOR missing"; exit 1; }
  command -v spl-token >/dev/null || { echo "spl-token not found (install the Solana CLI)"; exit 1; }
  SOL_EACH="${SOL_EACH:-0.5}"
  CHIPS_EACH="${CHIPS_EACH:-200}"
  AUTHORITY="$(spl-token display "$MINT" --url "$RPC" 2>/dev/null | awk '/Mint authority:/{print $NF}')"
  OP_PUB="$(solana-keygen pubkey "$OPERATOR")"
  for w in ${WALLETS//,/ }; do
    # Already funded on an earlier run? Leave it: re-running must not drain the operator.
    held="$(solana balance "$w" --url "$RPC" 2>/dev/null | awk '{print int($1 * 100)}')"
    if [ "${held:-0}" -ge 10 ]; then echo "already funded $w"; continue; fi
    solana transfer "$w" "$SOL_EACH" --url "$RPC" --keypair "$OPERATOR" --allow-unfunded-recipient >/dev/null
    spl-token create-account "$MINT" --owner "$w" --url "$RPC" --fee-payer "$OPERATOR" >/dev/null 2>&1 || true
    if [ "$AUTHORITY" = "$OP_PUB" ]; then
      ata="$(spl-token address --token "$MINT" --owner "$w" --verbose --url "$RPC" | awk '/Associated token address:/{print $NF}')"
      spl-token mint "$MINT" "$CHIPS_EACH" "$ata" --url "$RPC" --fee-payer "$OPERATOR" --mint-authority "$OPERATOR" >/dev/null
    else
      spl-token transfer "$MINT" "$CHIPS_EACH" "$w" --url "$RPC" --fee-payer "$OPERATOR" --owner "$OPERATOR" --allow-unfunded-recipient >/dev/null
    fi
    echo "funded $w: $SOL_EACH SOL, $CHIPS_EACH chips"
  done
else
  echo "fund each wallet with SOL for fees and chips for buy-ins (FUND=1 does it from the operator on devnet)"
fi
