//! Core integer domain types. No floating point goes near money or prices (`04 §1`).

/// Chips are integers in the betting token's smallest unit (e.g. micro-USDC).
pub type Chips = u64;

/// Fixed-point price = `round(price * 10^d)` at the feed's precision `d`, stored as
/// `i128`. Distances are computed as exact integers (`04 §1, §13`).
pub type Price = i128;

/// Stable per-match player identifier (seat-derived). `u16` is ample for 2–5 seats
/// but keeps the type future-proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlayerId(pub u16);

/// A player's terminal state, as consumed by settlement (`04 §9, §13`).
///
/// `contribution` is the cumulative chips committed across *all* streets; folded
/// players' contributions remain as dead money in the lowest pot layers they
/// reached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayerState {
    pub id: PlayerId,
    /// Cumulative chips contributed across all betting streets.
    pub contribution: Chips,
    /// True if the player folded (forfeits chips; ineligible to win any pot).
    pub folded: bool,
    /// Decrypted prediction (fixed-point). Required for non-folded players that
    /// reach a *contested* pot; ignored for folded players and uncontested layers.
    pub prediction: Option<Price>,
    /// Seal sequence number — earlier seal ⇒ smaller value. Deterministic tiebreak
    /// for indivisible remainders (`04 §13`).
    pub seal_seq: u64,
}

/// Errors that force the caller to take a deterministic, capital-safe path
/// (typically VOID + refund). Never panics on adversarial input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreError {
    /// Fewer valid oracle samples than required ⇒ VOID (`04 §11`).
    InsufficientOracleSamples,
    /// Conservation invariant violated ⇒ VOID; this is a hard bug signal (`04 §0`).
    ConservationViolation,
    /// A contender in a contested pot lacked a decrypted prediction (should be
    /// impossible under time-lock auto-decrypt; surfaced rather than panicked).
    MissingPrediction,
    /// A submitted settlement did not match the independent recomputation ⇒ do NOT
    /// release funds; escalate/VOID (`04 §18`). Used by [`crate::verify_settlement`].
    SettlementMismatch,
}
