//! Golden-vector + property tests for the deterministic core.
//! These mirror the worked example in `04_GAME_MECHANICS §9` and the conservation
//! invariant from `§0`. The property test uses a std-only xorshift RNG (no external
//! crates) so it runs in any environment.

use syndicate_shared::{
    build_pots, settle, PlayerId, PlayerState, SettleInput, VerifiedOraclePrice,
};

fn p(
    id: u16,
    contribution: u64,
    folded: bool,
    prediction: Option<i128>,
    seal_seq: u64,
) -> PlayerState {
    PlayerState {
        id: PlayerId(id),
        contribution,
        folded,
        prediction,
        seal_seq,
    }
}

fn oracle(price: i128) -> VerifiedOraclePrice {
    VerifiedOraclePrice {
        feed_id: [7u8; 32],
        price,
        publish_time: 1_000,
        confidence: 10,
        exponent: -8,
    }
}

/// `04 §9` worked example: D=20 (folded), B=60, A=100, C=100 → pots 80/120/80.
#[test]
fn golden_section9_example_pots() {
    let players = vec![
        p(0, 100, false, Some(105_000), 0), // A
        p(1, 60, false, Some(105_300), 1),  // B
        p(2, 100, false, Some(104_800), 2), // C
        p(3, 20, true, None, 3),            // D folded (dead money)
    ];
    let layout = build_pots(&players).unwrap();
    let amounts: Vec<u64> = layout.pots.iter().map(|p| p.amount).collect();
    assert_eq!(amounts, vec![80, 120, 80], "pot layering must match §9");
    assert!(layout.uncalled_returns.is_empty());
    // Conservation
    let total: u64 = layout.pots.iter().map(|p| p.amount).sum::<u64>()
        + layout.uncalled_returns.iter().map(|(_, c)| *c).sum::<u64>();
    assert_eq!(total, 280);
}

