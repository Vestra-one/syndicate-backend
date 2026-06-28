//! # syndicate-shared — the deterministic core
//!
//! This crate is the **single source of truth** for every settlement outcome in
//! Syndicate. The exact same logic runs off-chain (`settlement`) and on-chain
//! (`programs`), so results are byte-identical (see `ARCHITECTURE.md §4`,
//! `04_GAME_MECHANICS_CANONICAL.md §9, §11, §13, §18`).
//!
//! Invariants enforced here:
//! - **Integer-only money math** — no floating point anywhere (`04 §1`).
//! - **Conservation** — chips out == chips in, net of fees (`04 §0`).
//! - **Determinism** — identical inputs produce identical bytes out; all ordering
//!   is explicit (stable sorts, id/seal tiebreaks). No iteration-order surprises.
//!
//! Purity: no I/O, no clock, no randomness generation. The VRF seed, oracle
//! verified oracle price, and decrypted predictions are *inputs*. This is what makes the result
//! independently verifiable on-chain.

pub mod events;
pub mod intent;
pub mod oracle;
pub mod pots;
pub mod settle;
pub mod types;

pub use intent::{
    action_head_step, action_intent_message, action_tag_and_amount, chain_hash,
    default_policy_message, prediction_commitment_hash, prediction_commitment_message,
    ACTION_TAG_ALL_IN, ACTION_TAG_BET_TO, ACTION_TAG_CALL, ACTION_TAG_CHECK, ACTION_TAG_FOLD,
    ACTION_TAG_RAISE_TO, DEFAULT_TAG_CHECK_CALL_ANY, DEFAULT_TAG_CHECK_FOLD, DOMAIN_ACTION,
    DOMAIN_DEFAULT, DOMAIN_PREDICTION,
};

pub use events::{
    DepositConfirmed, FormationBootstrapped, FormationDissolved, MatchStarted, ProfileDelta,
    StartPolicyAction, StartPolicyResult, StartPolicyTrigger, StartPolicyTriggered,
    EVENT_SCHEMA_VERSION,
};
pub use oracle::{
    first_valid_oracle_update, validate_oracle_update, FeedId, OraclePriceUpdate, OracleValidation,
    VerifiedOraclePrice,
};
pub use pots::{build_pots, Pot, PotLayout};
pub use settle::{settle, verify_settlement, Award, SettleInput, SettleResult};
pub use types::{Chips, CoreError, PlayerId, PlayerState, Price};
