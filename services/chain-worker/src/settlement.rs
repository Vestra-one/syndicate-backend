//! The v2 settlement pipeline (`submit_settlement` jobs).
//!
//! Every failure routes to a capital-safe outcome: `Wait` (retry later), `Void`
//! (enqueue the permissionless live void — full refunds), or `Fatal` (dead-letter; the
//! on-chain 300s void backstop still protects funds). Never a guessed payout.

use std::collections::BTreeMap;
use std::str::FromStr;

use deadpool_postgres::Pool;
use serde_json::{json, Value};
use solana_sdk::pubkey::Pubkey;
use uuid::Uuid;

use syndicate_chain::settle_args::SettleArgs;
use syndicate_shared::intent::ciphertext_commitment_hash;
use syndicate_shared::{
    settle, verify_settlement, PlayerId, Price, SettleInput, VerifiedOraclePrice,
};
use syndicate_timelock::TimelockScheme;

use crate::db::{self, SeatRow};
use crate::oracle::{OracleError, SignedPriceClient};
use crate::payouts::map_payouts;
use crate::timelock_open::{TimelockOpenClient, TimelockOpenRequest, TimelockOpenStatus};

/// What the executor should do with the settlement job.
pub enum SettleOutcome {
    /// Everything checked out — submit these args for these confirmed players (engine order).
    Ready {
        args: SettleArgs,
        confirmed_players: Vec<Pubkey>,
        oracle_audit: Value,
        /// Everyone but one seat folded: no price was fetched and nothing was unsealed —
        /// submit with `submit_uncontested`, which needs neither.
        uncontested: bool,
    },
    /// Not ready yet (drand round pending, oracle momentarily unavailable, engine mid-flight).
    Wait { delay_ms: u64, reason: String },
    /// Unsalvageable within the grace window — VOID the match (full refunds).
    Void { reason: String, audit: Value },
    /// A bug-shaped failure (self-verification, conservation) — dead-letter for a human;
    /// the permissionless void backstop protects funds meanwhile.
    Fatal { reason: String, audit: Value },
}

pub struct SettleDeps<'a> {
    pub pool: &'a Pool,
    pub oracle: &'a SignedPriceClient,
    pub timelock: &'a mut dyn TimelockOpenClient,
    pub now_unix: u64,
}

/// Feed symbol → the 20-byte token id the price server signs for (mirrors the config
/// service's ORACLE_TOKEN_BY_FEED; the authoritative copy is on the match account, but a
/// missing DB copy is recoverable from the symbol).
fn oracle_symbol(feed_symbol: &str) -> String {
    // "BTC/USD" → "BTCUSD"
    feed_symbol.replace('/', "")
}

