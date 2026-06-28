//! Production Postgres schema contract.
//!
//! The runtime database client will be wired in the match-engine phase. This
//! module exposes the versioned migration text so tests and deployment tooling
//! can verify the persistence contract without duplicating SQL literals.

pub const POSTGRES_SCHEMA_V1: &str = include_str!("../migrations/0001_production_persistence.sql");
pub const POSTGRES_SCHEMA_V2: &str = include_str!("../migrations/0002_settlement_queue.sql");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_hash_chained_event_log() {
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE match_events"));
        assert!(POSTGRES_SCHEMA_V1.contains("PRIMARY KEY (match_id, seq)"));
        assert!(POSTGRES_SCHEMA_V1.contains("UNIQUE (id)"));
        assert!(POSTGRES_SCHEMA_V1.contains("UNIQUE (match_id, hash)"));
        assert!(POSTGRES_SCHEMA_V1.contains("prev_hash bytea NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("hash bytea NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("CHECK (octet_length(prev_hash) = 32)"));
        assert!(POSTGRES_SCHEMA_V1.contains("CHECK (octet_length(hash) = 32)"));
    }

    #[test]
    fn schema_makes_events_append_only() {
        assert!(POSTGRES_SCHEMA_V1.contains("reject_match_event_mutation"));
        assert!(POSTGRES_SCHEMA_V1.contains("prevent_match_event_update"));
        assert!(POSTGRES_SCHEMA_V1.contains("prevent_match_event_delete"));
        assert!(POSTGRES_SCHEMA_V1.contains("match_events is append-only"));
    }

    #[test]
    fn schema_uses_outbox_and_rebuildable_read_models() {
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE outbox_events"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE settlement_attempts"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE settlement_dead_letters"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE custody_ledger"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE vault_reconciliations"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE replay_bundles"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE match_snapshots"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE read_model_checkpoints"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE live_games"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE match_history"));
        assert!(POSTGRES_SCHEMA_V1.contains("notify_outbox_insert"));
    }

    #[test]
    fn schema_supports_leases_and_snapshots() {
        assert!(POSTGRES_SCHEMA_V1.contains("owner_node_id text"));
        assert!(POSTGRES_SCHEMA_V1.contains("owner_fencing_token bigint NOT NULL DEFAULT 0"));
        assert!(POSTGRES_SCHEMA_V1.contains("owner_lease_expires_at timestamptz"));
        assert!(POSTGRES_SCHEMA_V1.contains("matches_owner_lease_idx"));
        assert!(POSTGRES_SCHEMA_V1.contains("PRIMARY KEY (match_id, last_seq)"));
        assert!(POSTGRES_SCHEMA_V1.contains("match_snapshots_latest_idx"));
    }

    #[test]
    fn schema_supports_settlement_ops() {
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TYPE settlement_attempt_status"));
        assert!(POSTGRES_SCHEMA_V1.contains("idempotency_key text NOT NULL UNIQUE"));
        assert!(POSTGRES_SCHEMA_V1.contains("onchain_match_id bigint NOT NULL UNIQUE"));
        assert!(POSTGRES_SCHEMA_V1.contains("attempt_kind text NOT NULL DEFAULT 'settle'"));
        assert!(POSTGRES_SCHEMA_V1.contains("CHECK (attempt_kind IN ('settle', 'void'))"));
        assert!(POSTGRES_SCHEMA_V1.contains("void_tx_signature text"));
        assert!(POSTGRES_SCHEMA_V1.contains("settlement_attempts_due_idx"));
        assert!(POSTGRES_SCHEMA_V1.contains("receiver_program_id text NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("wormhole_program_id text NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("push_oracle_program_id text NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("hermes_response_hash bytea NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("binary_update_hash bytea NOT NULL"));
        assert!(POSTGRES_SCHEMA_V1.contains("atomic_settlement_tx_signature text"));
        assert!(POSTGRES_SCHEMA_V1.contains("vault_reconciliations_match_idx"));
        assert!(POSTGRES_SCHEMA_V1.contains(
            "ledger_type IN ('deposit', 'payout', 'refund', 'fee_accrual', 'fee_sweep')"
        ));
    }

    #[test]
    fn schema_preserves_launch_policy_defaults() {
        assert!(POSTGRES_SCHEMA_V1.contains("oracle_delay_window_sec integer NOT NULL DEFAULT 5"));
        assert!(
            POSTGRES_SCHEMA_V1.contains("geofence_blocklist text[] NOT NULL DEFAULT ARRAY['IN']")
        );
        assert!(POSTGRES_SCHEMA_V1
            .contains("allow_duplicate_wallet_per_match boolean NOT NULL DEFAULT false"));
        assert!(POSTGRES_SCHEMA_V1.contains("CHECK (allow_duplicate_wallet_per_match = false)"));
        assert!(POSTGRES_SCHEMA_V1.contains("CHECK (max_players BETWEEN 2 AND 5)"));
    }

    #[test]
    fn schema_v2_supports_settlement_queue_indexes() {
        assert!(POSTGRES_SCHEMA_V2.contains("outbox_settlement_pending_idx"));
        assert!(POSTGRES_SCHEMA_V2.contains("aggregate_type = 'settlement'"));
        assert!(POSTGRES_SCHEMA_V2.contains("settlement_attempts_submitted_stale_idx"));
        assert!(POSTGRES_SCHEMA_V2.contains("status = 'submitted'"));
    }

    #[test]
    fn schema_supports_trust_safety_enforcement() {
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE trust_safety_signals"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE enforcement_actions"));
        assert!(POSTGRES_SCHEMA_V1.contains("CREATE TABLE enforcement_appeals"));
        assert!(POSTGRES_SCHEMA_V1.contains("enforcement_actions_active_wallet_idx"));
        assert!(POSTGRES_SCHEMA_V1.contains(
            "action_type IN ('seat_deny', 'temporary_ban', 'ban', 'kyc_required', 'geofence_block')"
        ));
        assert!(POSTGRES_SCHEMA_V1.contains("status IN ('open', 'accepted', 'rejected')"));
    }
}
