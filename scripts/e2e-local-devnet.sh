#!/usr/bin/env bash
#
# Reproducible end-to-end test of the Syndicate v2 backend against devnet.
#
# One command does everything:
#   1. creates 3 player keypairs + 1 attacker keypair (idempotent, under deploy/e2e-keys/)
#   2. funds them with SOL + chips tokens from the funder wallet (~/.config/solana/id.json)
#   3. verifies the program is deployed and the on-chain protocol is initialized
#   4. brings the Docker stack up on a reachable RPC and waits until it is healthy
#   5. runs the comprehensive lifecycle + fund-theft e2e suite (services/e2e)
#   6. (optional) runs the 1000-connection WS load sanity check
#
# Prereqs: solana + spl-token CLIs, docker + docker compose, a Rust toolchain, and a
# funder wallet at ~/.config/solana/id.json holding devnet SOL and being the mint
# authority (or holder) of the chips token.
#
# Usage:
#   SOLANA_RPC_URL=<devnet-rpc> scripts/e2e-local-devnet.sh
#   SOLANA_RPC_URL=<rpc> RUN_LOAD=1 scripts/e2e-local-devnet.sh   # also run load sanity
#   SOLANA_RPC_URL=<rpc> E2E_SCENARIOS=public,theft scripts/e2e-local-devnet.sh
#
# The RPC defaults to SOLANA_RPC_URL_PRIMARY from deploy/.env if unset. Solana's public
# devnet endpoint (api.devnet.solana.com) is frequently IP-blocked; use a keyed provider.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---- config -------------------------------------------------------------------------
# Load deploy/.env WITHOUT shell-executing values (values like CORS_ALLOWED_ORIGINS contain
# unquoted spaces/commas that `. deploy/.env` would try to run as commands). Read only
# simple KEY=VALUE lines and export them verbatim.
if [ -f deploy/.env ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|\#*) continue ;; esac
    export "$_k=$_v"
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' deploy/.env)
fi

RPC="${SOLANA_RPC_URL:-${SOLANA_RPC_URL_PRIMARY:-https://api.devnet.solana.com}}"
FUNDER="${FUNDER_KEYPAIR:-$HOME/.config/solana/id.json}"
PROGRAM_ID="${SYNDICATE_PROGRAM_ID:?set SYNDICATE_PROGRAM_ID (or run from a populated deploy/.env)}"
MINT="${CHIPS_TOKEN_MINT:?set CHIPS_TOKEN_MINT (or run from a populated deploy/.env)}"
PRICE_SIGNER_ETH="${PRICE_SIGNER_ETH:-}"
GAME_SERVER_URL="${GAME_SERVER_URL:-http://127.0.0.1:18080}"
CHAIN_WORKER_URL="${CHAIN_WORKER_URL:-http://127.0.0.1:18084}"

BUY_IN="${BUY_IN:-1000000}"          # 1 chip @ 6 decimals
FUND_SOL="${FUND_SOL:-0.2}"          # per player, for tx fees + rent
FUND_CHIPS_UI="${FUND_CHIPS_UI:-30}" # per player, UI amount (30 => 30_000_000 base)
KEYDIR="$ROOT/deploy/e2e-keys"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

sol()  { solana "$@" --url "$RPC"; }
spl()  { spl-token "$@" --url "$RPC"; }

# ---- 0. preflight -------------------------------------------------------------------
say "preflight"
for bin in solana spl-token docker cargo; do command -v "$bin" >/dev/null || die "missing $bin"; done
[ -f "$FUNDER" ] || die "funder keypair not found: $FUNDER"
FUNDER_PUBKEY="$(solana-keygen pubkey "$FUNDER")"
solana config set --keypair "$FUNDER" --url "$RPC" >/dev/null
sol cluster-version >/dev/null 2>&1 || die "RPC unreachable: $RPC (public devnet is often IP-blocked; use a keyed provider)"
ok "RPC reachable: $RPC"
ok "funder: $FUNDER_PUBKEY  balance: $(sol balance)"

# ---- 1. player keypairs (idempotent) ------------------------------------------------
# Deterministic paths so re-runs reuse the same wallets: $KEYDIR/<name>.json.
say "player keypairs"
mkdir -p "$KEYDIR"
for name in player1 player2 player3 attacker; do
  f="$KEYDIR/$name.json"
  [ -f "$f" ] || solana-keygen new --no-bip39-passphrase --silent -o "$f"
  ok "$name = $(solana-keygen pubkey "$f")"
done

# ---- 2. fund players (SOL + chips) --------------------------------------------------
say "funding (SOL + chips) from $FUNDER_PUBKEY"
for name in player1 player2 player3 attacker; do
  pk="$(solana-keygen pubkey "$KEYDIR/$name.json")"

  bal="$(sol balance "$pk" | awk '{print $1}')"
  if awk "BEGIN{exit !($bal < $FUND_SOL)}"; then
    sol transfer "$pk" "$FUND_SOL" --allow-unfunded-recipient --keypair "$FUNDER" >/dev/null
    ok "$name +${FUND_SOL} SOL (was $bal)"
  else
    ok "$name SOL ok ($bal)"
  fi

  # Associated token account (funder pays), then mint chips up to the target.
  ata="$(spl address --token "$MINT" --owner "$pk" --verbose | awk '/Associated token address:/{print $NF}')"
  [ -n "$ata" ] || die "could not derive ATA for $name"
  spl create-account "$MINT" --owner "$pk" --fee-payer "$FUNDER" >/dev/null 2>&1 || true
  have="$(spl balance --address "$ata" 2>/dev/null || echo 0)"
  if awk "BEGIN{exit !(${have:-0} < $FUND_CHIPS_UI)}"; then
    spl mint "$MINT" "$FUND_CHIPS_UI" "$ata" --mint-authority "$FUNDER" >/dev/null \
      || die "chips mint failed for $name — is $FUNDER_PUBKEY the mint authority of $MINT?"
    ok "$name +${FUND_CHIPS_UI} chips (was ${have:-0})"
  else
    ok "$name chips ok ($have)"
  fi
done

# ---- 3. program + protocol state ----------------------------------------------------
say "program + protocol"
sol program show "$PROGRAM_ID" >/dev/null 2>&1 || die "program $PROGRAM_ID not deployed on this cluster"
ok "program deployed: $PROGRAM_ID"
# The protocol PDA must exist and carry the price signer that matches the price server.
if [ -n "$PRICE_SIGNER_ETH" ]; then
  cargo run -q -p syndicate-chain --features rpc --bin init-protocol -- \
    init --rpc-url "$RPC" --program-id "$PROGRAM_ID" --price-signer "$PRICE_SIGNER_ETH" \
    --keypair "$FUNDER" >/dev/null 2>&1 && ok "protocol initialized" || ok "protocol already initialized"
  cargo run -q -p syndicate-chain --features rpc --bin init-protocol -- \
    set-price-signer --rpc-url "$RPC" --program-id "$PROGRAM_ID" --price-signer "$PRICE_SIGNER_ETH" \
    --keypair "$FUNDER" >/dev/null && ok "price signer set to $PRICE_SIGNER_ETH"
else
  ok "PRICE_SIGNER_ETH unset — skipping protocol init (assuming already configured)"
fi

# ---- 4. stack up + healthy ----------------------------------------------------------
say "docker stack"
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.devnet.yml --env-file deploy/.env up -d --build >/dev/null
say "waiting for health (game-server price feed + chain-worker RPC/signer)"
for _ in $(seq 1 60); do
  gs="$(curl -s --max-time 4 "$GAME_SERVER_URL/healthz" 2>/dev/null || echo '{}')"
  cw="$(curl -s --max-time 4 "$CHAIN_WORKER_URL/healthz" 2>/dev/null || echo '{}')"
  echo "$gs" | grep -q '"price_fresh":true' && echo "$cw" | grep -q '"rpc":true' && break
  sleep 2
done
echo "$gs" | grep -q '"price_fresh":true' || die "game-server not price-fresh: $gs"
echo "$cw" | grep -q '"rpc":true'          || die "chain-worker RPC down: $cw"
echo "$cw" | grep -q '"signer_lamports":0' && die "chain-worker signer has 0 SOL: $cw"
ok "game-server: $gs"
ok "chain-worker: $cw"

# ---- 5. run the e2e suite -----------------------------------------------------------
say "building + running the e2e suite"
export GAME_SERVER_URL SOLANA_RPC_URL="$RPC" CHIPS_TOKEN_MINT="$MINT" BUY_IN
export PLAYER1_KEYPAIR="$KEYDIR/player1.json" PLAYER2_KEYPAIR="$KEYDIR/player2.json"
export PLAYER3_KEYPAIR="$KEYDIR/player3.json" ATTACKER_KEYPAIR="$KEYDIR/attacker.json"
# Admin token for the API admin endpoints (first entry of ADMIN_TOKENS).
export ADMIN_TOKEN="${ADMIN_TOKEN:-$(printf '%s' "${ADMIN_TOKENS:-}" | cut -d, -f1 | tr -d ' ')}"
export E2E_SCENARIOS="${E2E_SCENARIOS:-all}"
cargo run -q -p syndicate-e2e --bin e2e-devnet --release

# ---- 6. optional load sanity --------------------------------------------------------
if [ "${RUN_LOAD:-0}" = "1" ]; then
  say "ws load sanity (${CONNECTIONS:-1000} connections)"
  CONNECTIONS="${CONNECTIONS:-1000}" HOLD_SEC="${HOLD_SEC:-30}" \
    cargo run -q -p syndicate-e2e --bin load-sanity --release
fi

say "DONE — e2e suite passed"
