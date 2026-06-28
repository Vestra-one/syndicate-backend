//! Winner determination, ties, fees, and the top-level pure `settle()` entrypoint.
//! The settlement price is a single Pyth-authenticated bounded exact-after update,
//! validated before it reaches this module.

use std::collections::BTreeMap;

use crate::pots::{build_pots, Pot};
use crate::types::{Chips, CoreError, PlayerId, PlayerState, Price};
use crate::VerifiedOraclePrice;

/// A chip award to a player (pot winnings). Returns/uncalled-bets are tracked
/// separately in [`SettleResult`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Award {
    pub player: PlayerId,
    pub amount: Chips,
}

/// Inputs to the pure settlement function. Everything here is *recorded* match
/// data, so `settle` is replayable and on-chain-verifiable (`04 §18`).
pub struct SettleInput<'a> {
    pub players: &'a [PlayerState],
    /// Single Pyth-authenticated bounded exact-after settlement price.
    pub oracle_price: VerifiedOraclePrice,
    /// Pot rake in basis points (e.g. 300 = 3%).
    pub rake_bps: u32,
    /// Per-pot rake cap in chips.
    pub rake_cap: Chips,
}

/// The deterministic settlement result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleResult {
    pub settlement_price: Price,
    pub oracle_publish_time: u64,
    /// Net pot winnings per player (one merged entry per winner, id-ordered).
    pub pot_awards: Vec<Award>,
    /// Uncalled-bet + degenerate pro-rata returns (id-ordered, merged).
    pub uncalled_returns: Vec<(PlayerId, Chips)>,
    pub rake_collected: Chips,
}

/// Compute the full, deterministic settlement (`04 §9, §11, §13, §14`).
///
/// Steps: guard the oracle window → derive `S` → build pots/side-pots → rake each
/// formed pot → award each pot to the closest eligible prediction (or the lone
/// eligible player for an uncontested layer) → assert conservation.
pub fn settle(input: &SettleInput) -> Result<SettleResult, CoreError> {
    let s = input.oracle_price.price;

    let layout = build_pots(input.players)?;

    let mut awards_raw: Vec<Award> = Vec::new();
    let mut returns_raw: Vec<(PlayerId, Chips)> = layout.uncalled_returns.clone();
    let mut rake_collected: Chips = 0;

    for pot in &layout.pots {
        if pot.eligible.is_empty() {
            // Degenerate safeguard: no eligible winner for this layer (cannot occur
            // in valid game flow). Return pro-rata to contributors — capital-safe,
            // never burns chips, preserves conservation.
            distribute_pro_rata(pot.amount, &pot.contributors, &mut returns_raw);
            continue;
        }

        let rake = pot_rake(pot.amount, input.rake_bps, input.rake_cap);
        rake_collected = rake_collected.saturating_add(rake);
        let payable = pot.amount - rake;

        let winners = winners_of(input.players, pot, s)?;
        award_split(payable, &winners, input.players, &mut awards_raw);
    }

    let pot_awards = merge_by_player(awards_raw);
    let uncalled_returns = merge_returns(returns_raw);

    // Conservation (net of fees): awards + returns + rake == total contributions.
    let total_in: u128 = input.players.iter().map(|p| p.contribution as u128).sum();
    let total_out: u128 = pot_awards.iter().map(|a| a.amount as u128).sum::<u128>()
        + uncalled_returns
            .iter()
            .map(|(_, c)| *c as u128)
            .sum::<u128>()
        + rake_collected as u128;
    if total_in != total_out {
        return Err(CoreError::ConservationViolation);
    }

    Ok(SettleResult {
        settlement_price: s,
        oracle_publish_time: input.oracle_price.publish_time,
        pot_awards,
        uncalled_returns,
        rake_collected,
    })
}

/// On-chain-style re-verification (`04 §18`): independently recompute the settlement
/// from the recorded inputs and confirm the `claimed` result matches **exactly**.
///
/// Returns `Ok(())` only if the claim is valid and funds may be released. This is the
/// function the Solana program calls (linking this same crate) before any payout, so
/// the chain never trusts the off-chain builder — it re-derives the truth. A
/// `SettlementMismatch` (or any settle error) means funds are **not** released and the
/// match is escalated/VOIDed.
pub fn verify_settlement(input: &SettleInput, claimed: &SettleResult) -> Result<(), CoreError> {
    let recomputed = settle(input)?;
    if &recomputed == claimed {
        Ok(())
    } else {
        Err(CoreError::SettlementMismatch)
    }
}

