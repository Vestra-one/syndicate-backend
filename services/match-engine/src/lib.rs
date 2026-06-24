//! # syndicate-engine — authoritative match engine core
//!
//! Pure, deterministic gameplay logic: the betting state machine, action legality,
//! turn order (incl. heads-up), blinds-posted-once, contribution tracking across
//! streets, and end-condition detection (`04_GAME_MECHANICS §3, §6, §7, §16`).
//!
//! It emits the per-player contributions/fold status that `syndicate-shared` settles —
//! and, by design, **never sees a prediction** (those are time-lock-sealed and merged
//! in only at settlement). Networking, the signed hash-chained log, single-writer
//! leasing, and timers-on-a-clock layer on top of this core (Phase 5 service work).

use syndicate_shared::{Chips, PlayerId, PlayerState, Price};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// Match running; betting in progress.
    Live,
    /// Last street closed with ≥2 contenders → needs price + predictions (showdown).
    Settlement,
    /// Hand ended uncontested (all but one folded) → settle immediately, no prediction.
    Done,
}

/// Player actions. `BetTo`/`RaiseTo` carry the *total* street commitment after the
/// action (no-limit "bet/raise to X"); `AllIn` commits the entire remaining stack.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Fold,
    Check,
    Call,
    BetTo(Chips),
    RaiseTo(Chips),
    AllIn,
}

/// Pre-signed default executed on timeout (`04 §8`). `CheckFold` = check when free,
/// else fold. `CheckCallAny` = check when free, else call any amount.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DefaultAction {
    CheckFold,
    CheckCallAny,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EngineError {
    BadPhase,
    NotYourTurn,
    CannotCheck,
    NothingToCall,
    MustRaiseNotBet,
    MustBetNotRaise,
    BetTooSmall,
    RaiseTooSmall,
    InsufficientStack,
    NoChips,
}

#[derive(Clone, Debug)]
pub struct Seat {
    pub id: PlayerId,
    pub stack: Chips,
    pub street_committed: Chips,
    pub total_contribution: Chips,
    pub folded: bool,
    pub all_in: bool,
    pub seal_seq: u64,
}

#[derive(Clone, Debug)]
pub struct Engine {
    pub phase: Phase,
    pub seats: Vec<Seat>,
    pub button: usize,
    pub small_blind: Chips,
    pub big_blind: Chips,
    pub round: u8,
    pub round_count: u8,
    pub current_bet: Chips,
    pub last_raise_size: Chips,
    pub to_act: Option<usize>,
    has_acted: Vec<bool>,
}

impl Engine {
    /// Start a match: seat the players, assign the button, post blinds **once** (round
    /// 1 only, `04 §6`), and set first to act. `seats` are in clockwise order.
    pub fn new(
        players: Vec<(PlayerId, Chips, u64)>, // (id, starting stack, seal_seq)
        button: usize,
        small_blind: Chips,
        big_blind: Chips,
        round_count: u8,
    ) -> Self {
        assert!(players.len() >= 2 && players.len() <= 5, "2..=5 players");
        let n = players.len();
        let seats: Vec<Seat> = players
            .into_iter()
            .map(|(id, stack, seal_seq)| Seat {
                id,
                stack,
                street_committed: 0,
                total_contribution: 0,
                folded: false,
                all_in: false,
                seal_seq,
            })
            .collect();
        let mut e = Engine {
            phase: Phase::Live,
            seats,
            button,
            small_blind,
            big_blind,
            round: 1,
            round_count,
            current_bet: 0,
            last_raise_size: big_blind,
            to_act: None,
            has_acted: vec![false; n],
        };

        // Blind positions (heads-up: button posts SB).
        let (sb_idx, bb_idx) = if n == 2 {
            (button, (button + 1) % n)
        } else {
            ((button + 1) % n, (button + 2) % n)
        };
        e.commit(sb_idx, small_blind);
        e.commit(bb_idx, big_blind);
        e.current_bet = e.seats.iter().map(|s| s.street_committed).max().unwrap_or(0);
        e.last_raise_size = big_blind;

        // First to act: heads-up → button/SB; otherwise UTG (left of BB).
        e.to_act = if n == 2 {
            e.contender_at_or_after(sb_idx)
        } else {
            e.contender_at_or_after((bb_idx + 1) % n)
        };
        e
    }

    // ---- public queries ----

    pub fn to_call(&self, idx: usize) -> Chips {
        self.current_bet.saturating_sub(self.seats[idx].street_committed)
    }

