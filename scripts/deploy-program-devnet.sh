#!/usr/bin/env bash
# Deploy the v2 syndicate program to devnet, initialize the protocol, and emit the IDL.
#
# Prereqs: solana CLI configured for devnet with a funded wallet, anchor 0.32.1,
# services/programs/keys/syndicate_program_v2-keypair.json (the declared program id).
#
#   PRICE_SIGNER_ETH=<20-byte hex eth address of the price key> scripts/deploy-program-devnet.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROGRAM_KEYPAIR="$ROOT/services/programs/keys/syndicate_program_v2-keypair.json"
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

: "${PRICE_SIGNER_ETH:?set PRICE_SIGNER_ETH (0x-prefixed Ethereum address of the price signing key)}"
[ -f "$PROGRAM_KEYPAIR" ] || { echo "missing $PROGRAM_KEYPAIR"; exit 1; }

PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
echo "program id: $PROGRAM_ID"

# 1. Build the program.
cd "$ROOT/services/programs"
cargo build-sbf --tools-version v1.53 -- -p syndicate-program

# 2. Deploy (upgradeable; upgrade authority = current solana CLI wallet).
solana program deploy \
  --url "$RPC" \
  --program-id "$PROGRAM_KEYPAIR" \
  target/deploy/syndicate_program.so

# 3. Initialize the protocol (roles = operator wallet, bounds from env or defaults).
cd "$ROOT"
cargo run -p syndicate-chain --features rpc --bin init-protocol -- \
  init \
  --rpc-url "$RPC" \
  --program-id "$PROGRAM_ID" \
  --price-signer "$PRICE_SIGNER_ETH" \
  --buy-in-min "${BUY_IN_MIN:-1000000}" \
  --buy-in-max "${BUY_IN_MAX:-1000000000}" \
  --fill-window-min-sec "${FILL_WINDOW_MIN_SEC:-20}" \
  --fill-window-max-sec "${FILL_WINDOW_MAX_SEC:-86400}" \
  --betting-duration-min-sec "${BETTING_DURATION_MIN_SEC:-60}" \
  --betting-duration-max-sec "${BETTING_DURATION_MAX_SEC:-7200}"

# 4. Regenerate + publish the IDL for the frontend.
bash "$ROOT/scripts/emit-anchor-idl.sh"

echo "devnet deploy complete: $PROGRAM_ID"
