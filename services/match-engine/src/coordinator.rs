//! Match coordinator: fenced runtime + Postgres persistence + settlement enqueue.

use crate::service::{
    FencedMatchRuntime, InMemoryLeaseCoordinator, MatchConfig, MatchServiceError,
    SignedActionIntent, SignedPredictionCommitment,
};
use crate::DefaultAction;

use crate::persistence::{PersistenceError, PostgresMatchStore};

#[derive(Debug)]
pub enum CoordinatorError {
    Service(MatchServiceError),
    Persistence(PersistenceError),
}

impl std::fmt::Display for CoordinatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoordinatorError::Service(e) => write!(f, "{e:?}"),
            CoordinatorError::Persistence(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CoordinatorError {}

impl From<MatchServiceError> for CoordinatorError {
    fn from(value: MatchServiceError) -> Self {
        CoordinatorError::Service(value)
    }
}

impl From<PersistenceError> for CoordinatorError {
    fn from(value: PersistenceError) -> Self {
        CoordinatorError::Persistence(value)
    }
}

pub struct MatchCoordinator {
    store: PostgresMatchStore,
    memory_leases: InMemoryLeaseCoordinator,
    use_postgres_leases: bool,
    timelock_target_round: u64,
}

impl MatchCoordinator {
    pub fn new(store: PostgresMatchStore, timelock_target_round: u64) -> Self {
        Self::with_lease_mode(store, timelock_target_round, false)
    }

    pub fn with_postgres_leases(store: PostgresMatchStore, timelock_target_round: u64) -> Self {
        Self::with_lease_mode(store, timelock_target_round, true)
    }

    fn with_lease_mode(
        store: PostgresMatchStore,
        timelock_target_round: u64,
        use_postgres_leases: bool,
    ) -> Self {
        Self {
            store,
            memory_leases: InMemoryLeaseCoordinator::new(),
            timelock_target_round,
            use_postgres_leases,
        }
    }

    pub async fn start_match(
        &mut self,
        config: MatchConfig,
        owner_id: &str,
        now_ms: u64,
    ) -> Result<FencedMatchRuntime, CoordinatorError> {
        let lease = if self.use_postgres_leases {
            self.store
                .acquire_lease(&config.match_id, owner_id, now_ms, config.lease_ttl_ms)
                .await?
        } else {
            self.memory_leases
                .acquire(&config.match_id, owner_id, now_ms, config.lease_ttl_ms)?
        };
        let runtime = FencedMatchRuntime::start(config, lease);
        let envelope = runtime
            .events()
            .last()
            .expect("match started event")
            .clone();
        self.store.append_event(&runtime, &envelope).await?;
        Ok(runtime)
    }

    pub async fn apply_action(
        &mut self,
        runtime: &mut FencedMatchRuntime,
        now_ms: u64,
        intent: SignedActionIntent,
    ) -> Result<(), CoordinatorError> {
        let envelope = runtime
            .apply_signed_action(&self.memory_leases, now_ms, intent)?
            .clone();
        self.store.append_event(runtime, &envelope).await?;
        if runtime.engine().is_complete() {
            self.complete_match(runtime).await?;
        }
        Ok(())
    }

    pub async fn apply_timeout(
        &mut self,
        runtime: &mut FencedMatchRuntime,
        now_ms: u64,
        seat_index: usize,
        default: DefaultAction,
        deadline_ms: u64,
    ) -> Result<(), CoordinatorError> {
        let envelope = runtime
            .apply_timeout_default(
                &self.memory_leases,
                now_ms,
                seat_index,
                default,
                deadline_ms,
            )?
            .clone();
        self.store.append_event(runtime, &envelope).await?;
        if runtime.engine().is_complete() {
            self.complete_match(runtime).await?;
        }
        Ok(())
    }

    pub async fn seal_prediction(
        &mut self,
        runtime: &mut FencedMatchRuntime,
        player_id: syndicate_shared::PlayerId,
        target_round: u64,
        ciphertext: Vec<u8>,
        commitment: SignedPredictionCommitment,
    ) -> Result<(), CoordinatorError> {
        let envelope = runtime
            .record_prediction_sealed(player_id, target_round, ciphertext, commitment)?
            .clone();
        self.store.append_event(runtime, &envelope).await?;
        Ok(())
    }

    pub async fn complete_match(
        &self,
        runtime: &mut FencedMatchRuntime,
    ) -> Result<(), CoordinatorError> {
        let envelope = match runtime.complete_if_ready(self.timelock_target_round) {
            Some(envelope) => envelope.clone(),
            None => return Ok(()),
        };
        self.store.append_event(runtime, &envelope).await?;
        let context = self
            .store
            .load_settlement_context(&runtime.config().match_id)
            .await?;
        self.store
            .persist_snapshot(
                runtime,
                serde_json::json!({ "phase": format!("{:?}", runtime.engine().phase) }),
            )
            .await?;
        self.store
            .enqueue_settlement(&runtime.config().match_id, &runtime.head(), &context)
            .await?;
        Ok(())
    }
}
