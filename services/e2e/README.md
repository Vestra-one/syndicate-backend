# Syndicate E2E — devnet integration gate (Phase 11)

Two layers live here:

- **Library smoke** (`test/lifecycle.test.ts`) — pure, always runs in CI.
- **Devnet integration gate** (`test/devnet-lifecycle.test.ts`) — drives the full player-created
  lifecycle through the **live** services against a devnet deploy, plus one void path, and asserts
  chain / Postgres / registry agree and the vault settles to **exactly zero**. Env-gated; skips
  unless explicitly requested.

## Run the gate

```bash
export SYNDICATE_E2E_DEVNET=1
export SOLANA_RPC_URL=https://api.devnet.solana.com
export PROGRAM_ID=<deployed devnet program id>     # Phase 03 deploy; NOT the placeholder
export SIGNED_PRICE_SERVER_URL=https://<signed-price-server>
export E2E_PAYER_KEYPAIR=/path/to/funded-devnet-keypair.json   # signs create/deposit/seal/claim
# service URLs (defaults assume the local fleet / docker-compose.localnet.yml):
export MATCHMAKING_URL=http://127.0.0.1:8082
export ORCHESTRATOR_URL=http://127.0.0.1:8086
export SETTLEMENT_CHAIN_URL=http://127.0.0.1:8085
export ACTION_FEED_URL=http://127.0.0.1:8080

cd services/e2e && npm test
```

Without `SYNDICATE_E2E_DEVNET=1` the devnet tests **skip** (CI default). With it set, missing required
env throws a clear error rather than running a partial match.

## What the gate proves

**Happy path** — host `create_and_deposit` → report txhash (`POST /rooms`); 1–2 joiners `deposit` →
report (`POST /matches/:matchPda/deposits`); host-start → orchestrator `lock → begin_live` (randomness
+ seat PDAs from `GET /internal/solana/enumerate-seats`) → engine start; players seal
(`register_prediction_commitment` + tlock ciphertext upload); play to `scheduled_end_ts`; worker
fetches the signed price + decrypts the timelock + `submit_settlement`; players `claim`; operator
`withdraw_fees`.

**Assertions (the gate):**
- `GET /rooms` reflects each transition.
- Postgres `matches`/`match_seats` rows match chain.
- Settled payouts == `shared::settle()` expectation.
- Final vault SPL-token balance == **0** after claims + `withdraw_fees`.

**Void path** — Filling past `fill_deadline_ts` → permissionless `void_before_start` → all refund →
vault == 0; registry shows `Void`.

```bash
# spot-check the vault after a terminal state:
spl-token balance --address <vaultTokenAccount> --url devnet   # expect 0
```

## Operator wiring required

The signing client (wallet keypair + deployed IDL) is operator-provided because it needs key
material and the exact deployed program. The harness in `devnet-lifecycle.test.ts` does the liveness
preflight and documents the exact step sequence + assertions; plug `E2E_PAYER_KEYPAIR` + the IDL
(`docs/frontend/idl/syndicate_program.json`, refreshed by Phase 03) to complete steps 1–6 and the
`vault == 0` assertion.

## Gotchas

- **Timing:** `begin_live_window_sec` (5s) and the seal/observation windows are short. Use a template
  with generous windows for the e2e, or orchestrate promptly, or the match voids.
- **Liveness:** the signed-price-server and drand must be reachable from the worker; the gate
  preflights service `/healthz` and aborts early if a dependency is down.
- Treat a failure here as a signal to fix the **owning** phase (encoding/ordering), not to patch e2e.