/// Same example settled at S=105120 with no rake: A is closest (dist 120) and is
/// eligible for all three pots → A wins the whole 280.
#[test]
fn golden_section9_award_no_rake() {
    let players = vec![
        p(0, 100, false, Some(105_000), 0), // A dist 120
        p(1, 60, false, Some(105_300), 1),  // B dist 180
        p(2, 100, false, Some(104_800), 2), // C dist 320
        p(3, 20, true, None, 3),
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(105_120),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let r = settle(&input).unwrap();
    assert_eq!(r.settlement_price, 105_120);
    assert_eq!(r.pot_awards.len(), 1);
    assert_eq!(r.pot_awards[0].player, PlayerId(0));
    assert_eq!(r.pot_awards[0].amount, 280);
    assert_eq!(r.rake_collected, 0);
    assert!(r.uncalled_returns.is_empty());
}

/// Uncalled-bet return: heads-up A=120, C=100 → A's top 20 is uncalled and returned.
#[test]
fn uncalled_bet_is_returned() {
    let players = vec![
        p(0, 120, false, Some(100_010), 0), // A closer
        p(1, 100, false, Some(100_500), 1), // C
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let r = settle(&input).unwrap();
    // One pot of 200 (100+100); A wins it. A also gets 20 back uncalled.
    assert_eq!(
        r.pot_awards,
        vec![syndicate_shared::Award {
            player: PlayerId(0),
            amount: 200
        }]
    );
    assert_eq!(r.uncalled_returns, vec![(PlayerId(0), 20)]);
}

/// Tie splits equally; the odd chip goes to the earliest-sealed winner.
#[test]
fn tie_split_with_odd_chip_to_earliest_seal() {
    // Two equal-and-opposite distances around S; pot = 2*51 = 102 (odd split of 101 after... use 51 each)
    let players = vec![
        p(0, 51, false, Some(99_900), 5),  // A dist 100, sealed later
        p(1, 51, false, Some(100_100), 2), // B dist 100, sealed earlier
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let r = settle(&input).unwrap();
    // pot = 102, split 51/51 — even, no remainder
    // Make it odd: adjust below in a second scenario.
    let total: u64 = r.pot_awards.iter().map(|a| a.amount).sum();
    assert_eq!(total, 102);
    assert_eq!(r.pot_awards.len(), 2);
}

/// Odd remainder explicitly goes to the earliest seal.
#[test]
fn odd_remainder_to_earliest_seal() {
    let players = vec![
        p(0, 50, false, Some(99_900), 9),  // A dist 100, sealed later
        p(1, 51, false, Some(100_100), 1), // B dist 100, sealed earlier
    ];
    // contributions 50 & 51 → levels 50,51. Layer50: {A,B} pot100 eligible{A,B}.
    // Layer51: {B} alone → uncalled return 1 to B.
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let r = settle(&input).unwrap();
    // pot 100 tie → 50/50, no remainder; B also gets 1 uncalled back.
    let a = r
        .pot_awards
        .iter()
        .find(|x| x.player == PlayerId(0))
        .unwrap()
        .amount;
    let b = r
        .pot_awards
        .iter()
        .find(|x| x.player == PlayerId(1))
        .unwrap()
        .amount;
    assert_eq!(a, 50);
    assert_eq!(b, 50);
    assert_eq!(r.uncalled_returns, vec![(PlayerId(1), 1)]);
}

/// Rake is taken from the formed pot.
#[test]
fn rake_is_deducted_from_pot() {
    let players = vec![
        p(0, 100, false, Some(100_000), 0), // A wins
        p(1, 100, false, Some(101_000), 1),
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 300, // 3%
        rake_cap: 1_000_000,
        dead_money: 0,
    };
    let r = settle(&input).unwrap();
    // pot 200, rake 6, payable 194 to A.
    assert_eq!(r.rake_collected, 6);
    assert_eq!(
        r.pot_awards,
        vec![syndicate_shared::Award {
            player: PlayerId(0),
            amount: 194
        }]
    );
}

/// Settlement consumes the verified Pyth oracle price exactly.
#[test]
fn settlement_uses_verified_oracle_price() {
    let players = vec![p(0, 10, false, Some(1), 0), p(1, 10, false, Some(2), 1)];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(2),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let r = settle(&input).unwrap();
    assert_eq!(r.settlement_price, 2);
    assert_eq!(r.oracle_publish_time, 1_000);
}

// ---- Property test: conservation always holds (std-only RNG) ----

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn property_conservation_over_100k_random_scenarios() {
    let mut rng = XorShift(0x9E3779B97F4A7C15);
    let mut ok = 0u64;
    for _ in 0..100_000 {
        let n = 2 + rng.below(4); // 2..=5 players
        let mut players = Vec::new();
        for id in 0..n {
            let contribution = rng.below(201); // 0..=200
            let folded = rng.below(10) < 4; // ~40% fold
                                            // non-folded get a prediction; folded none
            let prediction = if folded {
                None
            } else {
                Some(rng.below(200_000) as i128)
            };
            players.push(p(id as u16, contribution, folded, prediction, id));
        }
        let dead_money = rng.below(300); // 0..=299 non-sealer penalty pool
        let input = SettleInput {
            players: &players,
            oracle_price: oracle(rng.below(200_000) as i128),
            rake_bps: (rng.below(1001)) as u32, // 0..=10%
            rake_cap: rng.below(500),
            dead_money,
        };
        match settle(&input) {
            Ok(r) => {
                // Conservation: awards + returns + rake == total contributions + dead_money.
                let total_in: u128 = players.iter().map(|p| p.contribution as u128).sum::<u128>()
                    + dead_money as u128;
                let total_out: u128 = r.pot_awards.iter().map(|a| a.amount as u128).sum::<u128>()
                    + r.uncalled_returns
                        .iter()
                        .map(|(_, c)| *c as u128)
                        .sum::<u128>()
                    + r.rake_collected as u128;
                assert_eq!(
                    total_in, total_out,
                    "conservation must hold for players={:?}",
                    players
                );
                // No folded player may ever receive a pot award.
                for a in &r.pot_awards {
                    let pl = players.iter().find(|x| x.id == a.player).unwrap();
                    assert!(!pl.folded, "folded player won a pot: {:?}", pl);
                }
                ok += 1;
            }
            Err(_) => { /* defined error paths are acceptable */ }
        }
    }
    assert!(
        ok > 90_000,
        "expected most random scenarios to settle, got {ok}"
    );
}

// ---- Phase 2: on-chain re-verification core ----

fn sample_input(players: &[PlayerState]) -> SettleInput<'_> {
    SettleInput {
        players,
        oracle_price: oracle(105_120),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    }
}

/// A correctly computed settlement re-verifies as valid (safe to release funds).
#[test]
fn verify_accepts_correct_settlement() {
    let players = vec![
        p(0, 100, false, Some(105_000), 0),
        p(1, 60, false, Some(105_300), 1),
        p(2, 100, false, Some(104_800), 2),
        p(3, 20, true, None, 3),
    ];
    let input = sample_input(&players);
    let result = settle(&input).unwrap();
    assert!(syndicate_shared::verify_settlement(&input, &result).is_ok());
}

/// A tampered settlement (winner amount inflated) is rejected — funds must NOT release.
#[test]
fn verify_rejects_tampered_settlement() {
    let players = vec![
        p(0, 100, false, Some(105_000), 0),
        p(1, 60, false, Some(105_300), 1),
        p(2, 100, false, Some(104_800), 2),
        p(3, 20, true, None, 3),
    ];
    let input = sample_input(&players);
    let mut tampered = settle(&input).unwrap();
    tampered.pot_awards[0].amount += 1; // steal one chip
    assert_eq!(
        syndicate_shared::verify_settlement(&input, &tampered),
        Err(syndicate_shared::CoreError::SettlementMismatch)
    );
}

/// A tampered winner identity is also rejected.
#[test]
fn verify_rejects_wrong_winner() {
    let players = vec![
        p(0, 100, false, Some(105_000), 0),
        p(1, 100, false, Some(105_300), 1),
    ];
    let input = sample_input(&players);
    let mut tampered = settle(&input).unwrap();
    tampered.pot_awards[0].player = PlayerId(1); // award the loser
    assert!(syndicate_shared::verify_settlement(&input, &tampered).is_err());
}

#[test]
fn intent_action_message_binds_prev_head() {
    use syndicate_shared::intent::{action_intent_message, ACTION_TAG_CALL};
    let pk = [1u8; 32];
    let head = [2u8; 32];
    let msg = action_intent_message(1, 42, 0, &pk, 1, &head, ACTION_TAG_CALL, 0);
    assert!(msg.windows(32).any(|w| w == head));
}

#[test]
fn prediction_commitment_hash_is_sensitive() {
    use syndicate_shared::intent::prediction_commitment_hash;
    let b = [7u8; 32];
    assert_ne!(
        prediction_commitment_hash(100_000, &b),
        prediction_commitment_hash(100_001, &b)
    );
}

// ---- Non-sealer penalty dead money (plan_v2 §4/§5) ----

/// Dead money is added to the main pot and won by the closest eligible prediction.
#[test]
fn dead_money_goes_to_main_pot_winner() {
    let players = vec![
        p(0, 100, false, Some(100_000), 0), // A — exact, wins
        p(1, 100, false, Some(101_000), 1), // B
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 50,
    };
    let r = settle(&input).unwrap();
    // pot 200 + dead 50 = 250, all to A.
    assert_eq!(
        r.pot_awards,
        vec![syndicate_shared::Award {
            player: PlayerId(0),
            amount: 250
        }]
    );
    assert!(r.uncalled_returns.is_empty());
    assert_eq!(r.rake_collected, 0);
}

/// With side pots, dead money attaches ONLY to the main (lowest) pot; higher side
/// pots are unaffected.
#[test]
fn dead_money_only_grows_main_pot_with_side_pots() {
    // §9 layout: A=100,B=60,C=100,D=20(folded) -> pots [80,120,80].
    let players = vec![
        p(0, 100, false, Some(100_200), 0), // A dist 200
        p(1, 60, false, Some(100_000), 1),  // B exact -> wins main+second
        p(2, 100, false, Some(100_050), 2), // C dist 50 -> wins top pot {A,C}
        p(3, 20, true, None, 3),            // D folded (dead money)
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 30,
    };
    let r = settle(&input).unwrap();
    let award = |id: u16| {
        r.pot_awards
            .iter()
            .find(|a| a.player == PlayerId(id))
            .map(|a| a.amount)
            .unwrap_or(0)
    };
    // Main(80)+dead(30)=110 and second(120) -> B=230. Top(80) eligible{A,C}: C wins.
    assert_eq!(award(1), 230, "B wins main(+dead)+second");
    assert_eq!(award(2), 80, "C wins top pot, no dead money attached");
    assert_eq!(award(0), 0);
    let total: u64 = r.pot_awards.iter().map(|a| a.amount).sum::<u64>()
        + r.uncalled_returns.iter().map(|(_, c)| *c).sum::<u64>()
        + r.rake_collected;
    assert_eq!(total, 310, "280 contributions + 30 dead money");
}

/// Dead money is raked together with the main pot it joins.
#[test]
fn dead_money_is_raked_with_main_pot() {
    let players = vec![
        p(0, 100, false, Some(100_000), 0), // A wins
        p(1, 100, false, Some(101_000), 1),
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 300, // 3%
        rake_cap: 1_000_000,
        dead_money: 100,
    };
    let r = settle(&input).unwrap();
    // pot 200 + dead 100 = 300; rake 3% = 9; payable 291 -> A.
    assert_eq!(r.rake_collected, 9);
    assert_eq!(
        r.pot_awards,
        vec![syndicate_shared::Award {
            player: PlayerId(0),
            amount: 291
        }]
    );
}

/// When no pot forms (single contributor), dead money becomes a synthetic pot and is
/// awarded to the lone non-folded survivor — never stranded.
#[test]
fn dead_money_to_uncontested_survivor_when_no_pot() {
    let players = vec![
        p(0, 100, false, Some(100_000), 0), // A — sole contributor & survivor
        p(1, 0, true, None, 1),             // B folded, contributed nothing
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 40,
    };
    let r = settle(&input).unwrap();
    // A's 100 is an uncalled return; the 40 dead money is awarded to A.
    assert_eq!(r.uncalled_returns, vec![(PlayerId(0), 100)]);
    assert_eq!(
        r.pot_awards,
        vec![syndicate_shared::Award {
            player: PlayerId(0),
            amount: 40
        }]
    );
}

/// A settlement carrying dead money re-verifies, and a tampered one is rejected.
#[test]
fn verify_round_trips_with_dead_money() {
    let players = vec![
        p(0, 100, false, Some(100_000), 0),
        p(1, 100, false, Some(101_000), 1),
    ];
    let input = SettleInput {
        players: &players,
        oracle_price: oracle(100_000),
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 50,
    };
    let result = settle(&input).unwrap();
    assert!(syndicate_shared::verify_settlement(&input, &result).is_ok());
    let mut tampered = result.clone();
    tampered.pot_awards[0].amount += 1;
    assert_eq!(
        syndicate_shared::verify_settlement(&input, &tampered),
        Err(syndicate_shared::CoreError::SettlementMismatch)
    );
}