    /// The action a timeout would apply for a seat given its pre-signed default
    /// (`04 §8`). Never folds a free check.
    pub fn default_action(&self, idx: usize, default: DefaultAction) -> Action {
        if self.to_call(idx) == 0 {
            Action::Check
        } else {
            match default {
                DefaultAction::CheckFold => Action::Fold,
                DefaultAction::CheckCallAny => Action::Call,
            }
        }
    }

    /// Apply a player's pre-signed default / safe auto-action on timeout.
    pub fn apply_timeout(&mut self, idx: usize, default: DefaultAction) -> Result<(), EngineError> {
        let a = self.default_action(idx, default);
        self.apply(idx, a)
    }

    pub fn is_complete(&self) -> bool {
        matches!(self.phase, Phase::Settlement | Phase::Done)
    }

    // ---- core: apply an action ----

    pub fn apply(&mut self, idx: usize, action: Action) -> Result<(), EngineError> {
        if self.phase != Phase::Live {
            return Err(EngineError::BadPhase);
        }
        if self.to_act != Some(idx) {
            return Err(EngineError::NotYourTurn);
        }
        let cb = self.current_bet;
        let committed = self.seats[idx].street_committed;
        let to_call = cb.saturating_sub(committed);

        match action {
            Action::Fold => {
                self.seats[idx].folded = true;
            }
            Action::Check => {
                if to_call != 0 {
                    return Err(EngineError::CannotCheck);
                }
            }
            Action::Call => {
                if to_call == 0 {
                    return Err(EngineError::NothingToCall);
                }
                let pay = to_call.min(self.seats[idx].stack);
                self.commit(idx, pay);
            }
            Action::BetTo(total) => {
                if cb != 0 {
                    return Err(EngineError::MustRaiseNotBet);
                }
                let max = committed + self.seats[idx].stack;
                if total > max {
                    return Err(EngineError::InsufficientStack);
                }
                let all_in = total == max;
                if !all_in && total < self.big_blind {
                    return Err(EngineError::BetTooSmall);
                }
                self.commit(idx, total - committed);
                self.current_bet = self.seats[idx].street_committed;
                self.last_raise_size = self.current_bet;
                self.reset_acted_except(idx);
            }
            Action::RaiseTo(total) => {
                if cb == 0 {
                    return Err(EngineError::MustBetNotRaise);
                }
                let max = committed + self.seats[idx].stack;
                if total > max {
                    return Err(EngineError::InsufficientStack);
                }
                if total <= cb {
                    return Err(EngineError::RaiseTooSmall);
                }
                let all_in = total == max;
                let raise_increment = total - cb;
                let full = raise_increment >= self.last_raise_size;
                if !full && !all_in {
                    return Err(EngineError::RaiseTooSmall);
                }
                self.commit(idx, total - committed);
                self.current_bet = self.seats[idx].street_committed.max(self.current_bet);
                if full {
                    self.last_raise_size = raise_increment;
                    self.reset_acted_except(idx);
                }
            }
            Action::AllIn => {
                let stack = self.seats[idx].stack;
                if stack == 0 {
                    return Err(EngineError::NoChips);
                }
                let total = committed + stack;
                if cb == 0 {
                    self.commit(idx, stack);
                    self.current_bet = self.seats[idx].street_committed;
                    self.last_raise_size = self.current_bet.max(self.big_blind);
                    self.reset_acted_except(idx);
                } else if total > cb {
                    let raise_increment = total - cb;
                    let full = raise_increment >= self.last_raise_size;
                    self.commit(idx, stack);
                    self.current_bet = self.seats[idx].street_committed;
                    if full {
                        self.last_raise_size = raise_increment;
                        self.reset_acted_except(idx);
                    }
                } else {
                    // All-in for ≤ current bet: a (short) call.
                    self.commit(idx, stack);
                }
            }
        }

        self.has_acted[idx] = true;
        self.advance_after(idx);
        Ok(())
    }

    // ---- settlement inputs (predictions merged in externally) ----

    /// Build `syndicate_shared::PlayerState`s. `prediction_of` supplies the
    /// time-lock-decrypted prediction for non-folded players (the engine itself never
    /// holds predictions). Folded players carry `None`.
    pub fn to_player_states(
        &self,
        prediction_of: impl Fn(PlayerId) -> Option<Price>,
    ) -> Vec<PlayerState> {
        self.seats
            .iter()
            .map(|s| PlayerState {
                id: s.id,
                contribution: s.total_contribution,
                folded: s.folded,
                prediction: if s.folded { None } else { prediction_of(s.id) },
                seal_seq: s.seal_seq,
            })
            .collect()
    }

