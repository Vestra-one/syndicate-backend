# 01 — Solana Contract Deployment (Devnet)

> Audience: an operator who can copy/paste and run commands, with **no prior knowledge**
> of this project. Follow the steps **in order**. Do not skip steps. Every command is
> meant to be run exactly as written unless a line says `# EDIT:`.

This guide deploys the single on‑chain program in this repository
(`services/programs`, Anchor program name `syndicate_program`) to **Solana devnet**, and
then performs the one‑time **protocol initialization** transaction that the backend
requires before it can settle matches.

At the end you will produce three hand‑off values that the backend team needs:

| Output | Where it is used later |
| --- | --- |
| `SYNDICATE_PROGRAM_ID` | Backend env var (`02`/`03` guides) |
| `PROTOCOL_STATE_PDA` | Backend env var (informational) |
| Settlement signer keypair file | Backend secret `settlement-admin-keypair.json` |

---

## 0. Facts established by reading the code (not the docs)

These are derived directly from the source so you can trust them:

- The program is an **Anchor** program. Source: `services/programs/src/lib.rs`,
  `services/programs/Cargo.toml`, `services/programs/Anchor.toml`.
- `Cargo.toml` pins **`anchor-lang = "0.32.1"`** and **`anchor-spl = "0.32.1"`**. The
  Anchor **CLI version MUST match the library version**, so you must use **Anchor 0.32.1**.
  - ⚠️ `Anchor.toml` contains `anchor_version = "0.30.1"`. That value is **stale/incorrect**
    relative to the `Cargo.toml` dependency. Use **0.32.1** as instructed below.
- The program id hard‑coded in source is
  `declare_id!("FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS")`
  (and the same id in `Anchor.toml`). For a **fresh** deployment you will generate your
  **own** program keypair and sync the id (Step 6). Only reuse `FR4tqVX…` if the project
  team explicitly hands you its matching program keypair file.
- The program depends on the Pyth Solana Receiver SDK
  (`pyth-solana-receiver-sdk = "1.2.0"`). The Pyth receiver/wormhole/push‑oracle programs
  are **already deployed by Pyth** on devnet — you do **not** deploy those. You only record
  their program ids for the backend (Step 9).
- The program exposes these instructions (from `lib.rs`): `initialize_protocol`,
  `set_pauses`, `create_match`, `deposit`, `lock`, `submit_settlement`, `claim`, `void`,
  `refund`. Only `initialize_protocol` must be run at deploy time (Step 8).

---

## 1. Choose where to run this

Run everything in this guide on a machine that has internet access — this can be your
laptop or the VPS. It does **not** have to be the production VPS. You need ~5 GB free disk
and the ability to install software.

This guide assumes **Ubuntu 22.04 / 24.04** (the same as the VPS). On macOS the commands
are similar but package installs differ; prefer Ubuntu to match these steps exactly.

---

## 2. Install the toolchain

Run each block and wait for it to finish before the next.

### 2.1 System packages

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential pkg-config libssl-dev libudev-dev
```

### 2.2 Rust (stable)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustc --version   # should print a 1.7x or newer version
```

### 2.3 Solana CLI (Anza / Agave)

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
# Add Solana to your PATH for this shell and future shells:
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$HOME/.bashrc"
solana --version  # should print "solana-cli 2.x"
```

### 2.4 Node.js 22 + Yarn (needed by Anchor and the init script)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g yarn
node --version    # v22.x
yarn --version
```

### 2.5 Anchor 0.32.1 (via avm)

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.32.1
avm use 0.32.1
anchor --version  # must print: anchor-cli 0.32.1
```

> If `avm install 0.32.1` fails to compile, ensure Step 2.1 and 2.2 completed and that
> `rustc --version` works, then re‑run.

---

## 3. Point the Solana CLI at devnet and create a deployer wallet

The **deployer wallet** pays for the deployment (rent + fees). It is **not** the same as
the protocol admin/settlement keys.

```bash
solana config set --url https://api.devnet.solana.com

# Create the deployer wallet (writes ~/.config/solana/id.json).
# When asked for a passphrase you may press ENTER for an empty one (devnet only).
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json

