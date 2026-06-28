//! Versioned inter-service event schemas (v1).
//!
//! JSON payloads exchanged between matchmaking, orchestrator, match-engine,
//! action-feed, and settlement services. TypeScript mirror: shared/src/events.ts

pub const EVENT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartPolicyAction {
    Start,
    Void,
    Wait,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartPolicyTrigger {
    Host,
    MaxFill,
    FillDeadline,
    Cancel,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartPolicyResult {
    pub schema_version: u32,
    pub action: StartPolicyAction,
    pub reason: Option<String>,
    pub trigger: Option<StartPolicyTrigger>,
}

impl StartPolicyResult {
    pub fn wait() -> Self {
        Self {
            schema_version: EVENT_SCHEMA_VERSION,
            action: StartPolicyAction::Wait,
            reason: None,
            trigger: None,
        }
    }

    pub fn start(trigger: StartPolicyTrigger) -> Self {
        Self {
            schema_version: EVENT_SCHEMA_VERSION,
            action: StartPolicyAction::Start,
            reason: None,
            trigger: Some(trigger),
        }
    }

    pub fn void(reason: impl Into<String>, trigger: StartPolicyTrigger) -> Self {
        Self {
            schema_version: EVENT_SCHEMA_VERSION,
            action: StartPolicyAction::Void,
            reason: Some(reason.into()),
            trigger: Some(trigger),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormationBootstrapped {
    pub schema_version: u32,
    pub match_id: String,
    pub onchain_match_id: u64,
    pub tier_id: String,
    pub feed_id: String,
    pub token: String,
    pub bucket: String,
    pub fill_deadline_ms: u64,
    pub max_players: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositConfirmed {
    pub schema_version: u32,
    pub match_id: String,
    pub wallet: String,
    pub seat_index: u16,
    pub tx_signature: String,
    pub finality_ts_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartPolicyTriggered {
    pub schema_version: u32,
    pub match_id: String,
    pub result: StartPolicyResult,
    pub seated: u16,
    pub min_players: u16,
    pub max_players: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchStarted {
    pub schema_version: u32,
    pub match_id: String,
    pub onchain_match_id: u64,
    pub config_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormationDissolved {
    pub schema_version: u32,
    pub match_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileDelta {
    pub schema_version: u32,
    pub wallet: String,
    pub match_id: String,
    pub buy_in: u64,
    pub payout: u64,
    pub won: bool,
    pub folded: bool,
    pub showdown: bool,
}
