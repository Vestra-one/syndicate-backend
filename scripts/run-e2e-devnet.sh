#!/usr/bin/env bash
# Syndicate devnet E2E test runner
# Usage:  ./scripts/run-e2e-devnet.sh [--player2 /path/to/player2.json]
#
# Runs the full flow:
#   create_and_deposit (on-chain, Player 1)
#   → POST /rooms           (matchmaking: verify + register)
#   → deposit (on-chain, Player 2)
#   → POST /matches/:id/deposits  (matchmaking: verify + seat)
#   → GET /rooms/:roomCode        (lobby check)
#   → WebSocket auth (both players)

set -euo pipefail

# ─── colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
info() { echo -e "${CYAN}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
hdr()  { echo -e "\n${CYAN}--- $* ---${NC}"; }

# ─── configuration ───────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SYNDICATE_PROGRAM_ID="${SYNDICATE_PROGRAM_ID:-GhbHLYTHuSvCVhYM22wyjdoE6Nx5uQDNuBB2Wof4p2bF}"
CHIPS_TOKEN_MINT="${CHIPS_TOKEN_MINT:-3Gdd9ew2Dq63QeJETc7krKB2JJ1GaHfBZvMzBdAy541X}"
MATCHMAKING_URL="${MATCHMAKING_URL:-https://matchmaking.devnet.satoshitable.fun}"
GATEWAY_URL="${GATEWAY_URL:-wss://gateway.devnet.satoshitable.fun}"
SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
BUY_IN="${BUY_IN:-1000000}"   # 1 USDC (6 decimals)
AWAIT_SEAL="${AWAIT_SEAL:-}"  # set to 1 to wait for the ~10-min seal window + settlement

PLAYER1_KEYPAIR="${PLAYER1_KEYPAIR:-$HOME/.config/solana/id.json}"
PLAYER2_KEYPAIR="${PLAYER2_KEYPAIR:-/tmp/player2.json}"
BASIC_AUTH="${BASIC_AUTH:-}"  # dev:password  — set via env or prompted below

# parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --player2)     PLAYER2_KEYPAIR="$2"; shift 2;;
    --player1)     PLAYER1_KEYPAIR="$2"; shift 2;;
    --auth)        BASIC_AUTH="$2"; shift 2;;
    --mint)        CHIPS_TOKEN_MINT="$2"; shift 2;;
    --rpc)         SOLANA_RPC_URL="$2"; shift 2;;
    --await-seal)  AWAIT_SEAL=1; shift;;
    *) echo "Unknown flag: $1"; exit 1;;
  esac
done

echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Syndicate devnet E2E test runner           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"

# ─── prompt for auth if not set ─────────────────────────────────────────────
if [[ -z "$BASIC_AUTH" ]]; then
  echo -n "Basic Auth (dev:password): "
  read -rs BASIC_AUTH
  echo
fi

# ─── prerequisite checks ────────────────────────────────────────────────────
hdr "Prerequisites"

command -v node   >/dev/null 2>&1 || fail "node not found"
command -v curl   >/dev/null 2>&1 || fail "curl not found"
command -v solana >/dev/null 2>&1 || fail "solana CLI not found"
ok "node $(node --version), curl, solana CLI"

[[ -f "$PLAYER1_KEYPAIR" ]] || fail "Player 1 keypair not found: $PLAYER1_KEYPAIR"
[[ -f "$PLAYER2_KEYPAIR" ]] || fail "Player 2 keypair not found: $PLAYER2_KEYPAIR"
ok "Keypair files exist"

# node_modules symlink so the TS script can resolve @solana/web3.js
SCRIPT_NM="$REPO_ROOT/scripts/node_modules"
SC_NM="$REPO_ROOT/services/settlement-chain/node_modules"
if [[ ! -e "$SCRIPT_NM" ]]; then
  [[ -d "$SC_NM" ]] || fail "Run 'npm install' in services/settlement-chain first"
  ln -sf "$SC_NM" "$SCRIPT_NM"
  ok "Linked node_modules → services/settlement-chain/node_modules"
else
  ok "node_modules symlink already present"
fi

# ─── configuration summary ──────────────────────────────────────────────────
hdr "Configuration"
info "Program ID:      $SYNDICATE_PROGRAM_ID"
info "Chips mint:      $CHIPS_TOKEN_MINT"
info "Matchmaking URL: $MATCHMAKING_URL"
info "Gateway URL:     $GATEWAY_URL"
info "Buy-in:          $BUY_IN (raw units)"
info "Player 1:        $PLAYER1_KEYPAIR"
info "Player 2:        $PLAYER2_KEYPAIR"
info "RPC:             $SOLANA_RPC_URL"
info "Await seal:      ${AWAIT_SEAL:-no} (--await-seal to wait for the ~10-min seal + settlement)"

# ─── health checks (curl) ───────────────────────────────────────────────────
hdr "Health checks"

check_health() {
  local name="$1" url="$2" auth="${3:-}"
  local code
  if [[ -n "$auth" ]]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" --user "$auth" "$url" 2>&1)
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>&1)
  fi
  if [[ "$code" == "200" ]]; then
    ok "$name ($url) → HTTP $code"
  else
    warn "$name ($url) → HTTP $code (non-fatal)"
  fi
}

