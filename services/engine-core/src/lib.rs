//! Pure deterministic match engine — shared off-chain (`match-engine`) and on-chain
//! (`programs` action-log replay). Zero I/O; SBF-compatible.

use borsh::{BorshDeserialize, BorshSerialize};
use syndicate_shared::{Chips, PlayerId, PlayerState, Price};

pub const MAX_SEATS: usize = 5;
pub const GENESIS_HEAD: [u8; 32] = [0u8; 32];

#[derive(Clone, Copy, PartialEq, Eq, Debug, BorshSerialize, BorshDeserialize)]
pub enum Phase {
    Live,
    Settlement,
    Done,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, BorshSerialize, BorshDeserialize)]
pub enum Action {
    Fold,
    Check,
    Call,
    BetTo(Chips),
    RaiseTo(Chips),
    AllIn,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, BorshSerialize, BorshDeserialize)]
pub enum DefaultAction {
    CheckFold,
    CheckCallAny,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, BorshSerialize, BorshDeserialize)]
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

impl BorshSerialize for Seat {
    fn serialize<W: borsh::io::Write>(&self, writer: &mut W) -> borsh::io::Result<()> {
        BorshSerialize::serialize(&self.id.0, writer)?;
        BorshSerialize::serialize(&self.stack, writer)?;
        BorshSerialize::serialize(&self.street_committed, writer)?;
        BorshSerialize::serialize(&self.total_contribution, writer)?;
        BorshSerialize::serialize(&self.folded, writer)?;
        BorshSerialize::serialize(&self.all_in, writer)?;
        BorshSerialize::serialize(&self.seal_seq, writer)?;
        Ok(())
    }
}

impl BorshDeserialize for Seat {
    fn deserialize_reader<R: borsh::io::Read>(reader: &mut R) -> borsh::io::Result<Self> {
        Ok(Self {
            id: PlayerId(BorshDeserialize::deserialize_reader(reader)?),
            stack: BorshDeserialize::deserialize_reader(reader)?,
            street_committed: BorshDeserialize::deserialize_reader(reader)?,
            total_contribution: BorshDeserialize::deserialize_reader(reader)?,
            folded: BorshDeserialize::deserialize_reader(reader)?,
            all_in: BorshDeserialize::deserialize_reader(reader)?,
            seal_seq: BorshDeserialize::deserialize_reader(reader)?,
        })
    }
}

#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
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
    pub has_acted: Vec<bool>,
}

impl Engine {
    pub fn new(
        players: Vec<(PlayerId, Chips, u64)>,
        button: usize,
        small_blind: Chips,
        big_blind: Chips,
        round_count: u8,
    ) -> Self {
        Self::with_ante(players, button, small_blind, big_blind, round_count, 0)
    }

    /// A hand where every seat first posts `ante` into the pot (dead money: it does not
    /// count toward the street's bet), then the blinds are posted as usual. The ante is
    /// what makes a single-hand match worth contesting — and worth stealing: fold
    /// everyone out and the antes are yours.
    pub fn with_ante(
        players: Vec<(PlayerId, Chips, u64)>,
        button: usize,
        small_blind: Chips,
        big_blind: Chips,
        round_count: u8,
        ante: Chips,
    ) -> Self {
        assert!(
            players.len() >= 2 && players.len() <= MAX_SEATS,
            "2..=5 players"
        );
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

        if ante > 0 {
            for idx in 0..n {
                e.post_dead(idx, ante);
            }
        }

        let (sb_idx, bb_idx) = if n == 2 {
            (button, (button + 1) % n)
        } else {
            ((button + 1) % n, (button + 2) % n)
        };
        e.commit(sb_idx, small_blind);
        e.commit(bb_idx, big_blind);
        e.current_bet = e
            .seats
            .iter()
            .map(|s| s.street_committed)
            .max()
            .unwrap_or(0);
        e.last_raise_size = big_blind;

        e.to_act = if n == 2 {
            e.contender_at_or_after(sb_idx)
        } else {
            e.contender_at_or_after((bb_idx + 1) % n)
        };
        e
    }

    pub fn to_call(&self, idx: usize) -> Chips {
        self.current_bet
            .saturating_sub(self.seats[idx].street_committed)
    }

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

    pub fn apply_timeout(&mut self, idx: usize, default: DefaultAction) -> Result<(), EngineError> {
        let a = self.default_action(idx, default);
        self.apply(idx, a)
    }

