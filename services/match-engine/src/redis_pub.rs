//! Redis pub/sub for gateway fan-out (`match:{matchId}` channel).

use std::sync::Arc;

use redis::AsyncCommands;

#[derive(Clone)]
pub struct MatchEventPublisher {
    client: Option<Arc<redis::Client>>,
}

impl MatchEventPublisher {
    pub fn from_env() -> Self {
        let url = std::env::var("REDIS_URL").ok();
        let client = url.and_then(|u| redis::Client::open(u).ok().map(Arc::new));
        Self { client }
    }

    pub fn disabled() -> Self {
        Self { client: None }
    }

    pub async fn publish(&self, match_id: &str, payload: &serde_json::Value) {
        let Some(client) = &self.client else {
            return;
        };
        let Ok(mut conn) = client.get_multiplexed_async_connection().await else {
            return;
        };
        let channel = format!("match:{match_id}");
        let body = payload.to_string();
        let _: Result<(), _> = conn.publish(channel, body).await;
    }
}
