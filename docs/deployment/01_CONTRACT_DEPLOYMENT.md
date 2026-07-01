# 01 — Solana Contract Deployment (devnet / testnet / mainnet)

> Audience: an operator who can copy/paste commands. Follow steps **in order**.
> Every command is meant to be run exactly as written unless a line says `# EDIT:`.

This guide deploys the Syndicate Anchor program (`services/programs`) and runs the one-time
`initialize_protocol` transaction. After this guide, proceed to [02_VPS_SETUP.md](./02_VPS_SETUP.md)
then [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md).

> **v1 oracle is the signed-price-server, not Pyth.** The program verifies a company-signed price
> (secp256k1 / EIP-191) against `ProtocolState.price_signer` — a 20-byte Ethereum address you set in
> `initialize_protocol` (§8) and can rotate later with `set_price_signer` (§9). There is **no
> on-chain Pyth receiver** and you do **not** deploy any Pyth program.

---

## 0. Choose your cluster

```bash
# EDIT: pick ONE cluster for this deployment.
export SOLANA_CLUSTER=devnet
export SOLANA_RPC_URL=https://api.devnet.solana.com
# testnet:  export SOLANA_RPC_URL=https://api.testnet.solana.com
# mainnet:  export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com   # prefer a paid RPC provider
```

| Cluster | Funding | Oracle / signer |
|---------|---------|-----------------|
| **devnet** | `solana airdrop` / faucet | devnet signed-price-server signer (see §8/§9) |
| **testnet** | `solana airdrop` / faucet | same |
| **mainnet-beta** | Real SOL; **multisig upgrade authority** | production signed-price-server signer |

> **Recommendation:** use **devnet** for first end-to-end rehearsal. Solana **testnet** uses the
> same steps with a different RPC URL. **Mainnet** adds multisig ceremony and real funds — see §12.

---

## 1. Facts from source code

- Anchor program: `services/programs` · `anchor-lang = 0.32.1` (`Anchor.toml` toolchain).
- **Declared program id (all clusters):** `8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX`
  (`declare_id!` in `lib.rs`, `[programs.*]` in `Anchor.toml`).
- **Build the `.so` with platform-tools v1.53** — the default (v1.48) fails on `edition2024` deps:
  `cargo build-sbf --tools-version v1.53 -- -p syndicate-program`.
- Oracle: company-signed price verified in `signed_price.rs` against `ProtocolState.price_signer`.
  No Pyth program is deployed or referenced on-chain.
- The settlement signer (backend) is the on-chain `settlement_admin` = `emergency_void_admin`.
- **Match-creation bounds are operator-governed, not hardcoded.** `initialize_protocol` seeds
  `buy_in_min/max` and `fill_window_min/max_sec` into `ProtocolState`; `create_match` rejects any
  match whose buy-in or fill window falls outside them (no discrete tiers). Update later with
  `set_match_bounds` (§9.1, `config_admin`). These MUST mirror the config-service constants
  `BUY_IN_MIN/MAX` and `FILL_WINDOW_MIN/MAX_SEC` (`services/config/src/index.ts`).

---

## 2. Install toolchain (Ubuntu 22.04 / 24.04)

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential pkg-config libssl-dev libudev-dev

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.32.1 && avm use 0.32.1

anchor --version   # anchor-cli 0.32.1
solana --version
node --version
```

> `cargo build-sbf` downloads platform-tools on first use. `--tools-version v1.53` (§5) pins the
> toolchain that supports the program's `edition2024` dependencies.

---

## 3. Configure Solana CLI and fund deployer

```bash
solana config set --url "$SOLANA_RPC_URL"

# Create deployer wallet (devnet/testnet: empty passphrase is OK).
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
solana address
```

### Fund deployer

**devnet / testnet** — aim for ≥ 6 SOL (program rent + buffer):

```bash
solana airdrop 2 && sleep 10
solana airdrop 2 && sleep 10
solana airdrop 2
solana balance
```

If rate-limited, use https://faucet.solana.com (select your cluster).

**mainnet-beta** — send real SOL to `solana address`. Deployment needs ~5–8 SOL depending on
program size. Use a dedicated deployer wallet; upgrade authority should be a **multisig** (§12).

---

## 4. Clone repository

```bash
# EDIT: repository URL
git clone <REPO_URL> syndicate-backend
cd syndicate-backend
```

---

## 5. Build the program

```bash
cd services/programs
unset CARGO_TARGET_DIR
cargo build-sbf --tools-version v1.53 -- -p syndicate-program
```

This produces `target/deploy/syndicate_program.so` and (first build)
`target/deploy/syndicate_program-keypair.json`.

Refresh the committed frontend IDL (optional, on a build host):

```bash
cd ../..   # repo root
./scripts/emit-anchor-idl.sh
```

---

## 6. Program id — fresh deploy vs declared id

### Option A — Reuse the declared id `8D2Wt3pLyo…`

Only if you hold the **upgrade authority** for that program (devnet authority is the deployer
`2jUC7Ha2cUVGh7apUw7ztnckCWt4ffWCrwSVUYjJFnYt`). Upgrade in place:

```bash
cd services/programs
export SYNDICATE_PROGRAM_ID=8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX
unset CARGO_TARGET_DIR
cargo build-sbf --tools-version v1.53 -- -p syndicate-program
solana program deploy target/deploy/syndicate_program.so \
  --program-id "$SYNDICATE_PROGRAM_ID" \
  --url "$SOLANA_RPC_URL" \
  --keypair ~/.config/solana/id.json