    pub fn is_complete(&self) -> bool {
        matches!(self.phase, Phase::Settlement | Phase::Done)
    }

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
                    self.commit(idx, stack);
                }
            }
        }

        self.has_acted[idx] = true;
        self.advance_after(idx);
        Ok(())
    }

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

    /// Dead money: into the pot, but not part of this street's bet to match.
    fn post_dead(&mut self, idx: usize, amount: Chips) {
        let s = &mut self.seats[idx];
        let pay = amount.min(s.stack);
        s.stack -= pay;
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

    fn contender_count(&self) -> usize {
        self.seats.iter().filter(|s| !s.folded && !s.all_in).count()
    }

    fn advance_after(&mut self, idx: usize) {
        if self.active_count() <= 1 {
            self.phase = Phase::Done;
            self.to_act = None;
            return;
        }
        if self.is_street_closed() {
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
            self.phase = Phase::Settlement;
        }
    }

    fn is_street_closed(&self) -> bool {
        let contenders: Vec<usize> = (0..self.seats.len())
            .filter(|&i| !self.seats[i].folded && !self.seats[i].all_in)
            .collect();
        if contenders.is_empty() {
            return true;
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
            self.advance_street();
        }
    }

    fn contender_at_or_after(&self, start: usize) -> Option<usize> {
        let n = self.seats.len();
        (0..n)
            .map(|k| (start + k) % n)
            .find(|&i| !self.seats[i].folded && !self.seats[i].all_in)
    }

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
    use syndicate_shared::{settle, SettleInput, VerifiedOraclePrice};

    fn pid(n: u16) -> PlayerId {
        PlayerId(n)
    }

    fn three_handed() -> Engine {
        Engine::new(
            vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)],
            0,
            1,
            2,
            3,
        )
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

    #[test]
    fn blinds_posted_once_and_first_to_act() {
        let e = three_handed();
        assert_eq!(e.seats[1].total_contribution, 1);
        assert_eq!(e.seats[2].total_contribution, 2);
        assert_eq!(e.current_bet, 2);
        assert_eq!(e.to_act, Some(0));
    }

    #[test]
    fn fold_to_one_player_is_uncontested() {
        let mut e = three_handed();
        e.apply(0, Action::Fold).unwrap();
        e.apply(1, Action::Fold).unwrap();
        assert_eq!(e.phase, Phase::Done);
        let players = e.to_player_states(|_| None);
        let input = SettleInput {
            players: &players,
            oracle_price: oracle(100),
            rake_bps: 0,
            rake_cap: 0,
            dead_money: 0,
        };
        let r = settle(&input).unwrap();
        let total_out: u64 = r.pot_awards.iter().map(|a| a.amount).sum::<u64>()
            + r.uncalled_returns.iter().map(|(_, c)| *c).sum::<u64>();
        assert_eq!(total_out, 3);
    }

    #[test]
    fn borsh_roundtrip() {
        let e = three_handed();
        let bytes = borsh::to_vec(&e).unwrap();
        let decoded: Engine = borsh::from_slice(&bytes).unwrap();
        assert_eq!(decoded.seats.len(), e.seats.len());
        assert_eq!(decoded.to_act, e.to_act);
    }

    #[test]
    fn replay_parity_three_handed_limp() {
        let mut e = three_handed();
        e.apply(0, Action::Call).unwrap();
        e.apply(1, Action::Call).unwrap();
        e.apply(2, Action::Check).unwrap();
        let bytes = borsh::to_vec(&e).unwrap();
        let decoded: Engine = borsh::from_slice(&bytes).unwrap();
        assert_eq!(
            decoded.seats[0].total_contribution,
            e.seats[0].total_contribution
        );
        assert_eq!(decoded.phase, e.phase);
    }

    #[test]
    fn antes_are_dead_money_everyone_posts() {
        let e = Engine::with_ante(
            vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)],
            0,
            1,
            2,
            3,
            10,
        );
        // Every seat is in for the ante; the blinds sit on top for seats 1 and 2.
        let in_pot: Vec<Chips> = e.seats.iter().map(|s| s.total_contribution).collect();
        assert_eq!(in_pot, vec![10, 11, 12]);
        // The ante is not part of the bet to match: the button still only owes the blind.
        assert_eq!(e.current_bet, 2);
        assert_eq!(e.to_call(0), 2);
        assert_eq!(e.seats[0].stack, 90);
    }

    #[test]
    fn folding_everyone_out_wins_the_antes() {
        let mut e = Engine::with_ante(
            vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)],
            0,
            1,
            2,
            3,
            10,
        );
        e.apply(0, Action::RaiseTo(20)).unwrap();
        e.apply(1, Action::Fold).unwrap();
        e.apply(2, Action::Fold).unwrap();
        assert!(e.is_complete());
        let players = e.to_player_states(|_| Some(100));
        let out = settle(&SettleInput {
            players: &players,
            oracle_price: oracle(100),
            rake_bps: 0,
            rake_cap: 0,
            dead_money: 0,
        })
        .unwrap();
        // Seat 0 put in 10 + 20, gets it back plus both rivals' antes and blinds (11 + 12).
        let won: Chips = out.pot_awards.iter().map(|a| a.amount).sum();
        let back: Chips = out.uncalled_returns.iter().map(|(_, c)| *c).sum();
        assert_eq!(won + back, 30 + 11 + 12);
        assert!(out.pot_awards.iter().all(|a| a.player == pid(0)));
    }
}
