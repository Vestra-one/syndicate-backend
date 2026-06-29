# Syndicate Devnet Lifecycle Harness

Executable Devnet custody harness for the deployed Syndicate program.

## Setup

```bash
cd services/devnet-harness
npm install
```

## Run

From the repo root:

```bash
./scripts/devnet-lifecycle-harness.sh
```

The default run performs:

1. Verify the deployed program account.
2. Parse the first two keypairs from `devnet_testing_keys.md`.
3. Create an SPL chips mint.
4. Create player token accounts and mint test chips.
5. Initialize or reuse protocol state.
6. Create a fresh match.
7. Deposit both players.
8. Lock the match.
9. Void the match.
10. Refund both players.
11. If `PYTH_API_KEY` is set, create a second match and execute Hermes timestamp fetch → Pyth Receiver full-verification post → Syndicate `submit_settlement` → player claims.

## Settlement Path

To additionally execute `submit_settlement` and `claim`, provide Hermes credentials through the host environment:

```bash
PYTH_API_KEY=<secret> ./scripts/devnet-lifecycle-harness.sh
```

The harness binds the created match to the configured feed id, scheduled end timestamp, exponent, confidence limit, and exact-after window. After lock it fetches Hermes `/v2/updates/price/<timestamp>?encoding=hex&parsed=true` for every second in `[scheduled_end_ts, scheduled_end_ts + window]`, selects the earliest valid `publish_time`, converts the selected binary update to the base64 format expected by `@pythnetwork/pyth-solana-receiver`, and first attempts to build the Pyth Receiver post plus Syndicate `submit_settlement` path through the Pyth builder.

Devnet measurement showed the full-verification Pyth Receiver path can build as two transactions. The harness therefore supports an explicit two-step fallback by default: post the fully verified Pyth update account, then submit Syndicate settlement using that verified account. Set `SYNDICATE_DEVNET_ALLOW_TWO_STEP_PYTH_FALLBACK=false` to force atomic-only testing.

If Hermes has no valid update inside the window, the match is voided and both players are refunded with the canonical reason: `Pyth Oracle price for settlement is unavailable.`

Settlement arguments are computed with the same deterministic rules as `syndicate-shared` for the harness scenario: layered pots, closest prediction, seal-order remainder assignment, rake clamp, and conservation check. The chain still re-verifies the Pyth `PriceUpdateV2` account for full verification, feed id, exact arguments, confidence, exponent, and publish-time window before any claimable payout is written.

Pyth audit receipts are written to `/tmp/syndicate-devnet-receipts` by default. They include selected price, publish time, confidence, exponent, price update account, settlement mode, all settlement transaction signatures, Pro-compatible Receiver/Wormhole/Push ids, Hermes response hash, and binary update hash. They never include `PYTH_API_KEY`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SYNDICATE_PROGRAM_ID` | deployed Devnet program | Syndicate program id under test. |
| `SYNDICATE_DEVNET_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint. |
| `SYNDICATE_DEVNET_KEYS_FILE` | `devnet_testing_keys.md` | Markdown file containing test keypairs. |
| `SYNDICATE_DEVNET_MATCH_ID` | current Unix timestamp | Override match id for deterministic reruns. |
| `PYTH_HERMES_URL` | `https://hermes.pyth.network` | Pyth Core Hermes endpoint. Upgraded: `https://pyth.dourolabs.app/hermes`. |
| `PYTH_API_KEY` | unset | Hermes API key. Required for the Pyth settlement path; never printed. |
| `PYTH_RECEIVER_STACK` | `legacy` | `legacy` (Core current programs, devnet) or `upgraded` (mainnet production stack). Sets Hermes + receiver/wormhole/push IDs unless overridden. |
| `PYTH_RECEIVER_PROGRAM_ID` | stack preset | Override receiver program id. |
| `PYTH_WORMHOLE_PROGRAM_ID` | stack preset | Override Wormhole program id. |
| `PYTH_PUSH_ORACLE_PROGRAM_ID` | stack preset | Override push oracle program id. |
| `SYNDICATE_DEVNET_SETTLEMENT_TS` | current Unix timestamp | Match scheduled end timestamp for the settlement test. |
| `SYNDICATE_DEVNET_IDEMPOTENCY_KEY` | derived from timestamp + feed | Audit/idempotency label for the settlement receipt. |
| `SYNDICATE_DEVNET_BUY_IN` | `1000000` | Per-seat buy-in in token base units. |
| `SYNDICATE_DEVNET_TOTAL_BETTING_DURATION_SEC` | `600` | Bound into `CreateParams`; `scheduled_end_ts` derived at `begin_live`. |
| `SYNDICATE_DEVNET_SEAL_WINDOW_SEC` | `20` | SEALING window length. |
| `SYNDICATE_DEVNET_BEGIN_LIVE_WINDOW_SEC` | `5` | Max delay after seal deadline for `begin_live`. |
| `SYNDICATE_DEVNET_NONSEAL_PENALTY_BPS` | `2500` | Non-sealer penalty bound at create. |
| `SYNDICATE_DEVNET_INTER_TX_DELAY_MS` | `2500` | Delay between Devnet txs (RPC rate-limit pacing). |
| `SYNDICATE_DEVNET_SETTLEMENT_ONLY` | `false` | Skip refund lifecycle; run sealing-to-live path only. |
| `SYNDICATE_DEVNET_PRICE_FEED_ID_HEX` | BTC/USD | 32-byte Pyth feed id (Hermes lookup); first 20 bytes encode `price_token`. |
| `SYNDICATE_DEVNET_PLAYER_MINT_AMOUNT` | `10000000` | Test chips minted to each player. |
| `SYNDICATE_DEVNET_MAX_ORACLE_CONFIDENCE` | `u64::MAX` | Confidence guard for the created match. |
| `SYNDICATE_DEVNET_ORACLE_EXPONENT` | `-18` | Expected signed-price exponent for the created match. |
| `SYNDICATE_DEVNET_RAKE_BPS` | `0` | Pot rake for harness-created matches. |
| `SYNDICATE_DEVNET_RAKE_CAP` | `0` | Per-pot rake cap. |
| `SYNDICATE_DEVNET_RPC_RETRIES` | `6` | Retry count for transient Solana Devnet RPC transport failures. |
| `SYNDICATE_DEVNET_RPC_RETRY_BASE_MS` | `500` | Base delay for exponential RPC retry backoff. |
| `SYNDICATE_DEVNET_RECEIPT_DIR` | `/tmp/syndicate-devnet-receipts` | Directory for Pyth settlement audit receipts. |
| `SYNDICATE_DEVNET_REQUIRE_PYTH_SETTLEMENT` | `false` | If true, missing `PYTH_API_KEY` fails the run instead of skipping the settlement path. |

Private keys are read only from the configured key file and are never printed.