    // ---- internals ----

    fn commit(&mut self, idx: usize, amount: Chips) {
        let s = &mut self.seats[idx];
        let pay = amount.min(s.stack);
        s.stack -= pay;
        s.street_committed += pay;
        s.total_contribution += pay;
        if s.stack == 0 {
            s.all_in = true;
        }
    }

    fn reset_acted_except(&mut self, idx: usize) {
        for i in 0..self.seats.len() {
            if i != idx && !self.seats[i].folded && !self.seats[i].all_in {
                self.has_acted[i] = false;
            }
        }
    }

    fn active_count(&self) -> usize {
        self.seats.iter().filter(|s| !s.folded).count()
    }

    /// Players who can still act (non-folded and non-all-in). Betting is only possible
    /// while ≥2 contenders remain.
    fn contender_count(&self) -> usize {
        self.seats.iter().filter(|s| !s.folded && !s.all_in).count()
    }

    fn advance_after(&mut self, idx: usize) {
        if self.active_count() <= 1 {
            self.phase = Phase::Done; // uncontested (`04 §16`)
            self.to_act = None;
            return;
        }
        if self.is_street_closed() {
            // ≤1 contender (the rest all-in) ⇒ no further betting; run out to showdown.
            if self.contender_count() <= 1 {
                self.phase = Phase::Settlement;
                self.to_act = None;
            } else {
                self.advance_street();
            }
            return;
        }
        self.to_act = self.next_contender_after(idx);
        if self.to_act.is_none() {
            // No other contender can act ⇒ betting is finished.
            self.phase = Phase::Settlement;
        }
    }

    fn is_street_closed(&self) -> bool {
        let contenders: Vec<usize> = (0..self.seats.len())
            .filter(|&i| !self.seats[i].folded && !self.seats[i].all_in)
            .collect();
        if contenders.is_empty() {
            return true; // everyone remaining is all-in
        }
        contenders
            .iter()
            .all(|&i| self.has_acted[i] && self.seats[i].street_committed == self.current_bet)
    }

    fn advance_street(&mut self) {
        for s in &mut self.seats {
            s.street_committed = 0;
        }
        self.current_bet = 0;
        self.last_raise_size = self.big_blind;
        for h in &mut self.has_acted {
            *h = false;
        }
        self.round += 1;
        if self.round > self.round_count {
            self.phase = Phase::Settlement;
            self.to_act = None;
            return;
        }
        self.to_act = self.contender_at_or_after((self.button + 1) % self.seats.len());
        if self.to_act.is_none() {
            // No one can act (all remaining all-in): run remaining streets out.
            self.advance_street();
        }
    }

    /// First contender (non-folded, non-all-in) at `start` or after, cyclically.
    fn contender_at_or_after(&self, start: usize) -> Option<usize> {
        let n = self.seats.len();
        (0..n)
            .map(|k| (start + k) % n)
            .find(|&i| !self.seats[i].folded && !self.seats[i].all_in)
    }

