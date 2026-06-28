# 01 — Solana Contract Deployment (devnet / testnet / mainnet)

> Audience: an operator who can copy/paste commands. Follow steps **in order**.
> Every command is meant to be run exactly as written unless a line says `# EDIT:`.

This guide deploys the Syndicate Anchor program (`services/programs`) and runs the one-time
`initialize_protocol` transaction. After this guide, proceed to [02_VPS_SETUP.md](./02_VPS_SETUP.md)
then [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md).

---

## 0. Choose your cluster

```bash
# EDIT: pick ONE cluster for this deployment.
export SOLANA_CLUSTER=devnet          # devnet | testnet | mainnet-beta
export SOLANA_RPC_URL=https://api.devnet.solana.com
# testnet:  export SOLANA_RPC_URL=https://api.testnet.solana.com
# mainnet:  export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com   # prefer a paid RPC provider
```

| Cluster | Funding | Pyth stack for backend (guide 03) |
|---------|---------|-----------------------------------|
| **devnet** | `solana airdrop` / faucet | `PYTH_RECEIVER_STACK=legacy` |
| **testnet** | `solana airdrop` / faucet | `PYTH_RECEIVER_STACK=legacy` |
| **mainnet-beta** | Real SOL; **multisig upgrade authority** | `PYTH_RECEIVER_STACK=upgraded` |

> **Recommendation:** use **devnet** for first end-to-end rehearsal. Solana **testnet** uses the
> same steps with a different RPC URL. **Mainnet** adds multisig ceremony and real funds — see §12.

---

## 1. Facts from source code

- Anchor program: `services/programs` · `anchor-lang = "0.32.1"` · CLI **must** be **0.32.1**.
- Declared program id in repo: `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS` (devnet staging).
- Pyth: program accepts price updates from **both** Pyth Core receiver generations on-chain
  (`services/programs/programs/syndicate_program/src/pyth_receiver.rs`). You do **not** deploy Pyth programs.
- Backend Pyth presets: `services/settlement-chain/pyth-stack.json` (see guide 03).

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

# Important: build into the project target/ (not a sandbox CARGO_TARGET_DIR).
unset CARGO_TARGET_DIR
anchor build
```

First build generates `target/deploy/syndicate_program-keypair.json` and
`target/idl/syndicate_program.json`.

Refresh the committed frontend IDL (optional, on build host):

```bash
cd ../..   # repo root
./scripts/emit-anchor-idl.sh
```

---

## 6. Program id — fresh deploy vs team staging id

### Option A — Fresh deploy (new program id)

```bash
cd services/programs
anchor keys sync
unset CARGO_TARGET_DIR && anchor build
export SYNDICATE_PROGRAM_ID=$(solana address -k target/deploy/syndicate_program-keypair.json)
echo "SYNDICATE_PROGRAM_ID=$SYNDICATE_PROGRAM_ID"
```

### Option B — Reuse team devnet id `FR4tqVX…`

Only if you hold the **upgrade authority** for that program (not the program keypair alone):

```bash
export SYNDICATE_PROGRAM_ID=FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS
# Do NOT run anchor keys sync. Upgrade with:
unset CARGO_TARGET_DIR
cargo build-sbf
solana program deploy target/sbpf-solana-solana/release/syndicate_program.so \
  --program-id "$SYNDICATE_PROGRAM_ID" \
  --url "$SOLANA_RPC_URL" \
  --keypair ~/.config/solana/id.json
```

If deploy fails with `ExtendProgram requires…`, extend then redeploy:

```bash
solana program extend "$SYNDICATE_PROGRAM_ID" 16384 --url "$SOLANA_RPC_URL"
# re-run deploy command above
```

---

## 7. Deploy (Option A — new program)

```bash
cd services/programs
anchor deploy --provider.cluster "$SOLANA_CLUSTER"
export SYNDICATE_PROGRAM_ID=$(solana address -k target/deploy/syndicate_program-keypair.json)
solana program show "$SYNDICATE_PROGRAM_ID" --url "$SOLANA_RPC_URL"
```

Explorer: `https://explorer.solana.com/address/$SYNDICATE_PROGRAM_ID?cluster=$SOLANA_CLUSTER`

---

## 8. Settlement signer + `initialize_protocol`