```

If deploy fails with `account data too small` / `ExtendProgram requires…`, extend then redeploy:

```bash
solana program extend "$SYNDICATE_PROGRAM_ID" 16384 --url "$SOLANA_RPC_URL"
# re-run deploy command above
```

### Option B — Fresh deploy (new program id)

Use this if you do **not** hold the declared id's authority. You must update `declare_id!`
(`lib.rs`) and all `[programs.*]` in `Anchor.toml` to the new id **in lockstep**, then rebuild:

```bash
cd services/programs
anchor keys sync               
unset CARGO_TARGET_DIR
cargo build-sbf --tools-version v1.53 -- -p syndicate-program
export SYNDICATE_PROGRAM_ID=$(solana address -k target/deploy/syndicate_program-keypair.json)
echo "SYNDICATE_PROGRAM_ID=$SYNDICATE_PROGRAM_ID"
```

---

## 7. Deploy (Option B — new program)

```bash
cd services/programs
solana program deploy target/deploy/syndicate_program.so \
  --url "$SOLANA_RPC_URL" --keypair ~/.config/solana/id.json
export SYNDICATE_PROGRAM_ID=$(solana address -k target/deploy/syndicate_program-keypair.json)
solana program show "$SYNDICATE_PROGRAM_ID" --url "$SOLANA_RPC_URL"
```

Explorer: `https://explorer.solana.com/address/$SYNDICATE_PROGRAM_ID?cluster=$SOLANA_CLUSTER`

---

## 8. Settlement signer, price signer, and `initialize_protocol`

The backend signs `submit_settlement` / `lock` / `begin_live` / `void` with one keypair. On-chain
**`settlement_admin` = `emergency_void_admin` = settlement signer pubkey**.

The **`price_signer`** is a 20-byte **Ethereum address** (NOT a Solana key): the secp256k1 signer
used by `services/signed-price-server`. The contract recovers this address from each settlement
price's signature. Read it from the signed-price-server config you will run (guide 03):

```bash
# devnet signer address (services/signed-price-server/config/devnet.toml [signing].address):
export PRICE_SIGNER_ADDRESS=0x29cf2F55722dBC71D5674D76553f17Ff28B939Aa
```

Set the **match-creation bounds** seeded at init. These must equal the config-service constants
(`BUY_IN_MIN/MAX`, `FILL_WINDOW_MIN/MAX_SEC` in `services/config/src/index.ts`) so the off-chain
pre-check and the on-chain enforcement agree. Defaults below match the shipped config (USDC, 6 dp):

```bash
export BUY_IN_MIN=100000            
export BUY_IN_MAX=1000000000        
export FILL_WINDOW_MIN_SEC=20
export FILL_WINDOW_MAX_SEC=5000
```

Create the settlement signer and fund it:

```bash
solana-keygen new --no-bip39-passphrase -o ~/settlement-admin-keypair.json
export SETTLEMENT_PUBKEY=$(solana address -k ~/settlement-admin-keypair.json)
echo "SETTLEMENT_PUBKEY=$SETTLEMENT_PUBKEY"
solana airdrop 2 "$SETTLEMENT_PUBKEY" --url "$SOLANA_RPC_URL" || true
```

Create and run the init script:

```bash
mkdir -p ~/synd-init && cd ~/synd-init
npm init -y >/dev/null
npm install @solana/web3.js@^1.98.0
```