/// Run the pipeline. `price_token` and `scheduled_end_ts` come from the ON-CHAIN match
/// account (source of truth); DB carries the seats + events + snapshot.
pub async fn prepare_settlement(
    deps: &mut SettleDeps<'_>,
    match_id: Uuid,
    price_token: [u8; 20],
    scheduled_end_ts: u64,
    confirmed_count: u8,
    idempotency_key: &str,
) -> SettleOutcome {
    // ---- 1. Load context ----------------------------------------------------------
    let row = match db::load_match_row(deps.pool, match_id).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            return SettleOutcome::Fatal {
                reason: format!("match {match_id} missing from DB"),
                audit: Value::Null,
            }
        }
        Err(e) => {
            return SettleOutcome::Wait {
                delay_ms: 2_000,
                reason: e.to_string(),
            }
        }
    };
    let seats = match db::load_settle_seats(deps.pool, match_id).await {
        Ok(seats) => seats,
        Err(e) => {
            return SettleOutcome::Wait {
                delay_ms: 2_000,
                reason: e.to_string(),
            }
        }
    };
    if seats.len() != confirmed_count as usize {
        return SettleOutcome::Fatal {
            reason: format!(
                "DB has {} engine seats, chain says {confirmed_count} confirmed",
                seats.len()
            ),
            audit: Value::Null,
        };
    }
    let (Some(buy_in), Some(rake_bps), Some(rake_cap)) =
        (row.buy_in_chips, row.rake_bps, row.rake_cap_chips)
    else {
        return SettleOutcome::Fatal {
            reason: "match row missing buy_in/rake economics".into(),
            audit: Value::Null,
        };
    };

    // ---- 2. Replay the engine (hash-chained; strongest off-chain correctness) ------
    let events = match db::load_match_events(deps.pool, match_id).await {
        Ok(ev) => ev,
        Err(e) => {
            return SettleOutcome::Wait {
                delay_ms: 2_000,
                reason: e.to_string(),
            }
        }
    };
    let snapshot = match syndicate_engine::service::FencedMatchRuntime::replay(&events) {
        Ok(s) => s,
        Err(e) => {
            return SettleOutcome::Fatal {
                reason: format!("event replay failed: {e:?}"),
                audit: Value::Null,
            }
        }
    };
    // The idempotency key pins the event root the payouts derive from.
    let replay_root = snapshot.head;
    if !idempotency_key.ends_with(&hex::encode(replay_root)) {
        return SettleOutcome::Fatal {
            reason: "event root drifted since the job was enqueued".into(),
            audit: json!({ "replay_root": hex::encode(replay_root) }),
        };
    }
    let engine = &snapshot.engine;
    if !engine.is_complete() {
        // The game-server force-resolves streets before enqueueing; a live engine here is
        // a transient ordering issue — wait, and let attempts exhaust to dead-letter.
        return SettleOutcome::Wait {
            delay_ms: 3_000,
            reason: "engine not complete yet".into(),
        };
    }
    if engine.seats.len() != confirmed_count as usize {
        return SettleOutcome::Fatal {
            reason: format!(
                "engine has {} seats, chain says {confirmed_count}",
                engine.seats.len()
            ),
            audit: Value::Null,
        };
    }

    // One seat left in the hand: it wins whatever the price does, so there is nothing to
    // unseal and no price to wait for. The hand settles now, not at its scheduled end —
    // and the folded calls stay sealed, like mucked cards.
    let uncontested = engine.seats.iter().filter(|s| !s.folded).count() == 1;

    // ---- 3. Open the timelock + decrypt sealed predictions -------------------------
    let sealed: Vec<&SeatRow> = seats.iter().filter(|s| s.is_sealed()).collect();
    let mut predictions: BTreeMap<u16, Price> = BTreeMap::new();
    let mut timelock_receipt = Value::Null;

    if uncontested {
        // settle() only needs the lone contender to hold *a* prediction.
        for s in engine.seats.iter().filter(|s| !s.folded) {
            predictions.insert(s.id.0, 1);
        }
    }
    if !sealed.is_empty() && !uncontested {
        // All seals of a match target the same bounded round (on-chain enforced window);
        // use the max as the open target.
        let target_round = sealed
            .iter()
            .filter_map(|s| s.seal_timelock_target)
            .max()
            .unwrap_or_default();
        let status = deps.timelock.open(&TimelockOpenRequest {
            target_round,
            scheduled_end_ts,
            now_ts: deps.now_unix,
        });
        let material = match status {
            TimelockOpenStatus::Available(m) => m,
            TimelockOpenStatus::Pending {
                retry_after_ms,
                reason,
            } => {
                return SettleOutcome::Wait {
                    delay_ms: retry_after_ms,
                    reason,
                }
            }
            TimelockOpenStatus::UnavailableAfterGrace { reason } => {
                return SettleOutcome::Void {
                    reason: format!("timelock unavailable after grace: {reason}"),
                    audit: json!({ "timelock": reason }),
                }
            }
            TimelockOpenStatus::Invalid { reason } => {
                return SettleOutcome::Void {
                    reason: format!("timelock invalid: {reason}"),
                    audit: json!({ "timelock": reason }),
                }
            }
        };
        timelock_receipt = json!({
            "drand_api": material.receipt.drand_api,
            "chain_hash": material.receipt.chain_hash,
            "scheme_id": material.receipt.scheme_id,
            "target_round": material.receipt.target_round,
            "signature_hash": material.receipt.signature_hash,
        });

        for seat in &sealed {
            let ciphertext = seat.seal_ciphertext.as_ref().expect("is_sealed");
            let commitment = seat.seal_commitment.expect("is_sealed");
            // Bind the ciphertext to the on-chain commitment BEFORE trusting the plaintext.
            if ciphertext_commitment_hash(ciphertext) != commitment {
                return SettleOutcome::Void {
                    reason: format!(
                        "seat {} ciphertext does not match on-chain commitment",
                        seat.engine_seat
                    ),
                    audit: json!({ "commitment_mismatch_seat": seat.engine_seat }),
                };
            }
            match material.scheme.decrypt(ciphertext, &material.round_key) {
                Some(price) => {
                    predictions.insert(seat.engine_seat as u16, price);
                }
                None => {
                    return SettleOutcome::Void {
                        reason: format!("seat {} ciphertext failed to decrypt", seat.engine_seat),
                        audit: json!({ "decrypt_failed_seat": seat.engine_seat }),
                    }
                }
            }
        }
    }

    // ---- 4. Non-sealers: seal-close spot snapshot ----------------------------------
    let non_sealers: Vec<&SeatRow> = seats.iter().filter(|s| !s.is_sealed()).collect();
    if !non_sealers.is_empty() && !uncontested {
        let snapshot_row = match db::load_seal_close_snapshot(deps.pool, match_id).await {
            Ok(Some(s)) => s,
            Ok(None) => {
                return SettleOutcome::Void {
                    reason: "non-sealers present but no seal-close spot snapshot".into(),
                    audit: Value::Null,
                }
            }
            Err(e) => {
                return SettleOutcome::Wait {
                    delay_ms: 2_000,
                    reason: e.to_string(),
                }
            }
        };
        let spot = match snapshot_price_wad(&snapshot_row) {
            Ok(p) => p,
            Err(e) => {
                return SettleOutcome::Void {
                    reason: format!("seal-close snapshot unparseable: {e}"),
                    audit: snapshot_row.signed_payload.clone(),
                }
            }
        };
        for seat in &non_sealers {
            predictions.insert(seat.engine_seat as u16, spot);
        }
    }

    // ---- 5. Company-signed settlement price at exactly scheduled_end_ts ------------
    let symbol = oracle_symbol(row.feed_symbol.as_deref().unwrap_or("BTC/USD"));
    let oracle_res = if uncontested {
        Ok(crate::oracle::ValidatedSignedPrice {
            dto: syndicate_chain::settle_args::SignedPriceDto {
                token: price_token,
                price_in_wad: [0u8; 32],
                timestamp_ms: 0,
                v: 0,
                r: [0u8; 32],
                s: [0u8; 32],
            },
            price_wad: 1,
            publish_time_sec: 0,
            payload_sha256_hex: String::new(),
            source_url: String::new(),
        })
    } else {
        tokio::task::block_in_place(|| {
            deps.oracle
                .fetch_price_at(&symbol, scheduled_end_ts, &price_token)
        })
    };
    let signed = match oracle_res {
        Ok(v) => v,
        Err(OracleError::Unavailable(e)) => {
            // Retry until the timelock grace deadline; past it, VOID.
            let grace_deadline =
                scheduled_end_ts + crate::timelock_open::ONCHAIN_SETTLE_VOID_GRACE_SEC;
            if deps.now_unix >= grace_deadline {
                return SettleOutcome::Void {
                    reason: format!("signed price unavailable past grace: {e}"),
                    audit: json!({ "oracle": e }),
                };
            }
            return SettleOutcome::Wait {
                delay_ms: 3_000,
                reason: format!("signed price unavailable: {e}"),
            };
        }
        Err(OracleError::Invalid(e)) => {
            return SettleOutcome::Void {
                reason: format!("signed price invalid: {e}"),
                audit: json!({ "oracle": e }),
            }
        }
    };

    // ---- 6. Deterministic settlement + self-verification ---------------------------
    let mut feed_id = [0u8; 32];
    feed_id[..20].copy_from_slice(&price_token);
    let oracle_price = VerifiedOraclePrice {
        feed_id,
        price: signed.price_wad,
        publish_time: signed.publish_time_sec,
        confidence: 0,
        exponent: -18,
    };
    let players = engine.to_player_states(|id: PlayerId| predictions.get(&id.0).copied());
    // Sanity: every non-folded contender must have a prediction (folded seats may not).
    if players.iter().any(|p| !p.folded && p.prediction.is_none()) {
        return SettleOutcome::Void {
            reason: "live contender without a prediction".into(),
            audit: Value::Null,
        };
    }
    let input = SettleInput {
        players: &players,
        oracle_price,
        rake_bps,
        rake_cap,
        dead_money: 0, // v2: non-sealers play; no penalty pool
    };
    let result = match settle(&input) {
        Ok(r) => r,
        Err(e) => {
            return SettleOutcome::Fatal {
                reason: format!("settle() failed: {e:?}"),
                audit: Value::Null,
            }
        }
    };
    if let Err(e) = verify_settlement(&input, &result) {
        return SettleOutcome::Fatal {
            reason: format!("self-verification failed: {e:?}"),
            audit: Value::Null,
        };
    }

    // ---- 7. Map to on-chain payouts + final conservation ---------------------------
    let payouts = match map_payouts(&result, &players, confirmed_count, buy_in, rake_cap) {
        Ok(p) => p,
        Err(e) => {
            return SettleOutcome::Fatal {
                reason: e.to_string(),
                audit: Value::Null,
            }
        }
    };

    let confirmed_players: Vec<Pubkey> = match seats
        .iter()
        .map(|s| Pubkey::from_str(&s.wallet))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(p) => p,
        Err(e) => {
            return SettleOutcome::Fatal {
                reason: format!("bad wallet in match_seats: {e}"),
                audit: Value::Null,
            }
        }
    };

    // Winner signal: `settle()`'s pot_awards, NOT the final on-chain payout — the payout
    // also folds in each seat's uncontributed remainder (buy_in − contribution), so a
    // seat that folded pre-bet still gets a payout close to its buy-in back without
    // having won anything.
    let pot_won = pot_won_per_seat(&result.pot_awards, confirmed_count);
    let final_pot_chips = final_pot_chips(&result.pot_awards, result.rake_collected);

    let oracle_audit = json!({
        "signed_price_sha256": signed.payload_sha256_hex,
        "signed_price_source": signed.source_url,
        "publish_time_sec": signed.publish_time_sec,
        "settlement_price_wad": if uncontested { Value::Null } else { json!(result.settlement_price.to_string()) },
        "uncontested": uncontested,
        "rake_collected": result.rake_collected,
        "final_pot_chips": final_pot_chips,
        "event_root": hex::encode(replay_root),
        "timelock": timelock_receipt,
        "predictions": seats.iter().map(|s| json!({
            "engine_seat": s.engine_seat,
            "wallet": s.wallet,
            "source": if s.is_sealed() { "sealed" } else { "spot" },
            "prediction_wad": if uncontested { None } else { predictions.get(&(s.engine_seat as u16)).map(|p| p.to_string()) },
            "payout_chips": payouts.iter()
                .find(|p| p.engine_seat == s.engine_seat)
                .map(|p| p.amount),
            "pot_won_chips": pot_won.get(s.engine_seat as usize).copied(),
        })).collect::<Vec<_>>(),
    });

    SettleOutcome::Ready {
        args: SettleArgs {
            signed_price: signed.dto,
            rake_collected: result.rake_collected,
            payouts,
        },
        confirmed_players,
        oracle_audit,
        uncontested,
    }
}

