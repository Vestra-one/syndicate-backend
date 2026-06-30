# Syndicate E2E — devnet integration gate (Phase 11)

Two layers live here:

- **Library smoke** (`test/lifecycle.test.ts`) — pure, always runs in CI.
- **Devnet integration gate** (`test/devnet-lifecycle.test.ts` + `src/devnet-driver.mjs`) — drives the
  full v1 player-created lifecycle against a **deployed devnet program**, plus one void path, and
  asserts the vault SPL-token balance settles to **exactly zero**. Env-gated; skips unless
  explicitly requested.

## Run the gate

```bash
cd services/e2e && npm install        # @solana/web3.js, @solana/spl-token, @noble/*

export SYNDICATE_E2E_DEVNET=1
# Defaults below match the Phase 03 devnet deploy; override only to retarget.
export PROGRAM_ID=8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX
export SOLANA_RPC_URL=https://api.devnet.solana.com
export SYNDICATE_DEVNET_KEYS_FILE=$PWD/../../devnet_testing_keys.md   # player keypairs
export E2E_OPERATOR_KEYPAIR=$HOME/.config/solana/id.json             # admin/settlement (deployer)

npm test                 # runs the gate + smoke tests
# or drive it directly (verbose, no node:test wrapper):
SYNDICATE_DEVNET_KEYS_FILE=$PWD/../../devnet_testing_keys.md npm run devnet
```

Without `SYNDICATE_E2E_DEVNET=1` the devnet test **skips** (CI default). With it set, missing key
material throws a clear error rather than running a partial match.

## What the gate proves

The signing client (`src/devnet-driver.mjs`) owns the wallet key material, builds the real v1
instructions, and runs both lifecycles end-to-end on devnet:

**Happy path** — host `create_and_deposit` (seat 0) → joiner `deposit` (seat 1) → operator `lock`
→ both players `register_prediction_commitment` (during Sealing, with a timelock target bounded to
the on-chain `seal_deadline_ts`) → operator `begin_live` (button randomness + both seats as
`remaining_accounts`) → operator `submit_settlement` (with a locally-produced EIP-191 signed price
at exactly `scheduled_end_ts`) → both players `claim`.

**Void path** — host `create_and_deposit` only (never reaches `min_players`) → wait past
`fill_deadline_ts` → permissionless `void_before_start` → depositor `refund`.

**Assertions (the gate):**
- Happy path reaches `Settled`; vault SPL-token balance == **0** after both claims (rake/entry-fee
  are 0, so no fees remain).
- Void path reaches `Void`; vault SPL-token balance == **0** after the refund.
- Payouts satisfy on-chain conservation (`Σ payout == sealed×buy_in + dead_money − rake`); the
  contract rejects the settlement otherwise.

```bash
# spot-check a vault after a terminal state (the driver also asserts this):
spl-token balance --address <vaultTokenAccount> --url devnet   # expect 0
```

## Signed price (no external server required)

v1 settlement verifies a company-signed price (secp256k1 / EIP-191) against
`ProtocolState.price_signer`. The driver generates an e2e-controlled secp256k1 key, rotates
`price_signer` to that key's Ethereum address via `set_price_signer` (admin = deployer), then signs
`keccak256(token || price_in_wad || timestamp_ms)` with the `"\x19Ethereum Signed Message:\n32"`
prefix — mirroring `signed_price.rs`. So the full settlement path runs without standing up the
signed-price-server.

## Relationship to the live HTTP services

In v1 the HTTP services (matchmaking / orchestrator / settlement-chain) only **verify
client-reported txhashes** and maintain a registry — they are **not** in the custody path. The
on-chain lifecycle the driver exercises IS the capital-safety gate, so it is the authoritative
assertion. If a local fleet is running, registry reporting (`POST /rooms`,
`POST /matches/:matchPda/deposits`, `GET /rooms`) can be layered on top of the same txhashes the
driver already produces; the gate does not require it.

## Devnet deploy under test (Phase 03)

| Thing | Value |
|---|---|
| Program id | `8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX` |
| Protocol state PDA | `EDwcfo4UjFp3kEwz9CqEAv2iojKinzaAmPLNLeZiAkXS` |
| Upgrade authority / admin (deployer) | `2jUC7Ha2cUVGh7apUw7ztnckCWt4ffWCrwSVUYjJFnYt` |
| Cluster | devnet (`https://api.devnet.solana.com`) |

The driver mints a **fresh chips SPL mint** per run and tops up player SOL from the operator if a
player is below `E2E_MIN_PLAYER_LAMPORTS`, so reruns are self-contained.

## Tunables (env)

| Variable | Default | Purpose |
|---|---|---|
| `PROGRAM_ID` | Phase 03 deploy | Program under test. |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | RPC endpoint. |
| `SYNDICATE_DEVNET_KEYS_FILE` | `devnet_testing_keys.md` | Player keypairs (first two used). |
| `E2E_OPERATOR_KEYPAIR` | `~/.config/solana/id.json` | Admin/settlement signer (deployer). |
| `E2E_BUY_IN` | `1000000` | Per-seat buy-in (token base units). |
| `E2E_SEAL_WINDOW_SEC` | `20` | SEALING window (kept short to bound the wait). |
| `E2E_BEGIN_LIVE_WINDOW_SEC` | `120` | Generous `begin_live` window for devnet pacing. |
| `E2E_TOTAL_BETTING_SEC` | `3` | `scheduled_end_ts = live_start + this`. |
| `E2E_INTER_TX_DELAY_MS` | `1500` | Pacing between txs (RPC rate-limit). |
| `E2E_MIN_PLAYER_LAMPORTS` | `80000000` | Top players up from the operator below this. |

## Gotchas

- **Timing:** `begin_live` must land within `begin_live_window_sec` of `seal_deadline_ts`; the
  driver bumps that window to 120s for devnet pacing. Seals must land at/before `seal_deadline_ts`.
- **Timelock bound:** `register_prediction_commitment` requires the drand target round to publish
  in `(latest_match_end, latest_match_end + 20s]`; the driver computes a valid round from the
  on-chain `seal_deadline_ts` after `lock`.
- Treat a failure here as a signal to fix the **owning** phase (encoding/ordering), not to patch e2e.
```
