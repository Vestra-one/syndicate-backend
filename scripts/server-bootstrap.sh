#!/usr/bin/env bash
# Bring a blank Ubuntu/Debian server to a running Satoshi Table backend on Solana devnet:
# toolchain → keys → program deploy → protocol init → chips mint → stack + house bots → TLS.
#
# Run as root from the repo root on the server (scripts/deploy-remote.sh does this from
# your machine). Safe to re-run: every step checks whether it is already done.
#
#   DOMAIN=devnet.satoshitable.fun   api.$DOMAIN and price.$DOMAIN must point at this server
#   SOLANA_RPC_URL=<devnet rpc>      default https://api.devnet.solana.com (a keyed RPC is
#                                    more reliable from a datacenter IP)
#   TLS_EMAIL=you@example.com        certbot registration
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DOMAIN="${DOMAIN:-devnet.satoshitable.fun}"
RPC="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
TLS_EMAIL="${TLS_EMAIL:-ops@satoshitable.fun}"
SOLANA_VERSION="${SOLANA_VERSION:-v3.1.5}"
SECRETS=deploy/secrets
OPERATOR=$SECRETS/operator-keypair.json
PROGRAM_KEYPAIR=services/programs/keys/syndicate_program_v2-keypair.json
MINT_KEYPAIR=$SECRETS/chips-mint.json
NEED_SOL="${NEED_SOL:-7}"   # program rent (~3.5) is held twice while the deploy is in flight

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   ok  %s\n' "$*"; }

