//! Side-pot construction — the canonical algorithm from `04_GAME_MECHANICS §9`.
//!
//! Pots are built once, at settlement, from each player's cumulative contribution
//! and fold status. A layer with a single contributor is an *uncalled bet* and is
//! returned, not turned into a pot. Conservation is asserted.

use crate::types::{Chips, CoreError, PlayerId, PlayerState};

/// One pot layer. `contributors` are everyone who reached the layer (incl. folded
/// dead money); `eligible` are the non-folded subset that may win it (`04 §9`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pot {
    pub amount: Chips,
    pub contributors: Vec<PlayerId>,
    pub eligible: Vec<PlayerId>,
}

/// The full pot layout: ordered pots (low → high) plus uncalled-bet returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PotLayout {
    pub pots: Vec<Pot>,
    pub uncalled_returns: Vec<(PlayerId, Chips)>,
}

/// Build pots and side pots per `04 §9`. Deterministic and integer-only.
///
/// Algorithm: take the distinct positive contribution levels ascending; for each
/// level, the layer height is `level - prev`; contributors are players whose total
/// contribution reaches the level. A single-contributor layer is an uncalled bet
/// (returned); otherwise it forms a pot of `height * contributors` whose eligible
/// winners are the non-folded contributors.
pub fn build_pots(players: &[PlayerState]) -> Result<PotLayout, CoreError> {
    let mut levels: Vec<Chips> = players
        .iter()
        .map(|p| p.contribution)
        .filter(|&c| c > 0)
        .collect();
    levels.sort_unstable();
    levels.dedup();

    let mut pots: Vec<Pot> = Vec::new();
    let mut uncalled_returns: Vec<(PlayerId, Chips)> = Vec::new();
    let mut prev: Chips = 0;

    for &level in &levels {
        let height = level - prev;

        // Contributors at this level, in deterministic id order.
        let mut contributors: Vec<PlayerId> = players
            .iter()
            .filter(|p| p.contribution >= level)
            .map(|p| p.id)
            .collect();
        contributors.sort_unstable_by_key(|id| id.0);

        if contributors.len() == 1 {
            // Uncalled bet → return to the sole contributor (`04 §9`).
            uncalled_returns.push((contributors[0], height));
        } else {
            let amount = height
                .checked_mul(contributors.len() as Chips)
                .ok_or(CoreError::ConservationViolation)?;
            let eligible: Vec<PlayerId> = players
                .iter()
                .filter(|p| !p.folded && p.contribution >= level)
                .map(|p| p.id)
                .collect();
            pots.push(Pot {
                amount,
                contributors,
                eligible,
            });
        }
        prev = level;
    }

    // Conservation: every contributed chip is accounted for in pots + returns.
    let total_in: u128 = players.iter().map(|p| p.contribution as u128).sum();
    let total_out: u128 = pots.iter().map(|p| p.amount as u128).sum::<u128>()
        + uncalled_returns
            .iter()
            .map(|(_, c)| *c as u128)
            .sum::<u128>();
    if total_in != total_out {
        return Err(CoreError::ConservationViolation);
    }

    Ok(PotLayout {
        pots,
        uncalled_returns,
    })
}