    /// Next contender strictly after `from`, cyclically.
    fn next_contender_after(&self, from: usize) -> Option<usize> {
        let n = self.seats.len();
        (1..=n)
            .map(|k| (from + k) % n)
            .find(|&i| !self.seats[i].folded && !self.seats[i].all_in)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syndicate_shared::{settle, SettleInput};

    fn pid(n: u16) -> PlayerId {
        PlayerId(n)
    }

    /// 3-handed, blinds 1/2, button=0 → SB=1, BB=2, UTG=0 acts first.
    fn three_handed() -> Engine {
        Engine::new(vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)], 0, 1, 2, 3)
    }

    #[test]
    fn blinds_posted_once_and_first_to_act() {
        let e = three_handed();
        assert_eq!(e.seats[1].total_contribution, 1); // SB
        assert_eq!(e.seats[2].total_contribution, 2); // BB
        assert_eq!(e.current_bet, 2);
        assert_eq!(e.to_act, Some(0)); // UTG
    }

    #[test]
    fn cannot_check_facing_a_bet() {
        let mut e = three_handed();
        assert_eq!(e.apply(0, Action::Check), Err(EngineError::CannotCheck));
    }

    #[test]
    fn raise_below_min_is_rejected() {
        let mut e = three_handed();
        // current_bet=2, min raise size=2 → min legal raise-to = 4. RaiseTo(3) illegal.
        assert_eq!(e.apply(0, Action::RaiseTo(3)), Err(EngineError::RaiseTooSmall));
    }

    #[test]
    fn fold_to_one_player_is_uncontested() {
        let mut e = three_handed();
        e.apply(0, Action::Fold).unwrap();
        e.apply(1, Action::Fold).unwrap(); // SB folds
        // Only BB (seat 2) remains → Done (uncontested).
        assert_eq!(e.phase, Phase::Done);
        // Settlement via shared: single eligible wins; conservation holds.
        let players = e.to_player_states(|_| None);
        let input = SettleInput { players: &players, settlement_samples: &[100], min_samples: 1, rake_bps: 0, rake_cap: 0 };
        let r = settle(&input).unwrap();
        // BB wins the 1 (SB dead money); BB's own 2 is uncalled → returned. Total out == 3 in.
        let total_out: u64 = r.pot_awards.iter().map(|a| a.amount).sum::<u64>()
            + r.uncalled_returns.iter().map(|(_, c)| *c).sum::<u64>();
        assert_eq!(total_out, 3);
        assert!(r.pot_awards.iter().all(|a| a.player == pid(2)));
    }

    #[test]
    fn limped_hand_runs_to_settlement_and_settles_by_prediction() {
        let mut e = three_handed();
        e.apply(0, Action::Call).unwrap(); // UTG calls 2
        e.apply(1, Action::Call).unwrap(); // SB completes to 2
        e.apply(2, Action::Check).unwrap(); // BB checks option → street 1 closes
        // Rounds 2 & 3: everyone checks.
        for _ in 0..2 {
            // first to act is left of button = seat 1
            assert_eq!(e.phase, Phase::Live);
            e.apply(1, Action::Check).unwrap();
            e.apply(2, Action::Check).unwrap();
            e.apply(0, Action::Check).unwrap();
        }
        assert_eq!(e.phase, Phase::Settlement);
        // Each contributed 2 → pot 6.
        let preds = |id: PlayerId| match id.0 {
            0 => Some(100_010_i128),
            1 => Some(99_000),
            2 => Some(100_500),
            _ => None,
        };
        let players = e.to_player_states(preds);
        let input = SettleInput { players: &players, settlement_samples: &[100_000], min_samples: 1, rake_bps: 0, rake_cap: 0 };
        let r = settle(&input).unwrap();
        // Seat 0 closest (dist 10) wins the whole 6.
        assert_eq!(r.pot_awards, vec![syndicate_shared::Award { player: pid(0), amount: 6 }]);
    }

    #[test]
    fn all_in_creates_side_pot_inputs() {
        // Heads-up, unequal effective via short all-in. button=0 → SB=0(button), BB=1.
        let mut e = Engine::new(vec![(pid(0), 40, 0), (pid(1), 100, 1)], 0, 1, 2, 3);
        // Preflop heads-up: button/SB (seat 0) acts first.
        e.apply(0, Action::AllIn).unwrap(); // seat0 all-in for 40 total
        // seat1 calls the 40.
        e.apply(1, Action::Call).unwrap();
        assert!(e.is_complete());
        let players = e.to_player_states(|id| if id.0 == 0 { Some(100_000) } else { Some(100_050) });
        let input = SettleInput { players: &players, settlement_samples: &[100_000], min_samples: 1, rake_bps: 0, rake_cap: 0 };
        let r = settle(&input).unwrap();
        // Contributions 40 & 40 → one pot of 80; seat0 closer → wins 80; seat1's uncalled 0.
        assert_eq!(r.pot_awards, vec![syndicate_shared::Award { player: pid(0), amount: 80 }]);
    }

    #[test]
    fn timeout_auto_checks_free_and_folds_facing_bet() {
        let mut e = three_handed();
        // UTG faces a bet (BB) → CheckFold default folds.
        assert_eq!(e.default_action(0, DefaultAction::CheckFold), Action::Fold);
        e.apply(0, Action::Call).unwrap();
        e.apply(1, Action::Call).unwrap();
        e.apply(2, Action::Check).unwrap(); // close street 1
        // Round 2: seat 1 to act, nothing owed → default is Check.
        assert_eq!(e.default_action(1, DefaultAction::CheckFold), Action::Check);
    }
}
