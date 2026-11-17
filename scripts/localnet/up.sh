#!/usr/bin/env bash
#
# Bring up the WHOLE Syndicate v2 stack on one machine, fully offline:
#
#   solana-test-validator (program preloaded at the declared id)
#   + chips mint, funded operator + e2e player wallets, protocol initialized
#   + Postgres (migrated) + mock signed-price server + game-server + chain-worker
#
# No devnet RPC, no drand, no exchange feed, no Docker. Timelock runs in MOCK mode
# (TIMELOCK_OPEN_MODE=mock) — fine for development and CI, never for real money.
#
#   scripts/localnet/up.sh                 # start everything, print endpoints
#   scripts/localnet/e2e.sh                # run the lifecycle suite against it
#   scripts/localnet/down.sh               # stop everything
#
# State (ledger, logs, keys, pids, env) lives in $LOCALNET_DIR (default: .localnet/).
#
# Prereqs: solana CLI ≥ 2.x (solana-test-validator, spl-token), cargo, node ≥ 20, psql,
# and a Postgres superuser connection. PG_SUPER_URL picks one explicitly; otherwise a local
# server on :5432 is tried as `postgres` and as the current OS user (Homebrew's default),
# and failing that a throwaway `postgres:16` Docker container is started on :55432.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/localnet"
STATE="${LOCALNET_DIR:-$ROOT/.localnet}"
mkdir -p "$STATE"/{keys,logs,pids}

RPC_PORT="${RPC_PORT:-8899}"
RPC="http://127.0.0.1:$RPC_PORT"
GAME_PORT="${GAME_PORT:-18080}"
WORKER_PORT="${WORKER_PORT:-18084}"
PRICE_PORT="${PRICE_PORT:-18088}"
PG_SUPER_URL="${PG_SUPER_URL:-}"
PG_DB="${PG_DB:-syndicate_localnet}"
PG_USER="${PG_USER:-syndicate}"
PG_PASS="${PG_PASS:-localnet}"
PG_CONTAINER="syndicate-localnet-pg"
ADMIN_TOKEN="${ADMIN_TOKEN:-e2e-admin-token-lolol}"
PROGRAM_ID="$(sed -n 's/^declare_id!("\(.*\)");.*/\1/p' "$ROOT/services/programs/programs/syndicate_program/src/lib.rs" | head -1)"
PROGRAM_SO="$ROOT/services/programs/target/deploy/syndicate_program.so"
# Deterministic localnet-only price key (address 0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a).
PRICE_KEY="${PRICE_KEY:-1111111111111111111111111111111111111111111111111111111111111111}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

for bin in solana solana-test-validator solana-keygen spl-token cargo node psql curl; do
  command -v "$bin" >/dev/null || die "missing $bin on PATH"
done
[ -n "$PROGRAM_ID" ] || die "could not read declare_id! from the program source"

# Start a detached background service, recording its pid.
spawn() { # name, command...
  local name="$1"; shift
  if [ -f "$STATE/pids/$name" ] && kill -0 "$(cat "$STATE/pids/$name")" 2>/dev/null; then
    ok "$name already running (pid $(cat "$STATE/pids/$name"))"; return
  fi
  nohup "$@" >"$STATE/logs/$name.log" 2>&1 &
  echo $! >"$STATE/pids/$name"
  ok "$name started (pid $!, log $STATE/logs/$name.log)"
}

wait_http() { # url, grep-pattern, label
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 3 "$1" 2>/dev/null | grep -q "$2"; then ok "$3 healthy"; return; fi
    sleep 1
  done
  die "$3 never became healthy ($1) — see $STATE/logs"
}

# ---- 1. program ------------------------------------------------------------------------
say "program"
if [ ! -f "$PROGRAM_SO" ] || [ -n "${REBUILD_PROGRAM:-}" ]; then
  (cd "$ROOT/services/programs" && cargo build-sbf --tools-version v1.53 -- -p syndicate-program)
fi
[ -f "$PROGRAM_SO" ] || die "program build produced no $PROGRAM_SO"
ok "$PROGRAM_ID ← $(basename "$PROGRAM_SO")"

# ---- 2. validator ----------------------------------------------------------------------
say "validator"
spawn validator solana-test-validator --reset --quiet \
  --ledger "$STATE/ledger" --rpc-port "$RPC_PORT" --bind-address 127.0.0.1 \
  --bpf-program "$PROGRAM_ID" "$PROGRAM_SO"
