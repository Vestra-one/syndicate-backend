//! Fenced match runtime used by the service layer.
//!
//! The core [`Engine`](crate::Engine) stays pure. This module adds the production
//! service mechanics around it: lease/fencing checks, replay-safe event appends,
//! snapshots, and timeout/default-action execution.

use std::collections::{HashMap, HashSet};

use syndicate_shared::{intent, Chips, PlayerId};
use syndicate_store::{chain, GENESIS};

use crate::verify::{self, VerifyError};
use crate::{Action, DefaultAction, Engine, EngineError, Phase};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchConfig {
    pub match_id: String,
    /// On-chain match PDA seed (u64 le).
    pub onchain_match_id: u64,
    pub players: Vec<(PlayerId, Chips, u64)>,
    pub button: usize,
    pub small_blind: Chips,
    pub big_blind: Chips,
    pub round_count: u8,
    pub action_timeout_ms: u64,
    pub lease_ttl_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchLease {
    pub match_id: String,
    pub owner_id: String,
    pub fencing_token: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MatchServiceError {
    LeaseHeld {
        owner_id: String,
        expires_at_ms: u64,
    },
    LeaseMismatch,
    LeaseExpired {
        expires_at_ms: u64,
    },
    InvalidIntent(&'static str),
    DuplicateIntent {
        seat_index: usize,
        nonce: u64,
    },
    Engine(EngineError),
    Replay(&'static str),
}

impl From<EngineError> for MatchServiceError {
    fn from(value: EngineError) -> Self {
        MatchServiceError::Engine(value)
    }
}

#[derive(Default)]
pub struct InMemoryLeaseCoordinator {
    records: HashMap<String, MatchLease>,
}

pub trait LeaseAuthorizer {
    fn assert_current(&self, lease: &MatchLease, now_ms: u64) -> Result<(), MatchServiceError>;
}

impl InMemoryLeaseCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(
        &mut self,
        match_id: impl Into<String>,
        owner_id: impl Into<String>,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<MatchLease, MatchServiceError> {
        let match_id = match_id.into();
        let owner_id = owner_id.into();
        match self.records.get(&match_id) {
            Some(existing) if existing.expires_at_ms > now_ms && existing.owner_id != owner_id => {
                return Err(MatchServiceError::LeaseHeld {
                    owner_id: existing.owner_id.clone(),
                    expires_at_ms: existing.expires_at_ms,
                });
            }
            _ => {}
        }

        let fencing_token = self
            .records
            .get(&match_id)
            .map(|l| l.fencing_token.saturating_add(1))
            .unwrap_or(1);
        let lease = MatchLease {
            match_id: match_id.clone(),
            owner_id,
            fencing_token,
            expires_at_ms: now_ms.saturating_add(ttl_ms),
        };
        self.records.insert(match_id, lease.clone());
        Ok(lease)
    }

    pub fn renew(
        &mut self,
        lease: &MatchLease,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<MatchLease, MatchServiceError> {
        self.assert_current(lease, now_ms)?;
        let renewed = MatchLease {
            expires_at_ms: now_ms.saturating_add(ttl_ms),
            ..lease.clone()
        };
        self.records
            .insert(renewed.match_id.clone(), renewed.clone());
        Ok(renewed)
    }

    pub fn assert_current(&self, lease: &MatchLease, now_ms: u64) -> Result<(), MatchServiceError> {
        <Self as LeaseAuthorizer>::assert_current(self, lease, now_ms)
    }
}

impl LeaseAuthorizer for InMemoryLeaseCoordinator {
    fn assert_current(&self, lease: &MatchLease, now_ms: u64) -> Result<(), MatchServiceError> {
        let Some(current) = self.records.get(&lease.match_id) else {
            return Err(MatchServiceError::LeaseMismatch);
        };
        if current.owner_id != lease.owner_id || current.fencing_token != lease.fencing_token {
            return Err(MatchServiceError::LeaseMismatch);
        }
        if current.expires_at_ms <= now_ms {
            return Err(MatchServiceError::LeaseExpired {
                expires_at_ms: current.expires_at_ms,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedActionIntent {
    pub seat_index: usize,
    pub wallet: String,
    pub nonce: u64,
    /// Hash-chain head the player signed over — must equal runtime head at apply time.
    pub prev_head: [u8; 32],
    pub signature: String,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedDefaultPolicy {
    pub seat_index: usize,
    pub wallet: String,
    pub policy: DefaultAction,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedPredictionCommitment {
    pub player_id: u16,
    pub wallet: String,
    pub seal_seq: u64,
    pub commitment: [u8; 32],
    /// 32-byte blinding factor used in H(prediction || blinding); stored for settlement reveal.
    pub blinding: [u8; 32],
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineLogEvent {
    MatchStarted {
        config: MatchConfig,
    },
    PlayerAction {
        intent: SignedActionIntent,
    },
    TimeoutDefaultApplied {
        seat_index: usize,
        default: DefaultAction,
        deadline_ms: u64,
        fired_at_ms: u64,
    },
    DefaultPolicyRegistered {
        policy: SignedDefaultPolicy,
    },
    SnapshotWritten {
        round: u8,
        phase: Phase,
    },
    PredictionSealed {
        player_id: u16,
        target_round: u64,
        ciphertext: Vec<u8>,
        commitment: SignedPredictionCommitment,
    },
    MatchCompleted {
        event_root: String,
        timelock_target_round: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventEnvelope {
    pub seq: u64,
    pub owner_fencing_token: u64,
    pub prev_hash: [u8; 32],
    pub hash: [u8; 32],
    pub event: EngineLogEvent,
}

#[derive(Clone, Debug)]
pub struct EngineSnapshot {
    pub config: MatchConfig,
    pub engine: Engine,
    pub next_seq: u64,
    pub head: [u8; 32],
    pub seen_intents: Vec<(usize, u64)>,
    pub registered_defaults: Vec<SignedDefaultPolicy>,
}

#[derive(Clone, Debug)]
pub struct FencedMatchRuntime {
    config: MatchConfig,
    lease: MatchLease,
    engine: Engine,
    events: Vec<EventEnvelope>,
    head: [u8; 32],
    seen_intents: HashSet<(usize, u64)>,
    registered_defaults: HashMap<usize, SignedDefaultPolicy>,
}

impl FencedMatchRuntime {
    pub fn start(config: MatchConfig, lease: MatchLease) -> Self {
        assert_eq!(config.match_id, lease.match_id, "lease must match config");
        let engine = Engine::new(
            config.players.clone(),
            config.button,
            config.small_blind,
            config.big_blind,
            config.round_count,
        );
        let mut runtime = Self {
            config: config.clone(),
            lease,
            engine,
            events: Vec::new(),
            head: GENESIS,
            seen_intents: HashSet::new(),
            registered_defaults: HashMap::new(),
        };
        runtime.append_event(EngineLogEvent::MatchStarted { config });
        runtime
    }

    pub fn from_snapshot(snapshot: EngineSnapshot, lease: MatchLease) -> Self {
        assert_eq!(
            snapshot.config.match_id, lease.match_id,
            "lease must match snapshot"
        );
        Self {
            config: snapshot.config,
            lease,
            engine: snapshot.engine,
            events: Vec::new(),
            head: snapshot.head,
            seen_intents: snapshot.seen_intents.into_iter().collect(),
            registered_defaults: snapshot
                .registered_defaults
                .into_iter()
                .map(|p| (p.seat_index, p))
                .collect(),
        }
    }

    pub fn register_default_policy(
        &mut self,
        leases: &impl LeaseAuthorizer,
        now_ms: u64,
        policy: SignedDefaultPolicy,
    ) -> Result<&EventEnvelope, MatchServiceError> {
        leases.assert_current(&self.lease, now_ms)?;
        self.validate_default_policy(&policy)?;
        if self.registered_defaults.contains_key(&policy.seat_index) {
            return Err(MatchServiceError::InvalidIntent(
                "default policy already registered",
            ));
        }
        self.registered_defaults
            .insert(policy.seat_index, policy.clone());
        Ok(self.append_event(EngineLogEvent::DefaultPolicyRegistered { policy }))
    }

    pub fn apply_signed_action(
        &mut self,
        leases: &impl LeaseAuthorizer,
        now_ms: u64,
        intent: SignedActionIntent,
    ) -> Result<&EventEnvelope, MatchServiceError> {
        leases.assert_current(&self.lease, now_ms)?;
        self.validate_intent(&intent)?;
        self.engine.apply(intent.seat_index, intent.action)?;
        self.seen_intents.insert((intent.seat_index, intent.nonce));
        Ok(self.append_event(EngineLogEvent::PlayerAction { intent }))
    }

    pub fn apply_timeout_default(
        &mut self,
        leases: &impl LeaseAuthorizer,
        now_ms: u64,
        seat_index: usize,
        default: DefaultAction,
        deadline_ms: u64,
    ) -> Result<&EventEnvelope, MatchServiceError> {
        leases.assert_current(&self.lease, now_ms)?;
        if now_ms < deadline_ms {
            return Err(MatchServiceError::InvalidIntent("timeout before deadline"));
        }
        if seat_index >= self.engine.seats.len() {
            return Err(MatchServiceError::InvalidIntent("seat index out of range"));
        }
        let registered =
            self.registered_defaults
                .get(&seat_index)
                .ok_or(MatchServiceError::InvalidIntent(
                    "no registered default policy",
                ))?;
        if registered.policy != default {
            return Err(MatchServiceError::InvalidIntent(
                "timeout default does not match registered policy",
            ));
        }
        self.engine.apply_timeout(seat_index, default)?;
        Ok(self.append_event(EngineLogEvent::TimeoutDefaultApplied {
            seat_index,
            default,
            deadline_ms,
            fired_at_ms: now_ms,
        }))
    }

    pub fn write_snapshot_marker(&mut self) -> &EventEnvelope {
        self.append_event(EngineLogEvent::SnapshotWritten {
            round: self.engine.round,
            phase: self.engine.phase,
        })
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let mut seen_intents: Vec<_> = self.seen_intents.iter().copied().collect();
        seen_intents.sort_unstable();
        let mut registered_defaults: Vec<_> = self.registered_defaults.values().cloned().collect();
        registered_defaults.sort_by_key(|p| p.seat_index);
        EngineSnapshot {
            config: self.config.clone(),
            engine: self.engine.clone(),
            next_seq: self.events.last().map(|e| e.seq + 1).unwrap_or(0),
            head: self.head,
            seen_intents,
            registered_defaults,
        }
    }

    pub fn replay(events: &[EventEnvelope]) -> Result<EngineSnapshot, MatchServiceError> {
        let mut head = GENESIS;
        let mut next_seq = 0;
        let mut config: Option<MatchConfig> = None;
        let mut engine: Option<Engine> = None;
        let mut seen_intents = HashSet::new();
        let mut registered_defaults = HashMap::new();

        for envelope in events {
            if envelope.seq != next_seq {
                return Err(MatchServiceError::Replay("non-contiguous event sequence"));
            }
            if envelope.prev_hash != head {
                return Err(MatchServiceError::Replay("previous hash mismatch"));
            }
            let expected_hash = hash_event(&envelope.event, envelope.owner_fencing_token, &head);
            if envelope.hash != expected_hash {
                return Err(MatchServiceError::Replay("event hash mismatch"));
            }

            match &envelope.event {
                EngineLogEvent::MatchStarted { config: c } => {
                    if next_seq != 0 || config.is_some() {
                        return Err(MatchServiceError::Replay("duplicate match start"));
                    }
                    let e = Engine::new(
                        c.players.clone(),
                        c.button,
                        c.small_blind,
                        c.big_blind,
                        c.round_count,
                    );
                    config = Some(c.clone());
                    engine = Some(e);
                }
                EngineLogEvent::PlayerAction { intent } => {
                    let Some(e) = engine.as_mut() else {
                        return Err(MatchServiceError::Replay("action before match start"));
                    };
                    if !seen_intents.insert((intent.seat_index, intent.nonce)) {
                        return Err(MatchServiceError::Replay("duplicate intent"));
                    }
                    e.apply(intent.seat_index, intent.action)?;
                }
                EngineLogEvent::TimeoutDefaultApplied {
                    seat_index,
                    default,
                    deadline_ms: _,
                    fired_at_ms: _,
                } => {
                    let Some(e) = engine.as_mut() else {
                        return Err(MatchServiceError::Replay("timeout before match start"));
                    };
                    if !registered_defaults.contains_key(seat_index) {
                        return Err(MatchServiceError::Replay(
                            "timeout without registered default",
                        ));
                    }
                    e.apply_timeout(*seat_index, *default)?;
                }
                EngineLogEvent::DefaultPolicyRegistered { policy } => {
                    if !registered_defaults
                        .insert(policy.seat_index, policy.clone())
                        .is_none()
                    {
                        return Err(MatchServiceError::Replay("duplicate default policy"));
                    }
                }
                EngineLogEvent::SnapshotWritten { .. } => {}
                EngineLogEvent::PredictionSealed { .. } => {}
                EngineLogEvent::MatchCompleted { .. } => {}
            }

            head = envelope.hash;
            next_seq += 1;
        }

        let Some(config) = config else {
            return Err(MatchServiceError::Replay("missing match start"));
        };
        let Some(engine) = engine else {
            return Err(MatchServiceError::Replay("missing engine state"));
        };
        let mut seen_intents: Vec<_> = seen_intents.into_iter().collect();
        seen_intents.sort_unstable();
        Ok(EngineSnapshot {
            config,
            engine,
            next_seq,
            head,
            seen_intents,
            registered_defaults: registered_defaults.into_values().collect(),
        })
    }

    pub fn config(&self) -> &MatchConfig {
        &self.config
    }

    pub fn lease(&self) -> &MatchLease {
        &self.lease
    }

    pub fn record_prediction_sealed(
        &mut self,
        player_id: PlayerId,
        target_round: u64,
        ciphertext: Vec<u8>,
        commitment: SignedPredictionCommitment,
    ) -> Result<&EventEnvelope, MatchServiceError> {
        self.validate_prediction_commitment(&commitment)?;
        Ok(self.append_event(EngineLogEvent::PredictionSealed {
            player_id: player_id.0,
            target_round,
            ciphertext,
            commitment,
        }))
    }

    pub fn complete_if_ready(&mut self, timelock_target_round: u64) -> Option<&EventEnvelope> {
        if !self.engine.is_complete() {
            return None;
        }
        let event_root = hex::encode(self.head);
        Some(self.append_event(EngineLogEvent::MatchCompleted {
            event_root,
            timelock_target_round,
        }))
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn events(&self) -> &[EventEnvelope] {
        &self.events
    }

    pub fn head(&self) -> [u8; 32] {
        self.head
    }

    pub fn registered_defaults(&self) -> &HashMap<usize, SignedDefaultPolicy> {
        &self.registered_defaults
    }

    fn validate_intent(&self, intent: &SignedActionIntent) -> Result<(), MatchServiceError> {
        if intent.seat_index >= self.engine.seats.len() {
            return Err(MatchServiceError::InvalidIntent("seat index out of range"));
        }
        if intent.wallet.trim().is_empty() {
            return Err(MatchServiceError::InvalidIntent("wallet is required"));
        }
        if intent.signature.trim().is_empty() {
            return Err(MatchServiceError::InvalidIntent("signature is required"));
        }
        if intent.prev_head != self.head {
            return Err(MatchServiceError::InvalidIntent("prev_head mismatch"));
        }
        if self
            .seen_intents
            .contains(&(intent.seat_index, intent.nonce))
        {
            return Err(MatchServiceError::DuplicateIntent {
                seat_index: intent.seat_index,
                nonce: intent.nonce,
            });
        }
        if allow_dev_signature(&intent.signature) {
            return Ok(());
        }
        let (tag, amount) = action_to_tag_amount(intent.action);
        let signing_match_id = match_id_signing_key(&self.config.match_id);
        verify::verify_action_intent(
            &intent.wallet,
            &intent.signature,
            signing_match_id,
            self.config.onchain_match_id,
            intent.seat_index as u16,
            intent.nonce,
            &intent.prev_head,
            tag,
            amount,
        )
        .map_err(map_verify_err)?;
        Ok(())
    }

    fn validate_default_policy(
        &self,
        policy: &SignedDefaultPolicy,
    ) -> Result<(), MatchServiceError> {
        if policy.seat_index >= self.engine.seats.len() {
            return Err(MatchServiceError::InvalidIntent("seat index out of range"));
        }
        if allow_dev_signature(&policy.signature) {
            return Ok(());
        }
        let tag = match policy.policy {
            DefaultAction::CheckFold => intent::DEFAULT_TAG_CHECK_FOLD,
            DefaultAction::CheckCallAny => intent::DEFAULT_TAG_CHECK_CALL_ANY,
        };
        verify::verify_default_policy(
            &policy.wallet,
            &policy.signature,
            match_id_signing_key(&self.config.match_id),
            self.config.onchain_match_id,
            policy.seat_index as u16,
            tag,
        )
        .map_err(map_verify_err)
    }

    fn validate_prediction_commitment(
        &self,
        commitment: &SignedPredictionCommitment,
    ) -> Result<(), MatchServiceError> {
        if commitment.blinding.iter().all(|b| *b == 0) {
            return Err(MatchServiceError::InvalidIntent("blinding is required"));
        }
        if allow_dev_signature(&commitment.signature) {
            return Ok(());
        }
        verify::verify_prediction_commitment(
            &commitment.wallet,
            &commitment.signature,
            match_id_signing_key(&self.config.match_id),
            self.config.onchain_match_id,
            commitment.player_id,
            commitment.seal_seq,
            &commitment.commitment,
        )
        .map_err(map_verify_err)
    }

    fn append_event(&mut self, event: EngineLogEvent) -> &EventEnvelope {
        let prev_hash = self.head;
        let hash = hash_event(&event, self.lease.fencing_token, &prev_hash);
        self.head = hash;
        let seq = self.events.len() as u64;
        self.events.push(EventEnvelope {
            seq,
            owner_fencing_token: self.lease.fencing_token,
            prev_hash,
            hash,
            event,
        });
        self.events.last().expect("just pushed")
    }
}

fn hash_event(event: &EngineLogEvent, fencing_token: u64, prev_hash: &[u8; 32]) -> [u8; 32] {
    chain(prev_hash, &canonical_event_bytes(event, fencing_token))
}

fn canonical_event_bytes(event: &EngineLogEvent, fencing_token: u64) -> Vec<u8> {
    let mut out = format!("token={fencing_token}|").into_bytes();
    match event {
        EngineLogEvent::MatchStarted { config } => {
            out.extend_from_slice(b"start|");
            push_config(&mut out, config);
        }
        EngineLogEvent::PlayerAction { intent } => {
            out.extend_from_slice(b"action|");
            push_usize(&mut out, intent.seat_index);
            push_str(&mut out, &intent.wallet);
            push_u64(&mut out, intent.nonce);
            out.extend_from_slice(&intent.prev_head);
            push_str(&mut out, &intent.signature);
            push_action(&mut out, intent.action);
        }
        EngineLogEvent::DefaultPolicyRegistered { policy } => {
            out.extend_from_slice(b"default_policy|");
            push_usize(&mut out, policy.seat_index);
            push_str(&mut out, &policy.wallet);
            push_default(&mut out, policy.policy);
            push_str(&mut out, &policy.signature);
        }
        EngineLogEvent::TimeoutDefaultApplied {
            seat_index,
            default,
            deadline_ms,
            fired_at_ms,
        } => {
            out.extend_from_slice(b"timeout|");
            push_usize(&mut out, *seat_index);
            push_default(&mut out, *default);
            push_u64(&mut out, *deadline_ms);
            push_u64(&mut out, *fired_at_ms);
        }
        EngineLogEvent::SnapshotWritten { round, phase } => {
            out.extend_from_slice(b"snapshot|");
            out.extend_from_slice(round.to_string().as_bytes());
            out.push(b'|');
            out.extend_from_slice(format!("{phase:?}").as_bytes());
        }
        EngineLogEvent::PredictionSealed {
            player_id,
            target_round,
            ciphertext,
            commitment,
        } => {
            out.extend_from_slice(b"prediction|");
            push_u64(&mut out, *player_id as u64);
            push_u64(&mut out, *target_round);
            push_u64(&mut out, ciphertext.len() as u64);
            out.extend_from_slice(ciphertext);
            push_str(&mut out, &commitment.wallet);
            push_u64(&mut out, commitment.seal_seq);
            out.extend_from_slice(&commitment.commitment);
            out.extend_from_slice(&commitment.blinding);
            push_str(&mut out, &commitment.signature);
        }
        EngineLogEvent::MatchCompleted {
            event_root,
            timelock_target_round,
        } => {
            out.extend_from_slice(b"completed|");
            push_str(&mut out, event_root);
            push_u64(&mut out, *timelock_target_round);
        }
    }
    out
}

fn push_config(out: &mut Vec<u8>, config: &MatchConfig) {
    push_str(out, &config.match_id);
    push_usize(out, config.button);
    push_u64(out, config.small_blind);
    push_u64(out, config.big_blind);
    out.extend_from_slice(config.round_count.to_string().as_bytes());
    out.push(b'|');
    push_u64(out, config.action_timeout_ms);
    push_u64(out, config.lease_ttl_ms);
    for (player, stack, seal_seq) in &config.players {
        out.extend_from_slice(player.0.to_string().as_bytes());
        out.push(b':');
        out.extend_from_slice(stack.to_string().as_bytes());
        out.push(b':');
        out.extend_from_slice(seal_seq.to_string().as_bytes());
        out.push(b'|');
    }
}

fn push_action(out: &mut Vec<u8>, action: Action) {
    match action {
        Action::Fold => out.extend_from_slice(b"fold|"),
        Action::Check => out.extend_from_slice(b"check|"),
        Action::Call => out.extend_from_slice(b"call|"),
        Action::BetTo(amount) => {
            out.extend_from_slice(b"bet_to:");
            push_u64(out, amount);
        }
        Action::RaiseTo(amount) => {
            out.extend_from_slice(b"raise_to:");
            push_u64(out, amount);
        }
        Action::AllIn => out.extend_from_slice(b"all_in|"),
    }
}

fn push_default(out: &mut Vec<u8>, default: DefaultAction) {
    match default {
        DefaultAction::CheckFold => out.extend_from_slice(b"check_fold|"),
        DefaultAction::CheckCallAny => out.extend_from_slice(b"check_call_any|"),
    }
}

fn push_str(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(value.len().to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(value.as_bytes());
    out.push(b'|');
}

fn push_usize(out: &mut Vec<u8>, value: usize) {
    out.extend_from_slice(value.to_string().as_bytes());
    out.push(b'|');
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(value.to_string().as_bytes());
    out.push(b'|');
}

fn allow_dev_signature(signature: &str) -> bool {
    #[cfg(test)]
    {
        if signature.starts_with("sig-") {
            return true;
        }
    }
    std::env::var("SYNDICATE_ALLOW_DEV_SIGNATURES")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        && signature.starts_with("sig-")
}

fn match_id_signing_key(match_id: &str) -> u64 {
    let h = intent::simple_sha256(match_id.as_bytes());
    u64::from_le_bytes(h[..8].try_into().expect("8 bytes"))
}

fn action_to_tag_amount(action: Action) -> (u8, u64) {
    match action {
        Action::Fold => (intent::ACTION_TAG_FOLD, 0),
        Action::Check => (intent::ACTION_TAG_CHECK, 0),
        Action::Call => (intent::ACTION_TAG_CALL, 0),
        Action::BetTo(a) => (intent::ACTION_TAG_BET_TO, a),
        Action::RaiseTo(a) => (intent::ACTION_TAG_RAISE_TO, a),
        Action::AllIn => (intent::ACTION_TAG_ALL_IN, 0),
    }
}

fn map_verify_err(err: VerifyError) -> MatchServiceError {
    MatchServiceError::InvalidIntent(verify_err_msg(err))
}

fn verify_err_msg(err: VerifyError) -> &'static str {
    match err {
        VerifyError::InvalidWallet => "invalid wallet pubkey",
        VerifyError::InvalidSignature => "invalid ed25519 signature",
        VerifyError::BadEncoding => "bad signature encoding",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(match_id: &str) -> MatchConfig {
        MatchConfig {
            match_id: match_id.to_string(),
            onchain_match_id: 42,
            players: vec![
                (PlayerId(0), 100, 0),
                (PlayerId(1), 100, 1),
                (PlayerId(2), 100, 2),
            ],
            button: 0,
            small_blind: 1,
            big_blind: 2,
            round_count: 3,
            action_timeout_ms: 10_000,
            lease_ttl_ms: 1_000,
        }
    }

    fn intent(seat_index: usize, nonce: u64, action: Action, head: [u8; 32]) -> SignedActionIntent {
        SignedActionIntent {
            seat_index,
            wallet: format!("wallet-{seat_index}"),
            nonce,
            prev_head: head,
            signature: format!("sig-{seat_index}-{nonce}"),
            action,
        }
    }

    #[test]
    fn two_engine_instances_cannot_mutate_same_match() {
        let mut leases = InMemoryLeaseCoordinator::new();
        let cfg = config("match-a");
        let lease_a = leases
            .acquire(&cfg.match_id, "node-a", 0, cfg.lease_ttl_ms)
            .unwrap();
        let mut node_a = FencedMatchRuntime::start(cfg.clone(), lease_a);

        node_a
            .apply_signed_action(&leases, 10, intent(0, 1, Action::Call, node_a.head()))
            .unwrap();

        assert!(matches!(
            leases.acquire(&cfg.match_id, "node-b", 500, cfg.lease_ttl_ms),
            Err(MatchServiceError::LeaseHeld { .. })
        ));

        let snapshot = FencedMatchRuntime::replay(node_a.events()).unwrap();
        let lease_b = leases
            .acquire(&cfg.match_id, "node-b", 1_001, cfg.lease_ttl_ms)
            .unwrap();
        let mut node_b = FencedMatchRuntime::from_snapshot(snapshot, lease_b);

        assert_eq!(
            node_a.apply_signed_action(&leases, 1_010, intent(1, 1, Action::Call, node_b.head())),
            Err(MatchServiceError::LeaseMismatch)
        );

        node_b
            .apply_signed_action(&leases, 1_010, intent(1, 1, Action::Call, node_b.head()))
            .unwrap();
        assert_eq!(node_b.engine().to_act, Some(2));
    }

    #[test]
    fn replay_recovers_engine_from_hash_chained_events() {
        let mut leases = InMemoryLeaseCoordinator::new();
        let cfg = config("match-replay");
        let lease = leases
            .acquire(&cfg.match_id, "node-a", 0, cfg.lease_ttl_ms)
            .unwrap();
        let mut runtime = FencedMatchRuntime::start(cfg, lease);

        runtime
            .apply_signed_action(&leases, 10, intent(0, 1, Action::Call, runtime.head()))
            .unwrap();
        runtime
            .apply_signed_action(&leases, 20, intent(1, 1, Action::Call, runtime.head()))
            .unwrap();
        runtime
            .apply_signed_action(&leases, 30, intent(2, 1, Action::Check, runtime.head()))
            .unwrap();
        runtime.write_snapshot_marker();

        let snapshot = runtime.snapshot();
        let replayed = FencedMatchRuntime::replay(runtime.events()).unwrap();

        assert_eq!(replayed.next_seq, snapshot.next_seq);
        assert_eq!(replayed.head, snapshot.head);
        assert_eq!(replayed.engine.phase, snapshot.engine.phase);
        assert_eq!(replayed.engine.round, snapshot.engine.round);
        assert_eq!(replayed.engine.current_bet, snapshot.engine.current_bet);
        assert_eq!(replayed.engine.to_act, snapshot.engine.to_act);
        assert_eq!(replayed.seen_intents, snapshot.seen_intents);
    }

    #[test]
    fn timeout_default_is_fenced_and_logged() {
        let mut leases = InMemoryLeaseCoordinator::new();
        let cfg = config("match-timeout");
        let lease = leases.acquire(&cfg.match_id, "node-a", 0, 20_000).unwrap();
        let mut runtime = FencedMatchRuntime::start(cfg, lease);
        runtime
            .register_default_policy(
                &leases,
                0,
                SignedDefaultPolicy {
                    seat_index: 0,
                    wallet: "wallet-0".into(),
                    policy: DefaultAction::CheckFold,
                    signature: "sig-default-0".into(),
                },
            )
            .unwrap();

        assert_eq!(
            runtime.apply_timeout_default(&leases, 5_000, 0, DefaultAction::CheckFold, 10_000),
            Err(MatchServiceError::InvalidIntent("timeout before deadline"))
        );

        let ev = runtime
            .apply_timeout_default(&leases, 10_001, 0, DefaultAction::CheckFold, 10_000)
            .unwrap();
        assert!(matches!(
            ev.event,
            EngineLogEvent::TimeoutDefaultApplied { .. }
        ));
        assert!(runtime.engine().seats[0].folded);
    }

    #[test]
    fn unsigned_and_duplicate_intents_are_rejected_before_append() {
        let mut leases = InMemoryLeaseCoordinator::new();
        let cfg = config("match-intents");
        let lease = leases
            .acquire(&cfg.match_id, "node-a", 0, cfg.lease_ttl_ms)
            .unwrap();
        let mut runtime = FencedMatchRuntime::start(cfg, lease);

        let mut bad = intent(0, 1, Action::Call, runtime.head());
        bad.signature.clear();
        assert_eq!(
            runtime.apply_signed_action(&leases, 10, bad),
            Err(MatchServiceError::InvalidIntent("signature is required"))
        );
        assert_eq!(runtime.events().len(), 1);

        runtime
            .apply_signed_action(&leases, 10, intent(0, 1, Action::Call, runtime.head()))
            .unwrap();
        assert_eq!(
            runtime.apply_signed_action(&leases, 20, intent(0, 1, Action::Call, runtime.head())),
            Err(MatchServiceError::DuplicateIntent {
                seat_index: 0,
                nonce: 1,
            })
        );
        assert_eq!(runtime.events().len(), 2);
    }

    #[test]
    fn load_smoke_2000_matches_append_fenced_actions() {
        let mut leases = InMemoryLeaseCoordinator::new();
        for i in 0..2_000 {
            let mut cfg = config(&format!("load-{i}"));
            cfg.players = vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1)];
            let lease = leases
                .acquire(
                    &cfg.match_id,
                    format!("node-{}", i % 4),
                    i,
                    cfg.lease_ttl_ms,
                )
                .unwrap();
            let mut runtime = FencedMatchRuntime::start(cfg, lease);
            runtime
                .apply_signed_action(&leases, i + 1, intent(0, 1, Action::Call, runtime.head()))
                .unwrap();
            assert_eq!(runtime.events().len(), 2);
            assert_ne!(runtime.head(), GENESIS);
        }
    }
}