```bash
cat > init-protocol.mjs <<'EOF'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC_URL;
const PROGRAM_ID = new PublicKey(process.env.SYNDICATE_PROGRAM_ID);
const PAYER = loadKey(process.env.DEPLOYER_KEYPAIR);
const SETTLEMENT_PUBKEY = new PublicKey(process.env.SETTLEMENT_PUBKEY);
const DEPLOYER_PUBKEY = PAYER.publicKey;
// 20-byte Ethereum price signer (hex, 0x-optional).
const PRICE_SIGNER = Buffer.from(process.env.PRICE_SIGNER_ADDRESS.replace(/^0x/, ''), 'hex');
if (PRICE_SIGNER.length !== 20) throw new Error('PRICE_SIGNER_ADDRESS must be 20 bytes');

// MatchBounds (operator-governed, enforced in create_match). MUST equal the config-service
// constants BUY_IN_MIN/MAX + FILL_WINDOW_MIN/MAX_SEC (services/config/src/index.ts).
const BOUNDS = {
  buy_in_min: BigInt(process.env.BUY_IN_MIN ?? '1000000'),            // $1
  buy_in_max: BigInt(process.env.BUY_IN_MAX ?? '1000000000'),         // $1000
  fill_window_min_sec: BigInt(process.env.FILL_WINDOW_MIN_SEC ?? '20'),
  fill_window_max_sec: BigInt(process.env.FILL_WINDOW_MAX_SEC ?? '5000'),
};
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

// initialize_protocol args (Borsh, in order): ProtocolRoles { 8 pubkeys (32B each), price_signer
// ([u8; 20]) } then MatchBounds { buy_in_min, buy_in_max, fill_window_min_sec, fill_window_max_sec
// — each u64 LE }.
const PUBKEY_ROLES = {
  protocol_admin: DEPLOYER_PUBKEY,
  settlement_admin: SETTLEMENT_PUBKEY,
  emergency_void_admin: SETTLEMENT_PUBKEY,
  pause_admin: DEPLOYER_PUBKEY,
  config_admin: DEPLOYER_PUBKEY,
  fee_admin: DEPLOYER_PUBKEY,
  treasury_admin: DEPLOYER_PUBKEY,
  upgrade_authority: DEPLOYER_PUBKEY,
};
const ORDER = ['protocol_admin','settlement_admin','emergency_void_admin','pause_admin',
  'config_admin','fee_admin','treasury_admin','upgrade_authority'];

function loadKey(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}
function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
const data = Buffer.concat([
  disc('initialize_protocol'),
  ...ORDER.map((k) => PUBKEY_ROLES[k].toBuffer()),
  PRICE_SIGNER,
  u64le(BOUNDS.buy_in_min),
  u64le(BOUNDS.buy_in_max),
  u64le(BOUNDS.fill_window_min_sec),
  u64le(BOUNDS.fill_window_max_sec),
]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
    { pubkey: protocolPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

const conn = new Connection(RPC, 'confirmed');
const tx = new Transaction().add(ix);
const sig = await conn.sendTransaction(tx, [PAYER]);
await conn.confirmTransaction(sig, 'confirmed');
console.log('PROTOCOL_STATE_PDA=' + protocolPda.toBase58());
console.log('initialize_protocol tx:', sig);
EOF

export DEPLOYER_KEYPAIR=$HOME/.config/solana/id.json
node init-protocol.mjs
```

Record **`PROTOCOL_STATE_PDA`**. If it fails with “already in use”, the protocol was already
initialized — that is OK (the layout is fixed at first init; to change `price_signer`, use §9).

---

## 9. Rotate the price signer (optional / re-key)

`set_price_signer` lets the `protocol_admin` point the protocol at a new signed-price-server signing
address without re-initializing. Use it after rotating the server's signing key, or to recover a
protocol that was initialized against the wrong address.

```bash
# Same env as §8 (SOLANA_RPC_URL, SYNDICATE_PROGRAM_ID, DEPLOYER_KEYPAIR=protocol_admin, PRICE_SIGNER_ADDRESS).
cd ~/synd-init
cat > set-price-signer.mjs <<'EOF'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
const PROGRAM_ID = new PublicKey(process.env.SYNDICATE_PROGRAM_ID);
const PAYER = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const ADDR = Buffer.from(process.env.PRICE_SIGNER_ADDRESS.replace(/^0x/, ''), 'hex');
if (ADDR.length !== 20) throw new Error('PRICE_SIGNER_ADDRESS must be 20 bytes');
const disc = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: PAYER.publicKey, isSigner: true, isWritable: false },
    { pubkey: protocolPda, isSigner: false, isWritable: true },
  ],
  data: Buffer.concat([disc('set_price_signer'), ADDR]),
});
const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const sig = await conn.sendTransaction(new Transaction().add(ix), [PAYER]);
await conn.confirmTransaction(sig, 'confirmed');
console.log('set_price_signer tx:', sig);
EOF
node set-price-signer.mjs
```

---

## 9.1 Update match-creation bounds (optional / re-tune)

`set_match_bounds` lets the `config_admin` widen or tighten the buy-in / fill-window ranges without
re-initializing. New matches are validated against the updated bounds immediately. **Keep them in
sync with the config-service constants** (`BUY_IN_MIN/MAX`, `FILL_WINDOW_MIN/MAX_SEC`) — redeploy
the backend if you change them there.