/// Pot rake = `min(bps * amount / 10_000, cap)`, clamped to the pot (`04 §14`).
fn pot_rake(amount: Chips, bps: u32, cap: Chips) -> Chips {
    let r = ((amount as u128) * (bps as u128) / 10_000u128) as u64;
    r.min(cap).min(amount)
}

fn player<'a>(players: &'a [PlayerState], id: PlayerId) -> &'a PlayerState {
    players
        .iter()
        .find(|p| p.id == id)
        .expect("eligible/contributor ids are drawn from the players slice")
}

/// Winners of a pot: the lone eligible player for an uncontested layer, otherwise
/// the eligible player(s) with the smallest `|prediction - S|` (ties included).
fn winners_of(players: &[PlayerState], pot: &Pot, s: Price) -> Result<Vec<PlayerId>, CoreError> {
    if pot.eligible.len() == 1 {
        // Uncontested layer — prediction is irrelevant (`04 §16`).
        return Ok(vec![pot.eligible[0]]);
    }
    let mut best: Option<u128> = None;
    let mut winners: Vec<PlayerId> = Vec::new();
    for &id in &pot.eligible {
        let pred = player(players, id)
            .prediction
            .ok_or(CoreError::MissingPrediction)?;
        let dist = (pred - s).unsigned_abs();
        match best {
            None => {
                best = Some(dist);
                winners = vec![id];
            }
            Some(b) if dist < b => {
                best = Some(dist);
                winners = vec![id];
            }
            Some(b) if dist == b => winners.push(id),
            _ => {}
        }
    }
    Ok(winners)
}

/// Split a payable pot equally among winners; the indivisible remainder goes to the
/// earliest-sealed winner (then lowest id) — `04 §13`.
fn award_split(
    payable: Chips,
    winners: &[PlayerId],
    players: &[PlayerState],
    out: &mut Vec<Award>,
) {
    let k = winners.len() as u64;
    let base = payable / k;
    let rem = payable % k;
    let mut ordered = winners.to_vec();
    ordered.sort_by_key(|id| {
        let p = player(players, *id);
        (p.seal_seq, p.id.0)
    });
    for (i, id) in ordered.iter().enumerate() {
        let extra = if i == 0 { rem } else { 0 };
        out.push(Award {
            player: *id,
            amount: base + extra,
        });
    }
}

/// Degenerate safeguard: return a pot pro-rata to its contributors (lowest id takes
/// the remainder). Only reachable if a layer has no eligible winner.
fn distribute_pro_rata(amount: Chips, contributors: &[PlayerId], out: &mut Vec<(PlayerId, Chips)>) {
    if contributors.is_empty() {
        return;
    }
    let k = contributors.len() as u64;
    let base = amount / k;
    let rem = amount % k;
    let mut ordered = contributors.to_vec();
    ordered.sort_unstable_by_key(|id| id.0);
    for (i, id) in ordered.iter().enumerate() {
        let extra = if i == 0 { rem } else { 0 };
        out.push((*id, base + extra));
    }
}

fn merge_by_player(awards: Vec<Award>) -> Vec<Award> {
    let mut m: BTreeMap<u16, u64> = BTreeMap::new();
    for a in awards {
        *m.entry(a.player.0).or_insert(0) += a.amount;
    }
    m.into_iter()
        .filter(|(_, amount)| *amount > 0)
        .map(|(id, amount)| Award {
            player: PlayerId(id),
            amount,
        })
        .collect()
}

fn merge_returns(returns: Vec<(PlayerId, Chips)>) -> Vec<(PlayerId, Chips)> {
    let mut m: BTreeMap<u16, u64> = BTreeMap::new();
    for (id, c) in returns {
        *m.entry(id.0).or_insert(0) += c;
    }
    m.into_iter()
        .filter(|(_, c)| *c > 0)
        .map(|(id, c)| (PlayerId(id), c))
        .collect()
}