for _ in $(seq 1 60); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break; sleep 1
done
solana cluster-version --url "$RPC" >/dev/null 2>&1 || die "validator RPC never came up"
ok "RPC $RPC"

# ---- 3. wallets + chips mint -----------------------------------------------------------
say "wallets + chips"
keygen() { [ -f "$1" ] || solana-keygen new --no-bip39-passphrase --silent -o "$1" >/dev/null; }
OPERATOR="$STATE/keys/operator.json"
keygen "$OPERATOR"
mkdir -p "$ROOT/deploy/e2e-keys"
PLAYERS=(player1 player2 player3 attacker)
for p in "${PLAYERS[@]}"; do keygen "$ROOT/deploy/e2e-keys/$p.json"; done

sol() { solana "$@" --url "$RPC" --keypair "$OPERATOR"; }
spl() { spl-token "$@" --url "$RPC" --fee-payer "$OPERATOR"; }

sol airdrop 500 "$(solana-keygen pubkey "$OPERATOR")" >/dev/null
MINT_FILE="$STATE/keys/chips-mint.json"
keygen "$MINT_FILE"
MINT="$(solana-keygen pubkey "$MINT_FILE")"
# --reset wiped the ledger, so the mint always needs (re)creating.
spl create-token "$MINT_FILE" --decimals 6 --mint-authority "$OPERATOR" >/dev/null
ok "chips mint $MINT (6 decimals)"

# Extra wallets to fund (e.g. the browser test wallets): space-separated pubkeys.
EXTRA_WALLETS="${EXTRA_WALLETS:-}"
fund() { # pubkey, label
  sol airdrop 20 "$1" >/dev/null
  spl create-account "$MINT" --owner "$1" >/dev/null 2>&1 || true
  local ata
  ata="$(spl address --token "$MINT" --owner "$1" --verbose | awk '/Associated token address:/{print $NF}')"
  spl mint "$MINT" "${FUND_CHIPS_UI:-1000}" "$ata" --mint-authority "$OPERATOR" >/dev/null
  ok "$2 $1 funded (20 SOL, ${FUND_CHIPS_UI:-1000} chips)"
}
for p in "${PLAYERS[@]}"; do fund "$(solana-keygen pubkey "$ROOT/deploy/e2e-keys/$p.json")" "$p"; done
for w in $EXTRA_WALLETS; do fund "$w" "extra"; done

# ---- 4. price server + protocol init ---------------------------------------------------
say "mock signed-price server"
[ -d "$HERE/node_modules" ] || (cd "$HERE" && npm install --silent)
PRICE_SIGNER_ETH="$(ECDSA_PRIVATE_KEY="$PRICE_KEY" node "$HERE/mock-price-server.mjs" --address)"
spawn price-server env ECDSA_PRIVATE_KEY="$PRICE_KEY" PORT="$PRICE_PORT" node "$HERE/mock-price-server.mjs"
wait_http "http://127.0.0.1:$PRICE_PORT/health" '"ok":true' "price server"

say "protocol"
(cd "$ROOT" && cargo run -q -p syndicate-chain --features rpc --bin init-protocol -- \
  init --rpc-url "$RPC" --program-id "$PROGRAM_ID" --price-signer "$PRICE_SIGNER_ETH" \
  --keypair "$OPERATOR" --fill-window-min-sec 20 --betting-duration-min-sec 30)
ok "protocol initialized (price signer $PRICE_SIGNER_ETH)"

# ---- 5. database -----------------------------------------------------------------------
say "postgres"
# -w: never prompt for a password (a candidate that needs one must fail, not hang).
pg_ok() { PGCONNECT_TIMEOUT=3 psql -w "$1" -qtAc "SELECT 1" </dev/null >/dev/null 2>&1; }
if [ -n "$PG_SUPER_URL" ]; then
  pg_ok "$PG_SUPER_URL" || die "cannot reach Postgres at PG_SUPER_URL=$PG_SUPER_URL"
else
  for cand in \
    "postgres://postgres@127.0.0.1:5432/postgres" \
    "postgres://postgres:postgres@127.0.0.1:5432/postgres" \
    "postgres://$(id -un)@127.0.0.1:5432/postgres"; do
    if pg_ok "$cand"; then PG_SUPER_URL="$cand"; break; fi
  done
fi
if [ -z "$PG_SUPER_URL" ] && command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=localnet -p 127.0.0.1:55432:5432 postgres:16 >/dev/null
  PG_SUPER_URL="postgres://postgres:localnet@127.0.0.1:55432/postgres"
  for _ in $(seq 1 60); do pg_ok "$PG_SUPER_URL" && break; sleep 1; done
  pg_ok "$PG_SUPER_URL" || die "the Postgres container never became ready"
  ok "started Docker Postgres ($PG_CONTAINER on :55432)"