```bash
# Same env as §8 (SOLANA_RPC_URL, SYNDICATE_PROGRAM_ID, DEPLOYER_KEYPAIR=config_admin,
# BUY_IN_MIN/MAX, FILL_WINDOW_MIN/MAX_SEC).
cd ~/synd-init
cat > set-match-bounds.mjs <<'EOF'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
const PROGRAM_ID = new PublicKey(process.env.SYNDICATE_PROGRAM_ID);
const PAYER = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEPLOYER_KEYPAIR, 'utf8'))));
const disc = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
// MatchBounds: buy_in_min, buy_in_max, fill_window_min_sec, fill_window_max_sec (each u64 LE).
const data = Buffer.concat([
  disc('set_match_bounds'),
  u64le(process.env.BUY_IN_MIN ?? '1000000'),
  u64le(process.env.BUY_IN_MAX ?? '1000000000'),
  u64le(process.env.FILL_WINDOW_MIN_SEC ?? '20'),
  u64le(process.env.FILL_WINDOW_MAX_SEC ?? '5000'),
]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: PAYER.publicKey, isSigner: true, isWritable: false },
    { pubkey: protocolPda, isSigner: false, isWritable: true },
  ],
  data,
});
const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const sig = await conn.sendTransaction(new Transaction().add(ix), [PAYER]);
await conn.confirmTransaction(sig, 'confirmed');
console.log('set_match_bounds tx:', sig);
EOF
node set-match-bounds.mjs
```

> The contract rejects `buy_in_min == 0`, `buy_in_min > buy_in_max`, or `fill_window_min_sec >
> fill_window_max_sec` (`InvalidConfig`).

---

## 10. Hand-off checklist (→ guide 03)

```
SYNDICATE_PROGRAM_ID     = <§6/§7>     # 8D2Wt3pLyo… if you reused the declared id
PROTOCOL_STATE_PDA       = <§8>
SOLANA_RPC_URL_PRIMARY   = <§0>
SOLANA_CLUSTER           = devnet | testnet | mainnet-beta
PRICE_SIGNER_ADDRESS     = <§8>        # must equal the signed-price-server signing address
SIGNED_PRICE_SERVER_URL  = <guide 03>  # settlement-chain reaches the server at this URL
CHIPS_TOKEN_MINT         = <SPL mint players deposit — e.g. devnet USDC>
BUY_IN_MIN / BUY_IN_MAX  = <§8>        # seeded match-creation bounds; must equal config-service constants
FILL_WINDOW_MIN/MAX_SEC  = <§8>        # "
```

Secure file transfer (never paste in chat):

```
~/settlement-admin-keypair.json  →  deploy/secrets/settlement-admin-keypair.json on VPS
```

---

## 11. Smoke test (devnet / testnet)

The authoritative end-to-end gate is `services/e2e` (Phase 11). It drives the full lifecycle
(create → deposit → seal → begin_live → submit_settlement → claim) plus a void path against your
deployed program and asserts the vault drains to **0**. It rotates `price_signer` to an
e2e-controlled key and signs prices locally, so it needs no running signed-price-server.

```bash
cd /path/to/syndicate-backend/services/e2e
npm install

export SYNDICATE_E2E_DEVNET=1
export PROGRAM_ID="$SYNDICATE_PROGRAM_ID"
export SOLANA_RPC_URL="$SOLANA_RPC_URL"
export SYNDICATE_DEVNET_KEYS_FILE=$PWD/../../devnet_testing_keys.md   # funded player keypairs
export E2E_OPERATOR_KEYPAIR=$HOME/.config/solana/id.json             # protocol_admin / settlement_admin

npm test     # gated test; or: npm run devnet  (verbose)
```

Expect both `✅ happy path: status=Settled, vault=0` and `✅ void path: status=Void, vault=0`. See
[../../services/e2e/README.md](../../services/e2e/README.md).

> **Note:** the e2e gate leaves `price_signer` rotated to a throwaway key. Re-run §9 with your real
> `PRICE_SIGNER_ADDRESS` afterward so live settlement accepts the server's prices.

---

## 12. Mainnet-only requirements

Before mainnet deploy:

1. **Multisig** for `upgrade_authority`, pause admins, and treasury roles — not a single hot wallet.
2. **Audit** complete; see `docs/deployment/AUDIT_AND_BUG_BOUNTY.md`.
3. **Real SOL** on deployer; no airdrop.
4. **Production signed-price-server** signer key; `PRICE_SIGNER_ADDRESS` set to its address and
   verified on-chain (`set_price_signer` rotation tested on devnet first).
5. Run `./scripts/deploy-mainnet.sh` preflight on CI before cutover.
6. After deploy: revoke unnecessary bootstrap authorities.

---

Proceed to [02_VPS_SETUP.md](./02_VPS_SETUP.md).