/// Per-engine-seat pot winnings (the winner signal — see the doc comment on migration
/// 0013). Seats with no award stay 0.
fn pot_won_per_seat(pot_awards: &[syndicate_shared::Award], confirmed_count: u8) -> Vec<u64> {
    let mut pot_won = vec![0u64; confirmed_count as usize];
    for award in pot_awards {
        if let Some(slot) = pot_won.get_mut(award.player.0 as usize) {
            *slot = slot.saturating_add(award.amount);
        }
    }
    pot_won
}

/// The contested pot before rake: Σ pot_awards + rake_collected.
fn final_pot_chips(pot_awards: &[syndicate_shared::Award], rake_collected: u64) -> u64 {
    pot_awards
        .iter()
        .map(|a| a.amount)
        .sum::<u64>()
        .saturating_add(rake_collected)
}

/// Parse the seal-close snapshot into the settlement price domain (i128, exp −18).
/// Prefers the exact `priceInWad` from the signed payload; falls back to the numeric
/// column + exponent.
fn snapshot_price_wad(snapshot: &db::SealCloseSnapshot) -> Result<i128, String> {
    // The signed-price-server payload carries the exact integer wad as top-level
    // `price_in_wad` (snake_case). Prefer it — the human `price` string can carry f64
    // formatting noise (e.g. "61978.565000…0003") that the decimal fallback can't scale.
    if let Some(wad) = snapshot
        .signed_payload
        .pointer("/price_in_wad")
        .and_then(Value::as_str)
    {
        return wad.parse::<i128>().map_err(|e| format!("price_in_wad: {e}"));
    }
    // Numeric text like "64123.500000" with exponent −18: scale to wad.
    decimal_to_wad(&snapshot.price_text, snapshot.exponent)
}