The backend signs `submit_settlement` and `void` with one keypair. On-chain:
**`settlement_admin` = `emergency_void_admin` = settlement signer pubkey**.

```bash
solana-keygen new --no-bip39-passphrase -o ~/settlement-admin-keypair.json
export SETTLEMENT_PUBKEY=$(solana address -k ~/settlement-admin-keypair.json)
echo "SETTLEMENT_PUBKEY=$SETTLEMENT_PUBKEY"

# Fund for tx fees (devnet/testnet):
solana airdrop 2 "$SETTLEMENT_PUBKEY" --url "$SOLANA_RPC_URL" || true
```

Create and run init script:

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

const roles = {
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
const data = Buffer.concat([disc('initialize_protocol'), ...ORDER.map((k) => roles[k].toBuffer())]);
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

Record **`PROTOCOL_STATE_PDA`**. If it fails with “already in use”, protocol was initialized — OK.

---

## 9. Pyth configuration (backend — do not deploy Pyth)

Read canonical ids from the repo manifest:

```bash
cd /path/to/syndicate-backend
node -e "
const m=require('./services/settlement-chain/pyth-stack.json');
const s=m.stacks.legacy;
console.log('PYTH_RECEIVER_STACK=legacy');
console.log('PYTH_HERMES_URL='+m.hermes.core);
console.log('PYTH_RECEIVER_PROGRAM_ID='+s.receiverProgramId);
console.log('PYTH_WORMHOLE_PROGRAM_ID='+s.wormholeProgramId);
console.log('PYTH_PUSH_ORACLE_PROGRAM_ID='+s.pushOracleProgramId);
console.log('--- mainnet cutover ---');
const u=m.stacks.upgraded;
console.log('PYTH_RECEIVER_STACK=upgraded');
console.log('PYTH_HERMES_URL='+m.hermes.upgraded);
console.log('PYTH_RECEIVER_PROGRAM_ID='+u.receiverProgramId);
"
```

For **mainnet**, use the `upgraded` block and a real `PYTH_API_KEY` from [Pyth Terminal](https://terminal.pyth.network/).

---

## 10. Hand-off checklist (→ guide 03)

```
SYNDICATE_PROGRAM_ID     = <§6/§7>
PROTOCOL_STATE_PDA       = <§8>
SOLANA_RPC_URL_PRIMARY   = <§0>
SOLANA_CLUSTER           = devnet | testnet | mainnet-beta
PYTH_RECEIVER_STACK      = legacy (devnet/testnet) | upgraded (mainnet)
PYTH_API_KEY             = <secret — never commit>
CHIPS_TOKEN_MINT         = <SPL mint players deposit — e.g. devnet USDC>
```

Secure file transfer (never paste in chat):

```
~/settlement-admin-keypair.json  →  deploy/secrets/settlement-admin-keypair.json on VPS
```

---

## 11. Smoke test (devnet / testnet)

Optional — validates custody + Pyth settlement path against your deployment:

```bash
cd /path/to/syndicate-backend
npm install --prefix services/devnet-harness

export PYTH_API_KEY=<your-key>
export PYTH_HERMES_URL=https://hermes.pyth.network
export PYTH_RECEIVER_STACK=legacy
export SYNDICATE_PROGRAM_ID=<your program id>
export SYNDICATE_DEVNET_RPC_URL="$SOLANA_RPC_URL"
export SYNDICATE_DEVNET_SETTLEMENT_ONLY=1
export SYNDICATE_DEVNET_SETTLEMENT_TS=$(($(date +%s) - 45))

./scripts/devnet-lifecycle-harness.sh
```

Expect `settlement lifecycle complete` and both `claim ok` lines.

---

## 12. Mainnet-only requirements

Before mainnet deploy:

1. **Multisig** for `upgrade_authority`, pause admins, and treasury roles — not a single hot wallet.
2. **Audit** complete; see `docs/deployment/AUDIT_AND_BUG_BOUNTY.md`.
3. **Real SOL** on deployer; no airdrop.
4. **`PYTH_RECEIVER_STACK=upgraded`** + production Hermes API key.
5. Run `./scripts/deploy-mainnet.sh` preflight on CI before cutover.
6. After deploy: revoke unnecessary bootstrap authorities.

---

Proceed to [02_VPS_SETUP.md](./02_VPS_SETUP.md).
