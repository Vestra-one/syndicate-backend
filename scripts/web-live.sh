#!/usr/bin/env bash
# Run the web app on this machine against the LIVE devnet backend.
#   scripts/web-live.sh            → http://localhost:5173
# Override any VITE_* variable in the environment to point somewhere else.
set -euo pipefail
cd "$(dirname "$0")/../apps/web"

export VITE_API_URL="${VITE_API_URL:-https://api.satoshi.vestra.one/v1}"
export VITE_WS_URL="${VITE_WS_URL:-wss://api.satoshi.vestra.one/v1/ws}"
export VITE_PRICE_WS_URL="${VITE_PRICE_WS_URL:-wss://price.satoshi.vestra.one/ws}"
export VITE_SOLANA_RPC_URL="${VITE_SOLANA_RPC_URL:-https://api.devnet.solana.com}"
export VITE_PROGRAM_ID="${VITE_PROGRAM_ID:-EQsNZV4bBqaXFSSDkYKxuu57eBB9s83ouTjC4imDNvTv}"

[ -d node_modules ] || npm install
exec npx vite --port "${PORT:-5173}" --strictPort --host 127.0.0.1
