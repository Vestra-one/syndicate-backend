//! NATS JetStream helpers for durable settlement queue delivery.

use std::time::Duration;

use async_nats::jetstream::{
    consumer::{pull, AckPolicy, DeliverPolicy},
    context::Publish,
    stream::{Config as StreamConfig, RetentionPolicy, StorageType},
    Context as JetStream,
};
use async_nats::{Client, ConnectOptions};

pub const SETTLEMENT_STREAM: &str = "SETTLEMENT";
pub const SETTLEMENT_SUBJECT_PREFIX: &str = "syndicate.settlement";
pub const SETTLEMENT_REQUESTED_SUBJECT: &str = "syndicate.settlement.requested";
pub const SETTLEMENT_CONSUMER: &str = "settlement-worker";

#[derive(Clone, Debug)]
pub struct SettlementBusConfig {
    pub nats_url: String,
    pub stream_name: String,
    pub consumer_name: String,
    pub ack_wait_ms: u64,
    pub max_deliver: i64,
}

impl Default for SettlementBusConfig {
    fn default() -> Self {
        Self {
            nats_url: "nats://127.0.0.1:4222".into(),
            stream_name: SETTLEMENT_STREAM.into(),
            consumer_name: SETTLEMENT_CONSUMER.into(),
            ack_wait_ms: 60_000,
            max_deliver: 10,
        }
    }
}

impl SettlementBusConfig {
    pub fn from_env() -> Self {
        Self {
            nats_url: std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into()),
            stream_name: std::env::var("SETTLEMENT_STREAM_NAME")
                .unwrap_or_else(|_| SETTLEMENT_STREAM.into()),
            consumer_name: std::env::var("SETTLEMENT_CONSUMER_NAME")
                .unwrap_or_else(|_| SETTLEMENT_CONSUMER.into()),
            ack_wait_ms: std::env::var("SETTLEMENT_ACK_WAIT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60_000),
            max_deliver: std::env::var("SETTLEMENT_MAX_DELIVER")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
        }
    }
}

#[derive(Debug)]
pub enum BusError {
    Connect(String),
    JetStream(String),
    Publish(String),
    Consumer(String),
}

impl std::fmt::Display for BusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BusError::Connect(e) => write!(f, "nats connect: {e}"),
            BusError::JetStream(e) => write!(f, "jetstream: {e}"),
            BusError::Publish(e) => write!(f, "publish: {e}"),
            BusError::Consumer(e) => write!(f, "consumer: {e}"),
        }
    }
}

impl std::error::Error for BusError {}

pub struct SettlementBus {
    client: Client,
    jetstream: JetStream,
    config: SettlementBusConfig,
}

impl Clone for SettlementBus {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            jetstream: async_nats::jetstream::new(self.client.clone()),
            config: self.config.clone(),
        }
    }
}

impl SettlementBus {
    pub async fn connect(config: SettlementBusConfig) -> Result<Self, BusError> {
        let client = ConnectOptions::new()
            .name("syndicate-settlement-worker")
            .connect(&config.nats_url)
            .await
            .map_err(|e| BusError::Connect(e.to_string()))?;
        let jetstream = async_nats::jetstream::new(client.clone());
        let bus = Self {
            client,
            jetstream,
            config,
        };
        bus.ensure_stream().await?;
        Ok(bus)
    }

    pub async fn ensure_stream(&self) -> Result<(), BusError> {
        let stream_config = StreamConfig {
            name: self.config.stream_name.clone(),
            subjects: vec![format!("{}.*", SETTLEMENT_SUBJECT_PREFIX)],
            retention: RetentionPolicy::Limits,
            storage: StorageType::File,
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            duplicate_window: Duration::from_secs(24 * 60 * 60),
            ..Default::default()
        };
        self.jetstream
            .get_or_create_stream(stream_config)
            .await
            .map_err(|e| BusError::JetStream(e.to_string()))?;
        Ok(())
    }

    pub async fn publish_settlement_request(
        &self,
        match_id: &str,
        payload: &[u8],
        message_id: &str,
    ) -> Result<(), BusError> {
        let subject = format!("{SETTLEMENT_REQUESTED_SUBJECT}.{match_id}");
        self.jetstream
            .send_publish(
                subject,
                Publish::build()
                    .payload(payload.to_vec().into())
                    .message_id(message_id),
            )
            .await
            .map_err(|e| BusError::Publish(e.to_string()))?
            .await
            .map_err(|e| BusError::Publish(e.to_string()))?;
        Ok(())
    }

    pub async fn durable_pull_consumer(
        &self,
    ) -> Result<async_nats::jetstream::consumer::Consumer<pull::Config>, BusError> {
        let consumer_config = pull::Config {
            durable_name: Some(self.config.consumer_name.clone()),
            ack_policy: AckPolicy::Explicit,
            ack_wait: Duration::from_millis(self.config.ack_wait_ms),
            max_deliver: self.config.max_deliver,
            deliver_policy: DeliverPolicy::All,
            filter_subject: format!("{}.*", SETTLEMENT_REQUESTED_SUBJECT),
            ..Default::default()
        };
        self.jetstream
            .get_stream(&self.config.stream_name)
            .await
            .map_err(|e| BusError::Consumer(e.to_string()))?
            .get_or_create_consumer(&self.config.consumer_name, consumer_config)
            .await
            .map_err(|e| BusError::Consumer(e.to_string()))
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn jetstream(&self) -> &JetStream {
        &self.jetstream
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_env_names() {
        let cfg = SettlementBusConfig::default();
        assert_eq!(cfg.stream_name, SETTLEMENT_STREAM);
        assert_eq!(cfg.consumer_name, SETTLEMENT_CONSUMER);
    }
}
