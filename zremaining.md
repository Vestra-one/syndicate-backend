1. The on-chain program has never been compiled or run.

cargo build-sbf failed locally (toolchain/edition2024). It must succeed on a proper Solana build host first.
The litesvm lifecycle/golden-parity tests are currently #[ignore] because they need the compiled .so. No on-chain instruction has executed in a test — submit_settlement, claim, refund, withdraw_fees, and the SEALING transitions are unverified at runtime. This is the single biggest risk; the fee/settlement math could have bugs that only surface at execution.
2. ~~VRF is operator-attested, not real randomness.~~ **Closed (v1):** settlement-chain now generates CSPRNG button seeds (`buttonRandomness.ts`); seeds are unpredictable to clients and recorded on-chain. Trust model is **server-attested** (not decentralized oracle VRF). Upgrade to Switchboard/ORAO on-chain verification is a future enhancement if button fairness becomes a hard requirement.

3. Integration not exercised end-to-end. The act → engine → Redis → gateway loop compiles but hasn't been run against live Redis/Postgres. No integration test drives a full match through the new routes.

4. Operational gates (explicitly out of code scope, still required):

External audit + bug bounty
Multisig/key ceremony, mainnet program-key generation (declare_id! still placeholder)
Treasury funding
Real IDL emission (committed file is a placeholder)
Staging run of kill switches




Remaining from step 1
These execute successfully via MatchHarness::Krist::new():

initialize_protocol
create_match
deposit (×3)
lock
set_button_seed
begin_live
Still not exercised on-chain
Point 1 in zremaining.md is only partially closed. These instructions have no real litesvm coverage yet:

init_action_log (tests inject the account directly)
register_default_policy / append_player_action / finalize_action_log
submit_settlement
claim
refund / void
withdraw_fees
Golden parity through the program (only shared-core today)
The two full_lifecycle.rs tests are placeholders — they assert match_key != default and don't drive settlement or fee withdrawal.

Bottom line: The program compiles and the SEALING → Live path works in litesvm. The settlement/fee/refund path — the highest-risk gap in point 1 — still needs harness helpers + tests wired to submit_settlement through claim/withdraw_fees.