/// Convert a human-scale decimal string into i128 exp −18 (integer math only). The
/// snapshot's `exponent` column is always −18 in v2 and is kept for audit only.
fn decimal_to_wad(text: &str, _exponent: i32) -> Result<i128, String> {
    let text = text.trim();
    let (int_part, frac_part) = match text.split_once('.') {
        Some((i, f)) => (i, f),
        None => (text, ""),
    };
    // Clamp fractional precision to the wad scale (exp −18). Anything beyond 18 places is
    // below the representable resolution — and float-formatting noise there (e.g.
    // "…0000003") would otherwise blow past i128 when concatenated. Truncate, don't error.
    let frac_part: String = frac_part.chars().take(18).collect();
    let frac_part = frac_part.trim_end_matches('0');
    let digits: String = format!("{int_part}{frac_part}");
    let value: i128 = digits.parse().map_err(|e| format!("bad decimal: {e}"))?;
    let scale = 18i32 - frac_part.len() as i32;
    value
        .checked_mul(10i128.pow(scale.max(0) as u32))
        .ok_or_else(|| "wad overflow".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use syndicate_shared::{Award, PlayerId};

    #[test]
    fn pot_won_per_seat_credits_only_awarded_seats() {
        let awards = vec![
            Award { player: PlayerId(0), amount: 250 },
            Award { player: PlayerId(2), amount: 10 },
            Award { player: PlayerId(0), amount: 5 }, // main + side pot for the same seat
        ];
        let pot_won = pot_won_per_seat(&awards, 3);
        assert_eq!(pot_won, vec![255, 0, 10]);
    }

    #[test]
    fn pot_won_per_seat_ignores_out_of_range_awards() {
        // Defensive: an award referencing a seat beyond confirmed_count must not panic.
        let awards = vec![Award { player: PlayerId(9), amount: 100 }];
        assert_eq!(pot_won_per_seat(&awards, 2), vec![0, 0]);
    }

    #[test]
    fn final_pot_chips_is_awards_plus_rake() {
        let awards = vec![
            Award { player: PlayerId(0), amount: 250 },
            Award { player: PlayerId(1), amount: 43 },
        ];
        assert_eq!(final_pot_chips(&awards, 7), 300);
        assert_eq!(final_pot_chips(&[], 0), 0);
    }

    #[test]
    fn decimal_to_wad_scales() {
        assert_eq!(decimal_to_wad("1", -18).unwrap(), 1_000_000_000_000_000_000);
        assert_eq!(
            decimal_to_wad("64123.5", -18).unwrap(),
            64_123_500_000_000_000_000_000
        );
        assert_eq!(decimal_to_wad("0.000001", -18).unwrap(), 1_000_000_000_000);
    }

    #[test]
    fn decimal_to_wad_truncates_float_noise() {
        // f64-formatting noise past 18 places must be truncated, not overflow the i128 parse.
        let noisy = "61978.5650000000000000000000000000000000000000000000000000000000000000000000003";
        assert_eq!(
            decimal_to_wad(noisy, -18).unwrap(),
            61_978_565_000_000_000_000_000
        );
    }

    #[test]
    fn snapshot_prefers_signed_price_in_wad() {
        let snap = db::SealCloseSnapshot {
            price_text: "61978.565000000000000000000000000000003".into(),
            exponent: -18,
            signed_payload: serde_json::json!({ "price_in_wad": "61978565000000000000000" }),
        };
        // Uses the exact signed integer wad, ignoring the noisy human price string.
        assert_eq!(snapshot_price_wad(&snap).unwrap(), 61_978_565_000_000_000_000_000);
    }

    #[test]
    fn oracle_symbol_strips_slash() {
        assert_eq!(oracle_symbol("BTC/USD"), "BTCUSD");
    }
}
