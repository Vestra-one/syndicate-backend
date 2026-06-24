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
//! samples, and decrypted predictions are *inputs*. This is what makes the result
//! independently verifiable on-chain.

pub mod types;
pub mod pots;
pub mod settle;

pub use types::{Chips, CoreError, PlayerId, PlayerState, Price};
pub use pots::{build_pots, Pot, PotLayout};
pub use settle::{median_price, settle, verify_settlement, Award, SettleInput, SettleResult};