# Show its address and confirm the CLI is on devnet:
solana address
solana config get
```

### 3.1 Fund the deployer wallet with devnet SOL

Program deployment for this program needs roughly **3–6 SOL** (rent for the program +
buffer). Devnet airdrops are rate‑limited to ~2 SOL per request, so request a few times.

```bash
solana airdrop 2
sleep 10
solana airdrop 2
sleep 10
solana airdrop 2
solana balance   # aim for >= 6 SOL
```

> If airdrops are throttled (`rate limit reached`), use the web faucet
> <https://faucet.solana.com> — paste the address from `solana address`, select **Devnet**,
> and request until `solana balance` shows enough. Then continue.

---

## 4. Get the repository

If you do not already have the repo on this machine:

```bash
# EDIT: replace with the actual repository URL you were given.
git clone <REPO_URL> syndicate-backend
cd syndicate-backend
```

If you already have it, just `cd` into it. All remaining commands assume your shell is at
the **repository root** unless stated otherwise.

---

## 5. Build the program

```bash
cd services/programs
anchor build
```

This compiles the program and, on the **first** build, generates a fresh program keypair at
`target/deploy/syndicate_program-keypair.json`. The build also produces the IDL at
`target/idl/syndicate_program.json` (used by the backend / clients).

> Build can take several minutes the first time. If it fails with a Solana toolchain error,
> confirm `anchor --version` is `0.32.1` and `solana --version` is `2.x`.

---

## 6. Set the program id (sync declared id to your keypair)

Because you generated a **new** program keypair in Step 5, its address does not match the
`FR4tqVX…` id baked into the source. Anchor can rewrite the source to match your keypair:

```bash
# Still inside services/programs
anchor keys sync
```

`anchor keys sync` updates `declare_id!(...)` in `src/lib.rs` and the `[programs.*]` entries
in `Anchor.toml` to your new program id. **Rebuild** so the binary embeds the correct id:

```bash
anchor build
```

Confirm the program id you are about to deploy:

```bash
solana address -k target/deploy/syndicate_program-keypair.json
```

Copy this value — this is your **`SYNDICATE_PROGRAM_ID`**.

> **Alternative (only if the team gave you the official program keypair):** instead of
> Steps 6’s `anchor keys sync`, place their provided `syndicate_program-keypair.json` at
> `services/programs/target/deploy/syndicate_program-keypair.json` **before** Step 5, do not
> run `anchor keys sync`, and the deployed id will be the canonical `FR4tqVX…`.

---

## 7. Deploy to devnet

```bash
# Still inside services/programs
anchor deploy --provider.cluster devnet
```

On success Anchor prints `Deploy success` and the program id. Verify it on chain:

```bash
PROGRAM_ID=$(solana address -k target/deploy/syndicate_program-keypair.json)
echo "SYNDICATE_PROGRAM_ID=$PROGRAM_ID"
solana program show "$PROGRAM_ID" --url https://api.devnet.solana.com
```

You should see program details including the **Authority** (your deployer wallet) and the
data length. You can also view it at:
`https://explorer.solana.com/address/<PROGRAM_ID>?cluster=devnet`

> If deploy fails with `insufficient funds`, top up with `solana airdrop 2` (Step 3.1) and
> re‑run `anchor deploy --provider.cluster devnet`. Anchor resumes from the buffer.

---

## 8. One‑time protocol initialization

The backend cannot settle until the program’s global **ProtocolState** account exists. It is
created by calling the `initialize_protocol` instruction once. Reading `lib.rs`:

- `initialize_protocol(roles)` requires the **signer == `roles.protocol_admin`** and that
  **all 8 role pubkeys are non‑default** (no all‑zero key).
- The settlement backend signs `submit_settlement` (requires `settlement_admin`) and `void`
  (requires `emergency_void_admin`) with **one** keypair. Therefore
  **`settlement_admin` and `emergency_void_admin` MUST both equal the settlement signer
  pubkey** you give the backend.

### 8.1 Create the settlement signer keypair

This keypair becomes the backend secret `settlement-admin-keypair.json` later.

```bash
cd ~   # leave the program dir for a moment
solana-keygen new --no-bip39-passphrase -o ~/settlement-admin-keypair.json
SETTLEMENT_PUBKEY=$(solana address -k ~/settlement-admin-keypair.json)
echo "SETTLEMENT_PUBKEY=$SETTLEMENT_PUBKEY"

# It will need a little devnet SOL to pay fees when settling:
solana airdrop 2 "$SETTLEMENT_PUBKEY"
```

> Keep `~/settlement-admin-keypair.json` safe. You will copy it to the VPS in guide `03`.

### 8.2 Decide the role pubkeys

For a devnet bring‑up the simplest safe choice is:

- `settlement_admin` = `emergency_void_admin` = **`$SETTLEMENT_PUBKEY`** (required, see above).
- All other roles (`protocol_admin`, `pause_admin`, `config_admin`, `fee_admin`,
  `treasury_admin`, `upgrade_authority`) = your **deployer** wallet
  (`solana address`), or any keys you control.