# matchmaking is required — fail fast if it's not up
code=$(curl -s -o /dev/null -w "%{http_code}" --user "$BASIC_AUTH" "$MATCHMAKING_URL/healthz" 2>&1)
if [[ "$code" == "200" ]]; then
  ok "matchmaking ($MATCHMAKING_URL/healthz) → HTTP $code"
else
  fail "matchmaking returned HTTP $code — is the container running? Run: \$COMPOSE_APP up -d matchmaking"
fi
check_health "config"       "https://config.devnet.satoshitable.fun/healthz" "$BASIC_AUTH"
check_health "action-feed"  "https://api.devnet.satoshitable.fun/healthz"   "$BASIC_AUTH"
check_health "price-feed"   "https://price.devnet.satoshitable.fun/health"  ""

# ─── balance checks (solana CLI) ────────────────────────────────────────────
hdr "Wallet balances"

P1_SOL=$(solana balance "$PLAYER1_KEYPAIR" --url "$SOLANA_RPC_URL" 2>/dev/null || echo "error")
P2_SOL=$(solana balance "$PLAYER2_KEYPAIR" --url "$SOLANA_RPC_URL" 2>/dev/null || echo "error")
info "Player 1 SOL: $P1_SOL"
info "Player 2 SOL: $P2_SOL"

P1_TOK=$(spl-token balance --owner "$PLAYER1_KEYPAIR" --url "$SOLANA_RPC_URL" "$CHIPS_TOKEN_MINT" 2>/dev/null || echo "unknown")
P2_TOK=$(spl-token balance --owner "$PLAYER2_KEYPAIR" --url "$SOLANA_RPC_URL" "$CHIPS_TOKEN_MINT" 2>/dev/null || echo "unknown")
info "Player 1 tokens: $P1_TOK"
info "Player 2 tokens: $P2_TOK"

# ─── run the TypeScript E2E test ─────────────────────────────────────────────
hdr "Running TypeScript E2E test"
info "All on-chain tx building, submission, and API calls run via scripts/e2e-devnet-test.ts"

RESULT_FILE=$(mktemp /tmp/e2e-result-XXXXXX)

export SYNDICATE_PROGRAM_ID CHIPS_TOKEN_MINT MATCHMAKING_URL GATEWAY_URL SOLANA_RPC_URL BUY_IN AWAIT_SEAL
export PLAYER1_KEYPAIR PLAYER2_KEYPAIR BASIC_AUTH

set +e
node "$REPO_ROOT/scripts/e2e-devnet-test.ts" 2>&1 | tee "$RESULT_FILE"
TS_EXIT=${PIPESTATUS[0]}
set -e

# ─── parse results from log ──────────────────────────────────────────────────
hdr "Results"

extract() { grep -o "$1[^\"]*" "$RESULT_FILE" | head -1 | sed "s/$1//" || true; }

CREATE_TX=$(grep "create_and_deposit confirmed" "$RESULT_FILE" | grep -o '[A-Za-z0-9]\{80,\}' | head -1 || true)
DEPOSIT_TX=$(grep "deposit confirmed"           "$RESULT_FILE" | grep -o '[A-Za-z0-9]\{80,\}' | head -1 || true)
MATCH_PDA=$(grep "Match on-chain:"              "$RESULT_FILE" | awk '{print $NF}' || true)
ROOM_CODE=$(grep "Room code:"                   "$RESULT_FILE" | awk '{print $NF}' || true)

if [[ $TS_EXIT -eq 0 ]]; then
  echo ""
  ok "E2E test PASSED"
  echo ""
  echo "  Match PDA:   $MATCH_PDA"
  echo "  Room code:   $ROOM_CODE"
  [[ -n "$CREATE_TX" ]] && echo "  Create tx:   https://explorer.solana.com/tx/${CREATE_TX}?cluster=devnet"
  [[ -n "$DEPOSIT_TX" ]] && echo "  Deposit tx:  https://explorer.solana.com/tx/${DEPOSIT_TX}?cluster=devnet"
  [[ -n "$MATCH_PDA" ]] && echo "  Match acct:  https://explorer.solana.com/address/${MATCH_PDA}?cluster=devnet"
  echo ""
  echo "  Phases covered:"
  echo "    ✓ Phase 1 — On-chain: create_and_deposit + deposit (finalized)"
  echo "    ✓ Phase 2 — Matchmaking: POST /rooms, POST /matches/:id/deposits, lobby"
  echo "    ✓ Phase 3 — Match start: POST /rooms/:roomCode/start → orchestrator → begin_live"
  echo "    ✓ Phase 4 — WebSocket: auth + subscribe + matchState LIVE"
  echo "    ✓ Phase 5 — Betting: signed call action sent, default policy registered"
  echo "    ✓ Phase 6 — Reconnection: disconnect, re-auth, re-subscribe, receive state"
  if [[ -n "$AWAIT_SEAL" ]]; then
    echo "    ✓ Phase 7 — Sealing: sealPrediction sent for both players (AWAIT_SEAL=1)"
  else
    echo "    ~ Phase 7 — Sealing: requires ~10 min (run with --await-seal)"
    echo "      Seal window: fill_deadline + 580s from match creation"
    echo "      Re-run:  AWAIT_SEAL=1 BASIC_AUTH=\"$BASIC_AUTH\" bash scripts/run-e2e-devnet.sh"
  fi
else
  echo ""
  fail "E2E test FAILED (exit $TS_EXIT) — see output above"
fi

rm -f "$RESULT_FILE"