fi
[ -n "$PG_SUPER_URL" ] || die "no Postgres found: start one on :5432, set PG_SUPER_URL, or start Docker"
PG_HOSTPORT="$(printf '%s' "$PG_SUPER_URL" | sed -E 's#^[a-z]+://([^@/]*@)?([^/]+)/.*#\2#')"
DATABASE_URL="postgres://$PG_USER:$PG_PASS@$PG_HOSTPORT/$PG_DB"
psql "$PG_SUPER_URL" -q -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS $PG_DB WITH (FORCE);
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$PG_USER') THEN
    CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PASS';
  ELSE
    ALTER ROLE $PG_USER LOGIN PASSWORD '$PG_PASS';
  END IF;
END \$\$;
CREATE DATABASE $PG_DB OWNER $PG_USER;
SQL
DATABASE_URL="$DATABASE_URL" "$ROOT/scripts/db-migrate.sh" | tail -1
ok "database $PG_DB (fresh — the ledger was reset too)"

# ---- 6. env file (shared by services + e2e + frontend) ---------------------------------
cat >"$STATE/env" <<ENV
APP_ENV=localnet
LOG_LEVEL=${LOG_LEVEL:-info}
DATABASE_URL=$DATABASE_URL
SOLANA_RPC_URL_PRIMARY=$RPC
SOLANA_RPC_URL=$RPC
SYNDICATE_PROGRAM_ID=$PROGRAM_ID
CHIPS_TOKEN_MINT=$MINT
CHIPS_TOKEN_MINTS=$MINT
SIGNED_PRICE_SERVER_URL=http://127.0.0.1:$PRICE_PORT
ADMIN_TOKENS=$ADMIN_TOKEN
ADMIN_TOKEN=$ADMIN_TOKEN
CORS_ALLOWED_ORIGINS=*
GEOFENCE_BLOCKLIST=XX
GAME_SERVER_PORT=$GAME_PORT
GAME_SERVER_URL=http://127.0.0.1:$GAME_PORT
CHAIN_WORKER_PORT=$WORKER_PORT
OPERATOR_KEYPAIR_PATH=$OPERATOR
TIMELOCK_OPEN_MODE=mock
E2E_SEAL_MODE=mock
MIN_SIGNER_SOL=0.5
PLAYER1_KEYPAIR=$ROOT/deploy/e2e-keys/player1.json
PLAYER2_KEYPAIR=$ROOT/deploy/e2e-keys/player2.json
PLAYER3_KEYPAIR=$ROOT/deploy/e2e-keys/player3.json
ATTACKER_KEYPAIR=$ROOT/deploy/e2e-keys/attacker.json
ENV
set -a; . "$STATE/env"; set +a

# ---- 7. backend services ---------------------------------------------------------------
say "backend services"
(cd "$ROOT" && cargo build -q -p syndicate-game-server -p syndicate-chain-worker)
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}/debug"
spawn chain-worker "$TARGET/syndicate-chain-worker"
spawn game-server "$TARGET/syndicate-game-server"
wait_http "http://127.0.0.1:$GAME_PORT/healthz" '"price_fresh":true' "game-server"
wait_http "http://127.0.0.1:$WORKER_PORT/healthz" '"rpc":true' "chain-worker"

cat <<DONE

localnet is up.
  REST        http://127.0.0.1:$GAME_PORT/v1
  WebSocket   ws://127.0.0.1:$GAME_PORT/v1/ws
  Price       http://127.0.0.1:$PRICE_PORT   (ws://127.0.0.1:$PRICE_PORT/ws)
  Solana RPC  $RPC
  Program     $PROGRAM_ID
  Chips mint  $MINT
  env         $STATE/env

Frontend (.env.local in syn-front):
  VITE_API_URL=http://127.0.0.1:$GAME_PORT/v1
  VITE_WS_URL=ws://127.0.0.1:$GAME_PORT/v1/ws
  VITE_PRICE_WS_URL=ws://127.0.0.1:$PRICE_PORT/ws
  VITE_SOLANA_RPC_URL=$RPC
  VITE_PROGRAM_ID=$PROGRAM_ID
  VITE_CHIPS_TOKEN_MINT=$MINT

Next: scripts/localnet/e2e.sh
DONE