> `protocol_admin` must be the **signer** of this transaction. The script below signs with
> your deployer wallet (`~/.config/solana/id.json`), so set `protocol_admin` to the deployer
> address.

### 8.3 Run the initialization script

This self‑contained script uses only `@solana/web3.js` and builds the instruction the same
way the backend does (Anchor discriminator + Borsh args). Create it in a scratch directory:

```bash
mkdir -p ~/synd-init && cd ~/synd-init
npm init -y >/dev/null
npm install @solana/web3.js@^1.98.0
```

Create `init-protocol.mjs`:

```bash
cat > init-protocol.mjs <<'EOF'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';

// ---- EDIT THESE ----
const RPC = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(process.env.SYNDICATE_PROGRAM_ID);       // from Step 7
const PAYER = loadKey(process.env.DEPLOYER_KEYPAIR);                       // ~/.config/solana/id.json
const SETTLEMENT_PUBKEY = new PublicKey(process.env.SETTLEMENT_PUBKEY);   // from Step 8.1
const DEPLOYER_PUBKEY = PAYER.publicKey;

const roles = {
  protocol_admin:      DEPLOYER_PUBKEY,     // MUST equal the signer (PAYER)
  settlement_admin:    SETTLEMENT_PUBKEY,   // MUST equal backend settlement signer
  emergency_void_admin:SETTLEMENT_PUBKEY,   // MUST equal backend settlement signer
  pause_admin:         DEPLOYER_PUBKEY,
  config_admin:        DEPLOYER_PUBKEY,
  fee_admin:           DEPLOYER_PUBKEY,
  treasury_admin:      DEPLOYER_PUBKEY,
  upgrade_authority:   DEPLOYER_PUBKEY,
};
// --------------------

const ORDER = ['protocol_admin','settlement_admin','emergency_void_admin','pause_admin',
  'config_admin','fee_admin','treasury_admin','upgrade_authority'];

function loadKey(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}
function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID);
const data = Buffer.concat([disc('initialize_protocol'),
  ...ORDER.map((k) => roles[k].toBuffer())]);

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: PAYER.publicKey, isSigner: true,  isWritable: true },
    { pubkey: protocolPda,     isSigner: false, isWritable: true },
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
```

Run it (fill the variables from earlier steps):

```bash
# EDIT: set SYNDICATE_PROGRAM_ID to the value printed in Step 7.
export SYNDICATE_PROGRAM_ID=<PASTE_FROM_STEP_7>
export SETTLEMENT_PUBKEY=$(solana address -k ~/settlement-admin-keypair.json)
export DEPLOYER_KEYPAIR=$HOME/.config/solana/id.json

node init-protocol.mjs
```

On success it prints `PROTOCOL_STATE_PDA=...` and a transaction signature. Record the
**`PROTOCOL_STATE_PDA`**.

> If it fails with `Unauthorized`, your signer (deployer) does not match `protocol_admin` —
> make sure `protocol_admin` in the script is the deployer address. If it fails with
> `already in use`, the protocol was already initialized; that is fine.

---

## 9. Record the Pyth program ids (do not deploy Pyth)

The backend needs the Pyth Solana Receiver stack program ids. **Do not trust the placeholder
values in `docs/deployment/env.example`** — read them from the official Pyth SDK that the
backend itself uses:

```bash
cd ~/synd-init
npm install @pythnetwork/pyth-solana-receiver@^0.16.0
node -e "const p=require('@pythnetwork/pyth-solana-receiver');console.log('PYTH_RECEIVER_PROGRAM_ID='+p.DEFAULT_RECEIVER_PROGRAM_ID);console.log('PYTH_WORMHOLE_PROGRAM_ID='+p.DEFAULT_WORMHOLE_PROGRAM_ID);console.log('PYTH_PUSH_ORACLE_PROGRAM_ID='+p.DEFAULT_PUSH_ORACLE_PROGRAM_ID);"
```

Record the three printed values. These same ids are valid on devnet and mainnet.

---

## 10. Hand‑off checklist

Give the backend operator (guide `03`) these exact values:

```
SYNDICATE_PROGRAM_ID   = <Step 7>
PROTOCOL_STATE_PDA     = <Step 8.3>
PYTH_RECEIVER_PROGRAM_ID     = <Step 9>
PYTH_WORMHOLE_PROGRAM_ID     = <Step 9>
PYTH_PUSH_ORACLE_PROGRAM_ID  = <Step 9>
```

And securely transfer this file (never paste its contents into chat/email):

```
~/settlement-admin-keypair.json   ->  becomes deploy/secrets/settlement-admin-keypair.json on the VPS
```

You are done with the contract. Proceed to `02_VPS_SETUP.md`.