# SKIP_SYSTEM=1 leaves packages, firewall, toolchain and nginx alone; SKIP_STACK=1 stops
# before docker. Both exist so the chain half of this script can be rehearsed on a laptop.
[ "${SKIP_SYSTEM:-0}" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$PROGRAM_KEYPAIR" ] || { echo "missing $PROGRAM_KEYPAIR (it is not in git — deploy-remote.sh copies it)"; exit 1; }

# ---- 1. packages ------------------------------------------------------------------------
if [ "${SKIP_SYSTEM:-0}" != 1 ]; then
say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
EDGE_PKGS="nginx certbot python3-certbot-nginx"
[ -z "${EDGE_NETWORK:-}" ] || EDGE_PKGS="" # shared edge: the other project's nginx serves us
apt-get install -y -qq curl git jq rsync python3 build-essential pkg-config libssl-dev \
  libudev-dev protobuf-compiler $EDGE_PKGS ufw >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null
ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "docker $(docker --version | awk '{print $3}' | tr -d ,), nginx, certbot, firewall (22/80/443)"

# ---- 2. toolchain -----------------------------------------------------------------------
say "toolchain"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
command -v cargo >/dev/null || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
command -v solana >/dev/null || sh -c "$(curl -sSfL "https://release.anza.xyz/$SOLANA_VERSION/install")" >/dev/null
ok "$(cargo --version), $(solana --version | cut -d' ' -f1-2)"
fi

# ---- 3. secrets -------------------------------------------------------------------------
say "secrets"
mkdir -p "$SECRETS"
[ -f $SECRETS/postgres-password ]   || openssl rand -hex 24 >$SECRETS/postgres-password
[ -f $SECRETS/session-signing-key ] || openssl rand -hex 32 >$SECRETS/session-signing-key
[ -f $SECRETS/price-signer.key ]    || openssl rand -hex 32 >$SECRETS/price-signer.key
[ -f "$OPERATOR" ]     || solana-keygen new --no-bip39-passphrase --silent -o "$OPERATOR" >/dev/null
[ -f "$MINT_KEYPAIR" ] || solana-keygen new --no-bip39-passphrase --silent -o "$MINT_KEYPAIR" >/dev/null
# Read by unprivileged in-container users, so world-readable inside a root-only directory.
chmod 644 $SECRETS/postgres-password $SECRETS/session-signing-key $SECRETS/price-signer.key "$OPERATOR"
chmod 700 "$SECRETS"
OPERATOR_PUB="$(solana-keygen pubkey "$OPERATOR")"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
MINT="$(solana-keygen pubkey "$MINT_KEYPAIR")"
PRICE_SIGNER_ETH="$(python3 scripts/eth-address.py $SECRETS/price-signer.key)"
grep -q "$PROGRAM_ID" services/programs/programs/syndicate_program/src/lib.rs ||
  { echo "program keypair ($PROGRAM_ID) does not match declare_id! in the source"; exit 1; }
ok "operator $OPERATOR_PUB"
ok "program  $PROGRAM_ID"
ok "price signer $PRICE_SIGNER_ETH"

# ---- 4. devnet SOL ----------------------------------------------------------------------
say "funding the operator"
balance() { solana balance "$OPERATOR_PUB" --url "$RPC" 2>/dev/null | awk '{print int($1)}'; }
deployed() { solana program show "$PROGRAM_ID" --url "$RPC" --keypair "$OPERATOR" >/dev/null 2>&1; }
deployed && NEED_SOL=3
while [ "$(balance || echo 0)" -lt "$NEED_SOL" ]; do
  solana airdrop 2 "$OPERATOR_PUB" --url "$RPC" >/dev/null 2>&1 || true
  [ "$(balance || echo 0)" -ge "$NEED_SOL" ] && break
  echo "   operator has $(balance || echo '?') SOL, needs $NEED_SOL."
  echo "   Send devnet SOL to  $OPERATOR_PUB  (https://faucet.solana.com) — waiting…"
  sleep 20
done
ok "operator balance $(balance) SOL"

# ---- 5. program -------------------------------------------------------------------------
say "program"
if deployed; then
  ok "already deployed"
else
  (cd services/programs && cargo build-sbf --tools-version v1.53 -- -p syndicate-program 2>&1 | tail -1)
  for attempt in 1 2 3 4; do
    solana program deploy --url "$RPC" --keypair "$OPERATOR" --program-id "$PROGRAM_KEYPAIR" \
      --max-sign-attempts 60 services/programs/target/deploy/syndicate_program.so && break
    echo "   deploy attempt $attempt failed; retrying in 15s"
    sleep 15
  done
  deployed || { echo "program deploy did not land — re-run this script"; exit 1; }
  ok "deployed $PROGRAM_ID"
fi

if [ ! -f $SECRETS/.protocol-initialized ]; then
  cargo run -q ${CARGO_PROFILE---release} -p syndicate-chain --features rpc --bin init-protocol -- init \
    --rpc-url "$RPC" --program-id "$PROGRAM_ID" --price-signer "$PRICE_SIGNER_ETH" \
    --keypair "$OPERATOR"
  touch $SECRETS/.protocol-initialized
fi
ok "protocol initialized (every role = operator; price signer registered)"

# ---- 6. chips mint ----------------------------------------------------------------------
say "chips mint"
spl() { spl-token --url "$RPC" --fee-payer "$OPERATOR" "$@"; }
spl display "$MINT" >/dev/null 2>&1 ||
  spl create-token "$MINT_KEYPAIR" --decimals 6 --mint-authority "$OPERATOR_PUB" >/dev/null
spl create-account "$MINT" --owner "$OPERATOR_PUB" >/dev/null 2>&1 || true
TREASURY="$(spl address --token "$MINT" --owner "$OPERATOR_PUB" --verbose | awk '/Associated token address:/{print $NF}')"
ok "mint $MINT (6 decimals, authority = operator), treasury $TREASURY"

# Test-chips faucet: a separate low-value wallet the game-server pays visitors from, so the
# operator key never leaves the chain-worker.
FAUCET=$SECRETS/faucet/faucet-keypair.json
mkdir -p $SECRETS/faucet
[ -f "$FAUCET" ] || solana-keygen new --no-bip39-passphrase --silent -o "$FAUCET" >/dev/null
chmod 755 $SECRETS/faucet && chmod 644 "$FAUCET"
FAUCET_PUB="$(solana-keygen pubkey "$FAUCET")"
faucet_sol() { solana balance "$FAUCET_PUB" --url "$RPC" 2>/dev/null | awk '{print int($1 * 100)}'; }
[ "$(faucet_sol || echo 0)" -ge 50 ] ||
  solana transfer "$FAUCET_PUB" 1 --url "$RPC" --keypair "$OPERATOR" --allow-unfunded-recipient >/dev/null
spl create-account "$MINT" --owner "$FAUCET_PUB" >/dev/null 2>&1 || true
FAUCET_ATA="$(spl address --token "$MINT" --owner "$FAUCET_PUB" --verbose | awk '/Associated token address:/{print $NF}')"
FAUCET_CHIPS_HELD="$(spl balance --address "$FAUCET_ATA" 2>/dev/null | awk '{print int($1)}')"
[ "${FAUCET_CHIPS_HELD:-0}" -ge 100000 ] ||
  spl mint "$MINT" 1000000 "$FAUCET_ATA" --mint-authority "$OPERATOR" >/dev/null
ok "faucet $FAUCET_PUB (100 test chips per visitor per hour)"

# ---- 7. deploy/.env ---------------------------------------------------------------------
say "deploy/.env"
[ -f deploy/.env ] || cp deploy/.env.example deploy/.env
setenv() { # KEY VALUE — replace the line or append it
  local val
  val="$(printf '%s' "$2" | sed -e 's/[&|\\]/\\&/g')" # keep & and | in URLs literal
  if grep -qE "^$1=" deploy/.env; then
    sed -i -E "s|^$1=.*|$1=$val|" deploy/.env
  else
    printf '%s=%s\n' "$1" "$2" >>deploy/.env
  fi
}
setenv APP_ENV devnet
setenv DOMAIN "$DOMAIN"
setenv SOLANA_RPC_URL_PRIMARY "$RPC"
setenv SYNDICATE_PROGRAM_ID "$PROGRAM_ID"
setenv CHIPS_TOKEN_MINT "$MINT"
setenv CHIPS_TOKEN_MINTS "$MINT"
setenv TREASURY_TOKEN_ACCOUNT "$TREASURY"
setenv GEOFENCE_BLOCKLIST ""   # devnet chips have no value; nobody is blocked
setenv CORS_ALLOWED_ORIGINS "https://satoshitable.fun,https://www.satoshitable.fun,http://localhost:5173"
setenv TLS_EMAIL "$TLS_EMAIL"
setenv FAUCET_KEYPAIR_PATH /run/faucet/faucet-keypair.json
[ -z "${EDGE_NETWORK:-}" ] || setenv EDGE_NETWORK "$EDGE_NETWORK"
grep -qE '^ADMIN_TOKENS=.+' deploy/.env && ! grep -qE '^ADMIN_TOKENS=\s*#' deploy/.env ||
  setenv ADMIN_TOKENS "$(openssl rand -hex 24)"
chmod 600 deploy/.env
ok "written"

# ---- 8. house bots + stack --------------------------------------------------------------
say "house bots"
SOL_EACH="${SOL_EACH:-0.3}" CHIPS_EACH="${CHIPS_EACH:-500}" FUND=1 \
  bash scripts/house-bots-setup.sh | sed 's/^/   /'

[ "${SKIP_STACK:-0}" = 1 ] && { say "stopping before the stack (SKIP_STACK=1)"; exit 0; }

say "stack"
bash scripts/deploy-devnet.sh 2>&1 | tail -15 | sed 's/^/   /'
curl -sf http://127.0.0.1:18080/healthz >/dev/null && ok "game-server healthy" ||
  { echo "game-server is not healthy — docker compose logs game-server"; exit 1; }

# ---- 9. edge + TLS ----------------------------------------------------------------------
say "edge"
if [ -n "${EDGE_NETWORK:-}" ]; then
  ok "shared edge: on docker network $EDGE_NETWORK as satoshi-game-server / satoshi-price-server"
  echo "   Install deploy/nginx/syndicate-v2-docker-edge.conf into that network's nginx (see its header)."
else
sed -E "s/api\.devnet\.satoshitable\.fun/api.$DOMAIN/; s/price\.devnet\.satoshitable\.fun/price.$DOMAIN/" \
  deploy/nginx/syndicate-v2-host.conf >/etc/nginx/sites-available/satoshi-table
ln -sf /etc/nginx/sites-available/satoshi-table /etc/nginx/sites-enabled/satoshi-table
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 && systemctl reload nginx
MY_IP="$(curl -4 -s --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')"
DNS_IP="$(getent ahostsv4 "api.$DOMAIN" | awk 'NR==1{print $1}')"
if [ -e "/etc/letsencrypt/live/api.$DOMAIN" ]; then
  ok "TLS already issued"
elif [ "$DNS_IP" = "$MY_IP" ]; then
  certbot --nginx -d "api.$DOMAIN" -d "price.$DOMAIN" --non-interactive --agree-tos -m "$TLS_EMAIL" --redirect >/dev/null
  ok "TLS issued for api.$DOMAIN and price.$DOMAIN"
else
  echo "   DNS: api.$DOMAIN → ${DNS_IP:-nothing}, this server is $MY_IP."
  echo "   Point api.$DOMAIN and price.$DOMAIN (A records) at $MY_IP, then re-run this script for TLS."
fi
fi

say "done"
cat <<SUMMARY
   API        https://api.$DOMAIN/v1   (ws: wss://api.$DOMAIN/v1/ws)
   Prices     wss://price.$DOMAIN/ws
   Program    $PROGRAM_ID
   Chips mint $MINT
   Operator   $OPERATOR_PUB   (keep it above 1 SOL)

   Frontend build env (Netlify):
     VITE_API_URL=https://api.$DOMAIN/v1
     VITE_WS_URL=wss://api.$DOMAIN/v1/ws
     VITE_PRICE_WS_URL=wss://price.$DOMAIN/ws
     VITE_SOLANA_RPC_URL=$RPC
     VITE_PROGRAM_ID=$PROGRAM_ID
     VITE_CHIPS_TOKEN_MINT=$MINT

   Bots: docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f house-bots
SUMMARY
