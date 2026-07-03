//! Map the deterministic settlement result onto per-engine-seat on-chain payouts.
//!
//! The program requires exactly `confirmed_count` payout entries (zero amounts included)
//! and enforces `Σ payouts == confirmed_count × buy_in − rake ≤ rake_cap`. We re-check
//! both here so a mapping bug dead-letters instead of burning a failed transaction.

use syndicate_chain::settle_args::SeatPayout;
use syndicate_shared::{PlayerState, SettleResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayoutError(pub String);

impl std::fmt::Display for PayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "payout mapping: {}", self.0)
    }
}
impl std::error::Error for PayoutError {}

/// Fold pot awards + uncalled returns + each seat's uncontributed remainder into one
/// payout per engine seat, 0..confirmed_count. `PlayerId` in the settlement domain IS the
/// engine seat (the game-server constructs the engine with ids 0..confirmed_count).
///
/// `settle()` only accounts for chips that were *contributed* to pots (`awards + returns +
/// rake == Σ contributions`). On-chain, though, every player deposited a full `buy_in`, and
/// conservation is checked at buy-in granularity (`Σ payouts == confirmed_count × buy_in −
/// rake`). So each seat must also get its **uncontributed remainder** (`buy_in −
/// contribution`) back: a folder keeps the chips it never bet, and the pot winner gets its
/// own remainder on top of the pot. `players` carries the final per-seat contribution.
pub fn map_payouts(
    result: &SettleResult,
    players: &[PlayerState],
    confirmed_count: u8,
    buy_in: u64,
    rake_cap: u64,
) -> Result<Vec<SeatPayout>, PayoutError> {
    let n = confirmed_count as usize;
    let mut amounts = vec![0u64; n];

    let mut credit = |seat: u16, amount: u64| -> Result<(), PayoutError> {
        let idx = seat as usize;
        if idx >= n {
            return Err(PayoutError(format!(
                "award for engine seat {idx} outside confirmed set of {n}"
            )));
        }
        amounts[idx] = amounts[idx]
            .checked_add(amount)
            .ok_or_else(|| PayoutError("payout overflow".into()))?;
        Ok(())
    };

    for award in &result.pot_awards {
        credit(award.player.0, award.amount)?;
    }
    for (player, amount) in &result.uncalled_returns {
        credit(player.0, *amount)?;
    }
    for p in players {
        let remainder = buy_in.checked_sub(p.contribution).ok_or_else(|| {
            PayoutError(format!(
                "seat {} contribution {} exceeds buy_in {buy_in}",
                p.id.0, p.contribution
            ))
        })?;
        credit(p.id.0, remainder)?;
    }

    // Conservation exactly as the program enforces it.
    let deposited = (confirmed_count as u64)
        .checked_mul(buy_in)
        .ok_or_else(|| PayoutError("deposit overflow".into()))?;
    let total: u64 = amounts.iter().try_fold(0u64, |acc, a| {
        acc.checked_add(*a)
            .ok_or_else(|| PayoutError("total overflow".into()))
    })?;
    let expected = deposited
        .checked_sub(result.rake_collected)
        .ok_or_else(|| PayoutError("rake exceeds deposits".into()))?;
    if total != expected {
        return Err(PayoutError(format!(
            "conservation violated: Σ payouts {total} != {confirmed_count}×{buy_in} − rake {} = {expected}",
            result.rake_collected
        )));
    }
    if result.rake_collected > rake_cap {
        return Err(PayoutError(format!(
            "rake {} exceeds rake_cap {rake_cap}",
            result.rake_collected
        )));
    }

    Ok(amounts
        .into_iter()
        .enumerate()
        .map(|(i, amount)| SeatPayout {
            engine_seat: i as u8,
            amount,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use syndicate_shared::{Award, PlayerId, SettleResult};

    fn result(awards: &[(u16, u64)], returns: &[(u16, u64)], rake: u64) -> SettleResult {
        SettleResult {
            settlement_price: 0,
            oracle_publish_time: 0,
            pot_awards: awards
                .iter()
                .map(|(p, a)| Award {
                    player: PlayerId(*p),
                    amount: *a,
                })
                .collect(),
            uncalled_returns: returns.iter().map(|(p, a)| (PlayerId(*p), *a)).collect(),
            rake_collected: rake,
        }
    }

    /// Players with the given per-seat contributions (all non-folded, no prediction — the
    /// contribution is all `map_payouts` reads).
    fn players(contributions: &[u64]) -> Vec<PlayerState> {
        contributions
            .iter()
            .enumerate()
            .map(|(i, c)| PlayerState {
                id: PlayerId(i as u16),
                contribution: *c,
                folded: false,
                prediction: None,
                seal_seq: 0,
            })
            .collect()
    }

    #[test]
    fn maps_awards_returns_and_zero_seats() {
        // 3 seats × 100 buy-in, all-in (contribution == buy_in, remainder 0); seat 0 wins
        // 250, seat 2 gets a 43 uncalled return, seat 1 nothing; rake 7. 250+43+0 = 293.
        let ps = players(&[100, 100, 100]);
        let payouts = map_payouts(&result(&[(0, 250)], &[(2, 43)], 7), &ps, 3, 100, 10).unwrap();
        assert_eq!(payouts.len(), 3);
        assert_eq!((payouts[0].engine_seat, payouts[0].amount), (0, 250));
        assert_eq!((payouts[1].engine_seat, payouts[1].amount), (1, 0));
        assert_eq!((payouts[2].engine_seat, payouts[2].amount), (2, 43));
    }

    #[test]
    fn returns_uncontributed_remainder_per_seat() {
        // 3 seats × buy_in 1_000_000. Only the blinds were contested: seat 0 committed
        // 5_000 (SB) and folded, seat 1 committed 10_000 (BB) and won the blind pot, seat 2
        // folded pre-blind (0). Pot = 15_000, rake 3% capped = 450 → BB nets 14_550.
        // Every seat also gets its unbet remainder back; Σ == 3_000_000 − 450.
        let ps = players(&[5_000, 10_000, 0]);
        let payouts =
            map_payouts(&result(&[(1, 14_550)], &[], 450), &ps, 3, 1_000_000, 1_000_000).unwrap();
        let total: u64 = payouts.iter().map(|p| p.amount).sum();
        assert_eq!(total, 3 * 1_000_000 - 450);
        assert_eq!(payouts[0].amount, 1_000_000 - 5_000); // SB folder keeps its remainder
        assert_eq!(payouts[1].amount, 14_550 + 1_000_000 - 10_000); // BB: pot + remainder
        assert_eq!(payouts[2].amount, 1_000_000); // untouched
    }

    #[test]
    fn conservation_violation_rejected() {
        let err = map_payouts(&result(&[(0, 100)], &[], 0), &players(&[100, 100]), 2, 100, 10)
            .unwrap_err();
        assert!(err.0.contains("conservation"), "{err}");
    }

    #[test]
    fn rake_cap_enforced() {
        let err = map_payouts(&result(&[(0, 280)], &[], 20), &players(&[100, 100, 100]), 3, 100, 10)
            .unwrap_err();
        assert!(err.0.contains("rake_cap"), "{err}");
    }

    #[test]
    fn out_of_range_seat_rejected() {
        let err =
            map_payouts(&result(&[(5, 200)], &[], 0), &players(&[100, 100]), 2, 100, 10).unwrap_err();
        assert!(err.0.contains("outside confirmed set"), "{err}");
    }
}
