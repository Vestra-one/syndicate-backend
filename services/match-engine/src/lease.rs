//! Postgres-backed match lease coordinator using store SQL contracts.

use syndicate_store::{ACQUIRE_MATCH_LEASE_SQL, RENEW_MATCH_LEASE_SQL};

use crate::persistence::{PersistenceError, PostgresMatchStore};
use crate::service::{LeaseAuthorizer, MatchLease, MatchServiceError};

pub struct PostgresLeaseCoordinator {
    store: PostgresMatchStore,
}

impl PostgresLeaseCoordinator {
    pub fn new(store: PostgresMatchStore) -> Self {
        Self { store }
    }

    pub async fn acquire(
        &self,
        match_id: &str,
        owner_id: &str,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<MatchLease, MatchServiceError> {
        self.store
            .acquire_lease(match_id, owner_id, now_ms, ttl_ms)
            .await
            .map_err(map_persistence)
    }

    pub async fn renew(
        &self,
        lease: &MatchLease,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<MatchLease, MatchServiceError> {
        self.store
            .renew_lease(lease, now_ms, ttl_ms)
            .await
            .map_err(map_persistence)
    }

    pub fn assert_current(&self, lease: &MatchLease, now_ms: u64) -> Result<(), MatchServiceError> {
        if lease.expires_at_ms <= now_ms {
            return Err(MatchServiceError::LeaseExpired {
                expires_at_ms: lease.expires_at_ms,
            });
        }
        Ok(())
    }
}

impl LeaseAuthorizer for PostgresLeaseCoordinator {
    fn assert_current(&self, lease: &MatchLease, now_ms: u64) -> Result<(), MatchServiceError> {
        PostgresLeaseCoordinator::assert_current(self, lease, now_ms)
    }
}

fn map_persistence(err: PersistenceError) -> MatchServiceError {
    match err {
        PersistenceError::Service(e) => e,
        PersistenceError::Invalid(msg) if msg.contains("lease held") => MatchServiceError::LeaseHeld {
            owner_id: "other".into(),
            expires_at_ms: 0,
        },
        _ => MatchServiceError::LeaseMismatch,
    }
}

#[cfg(test)]
mod tests {
    use syndicate_store::{ACQUIRE_MATCH_LEASE_SQL, RENEW_MATCH_LEASE_SQL};

    #[test]
    fn lease_sql_constants_available() {
        assert!(ACQUIRE_MATCH_LEASE_SQL.contains("owner_fencing_token"));
        assert!(RENEW_MATCH_LEASE_SQL.contains("owner_lease_expires_at"));
    }
}
