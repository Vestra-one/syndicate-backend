//! WebSocket endpoint: challenge/auth, channel subscriptions with gap-free backfill,
//! gameplay frames (act / set_default / seal).
//!
//! Every server frame: `{"v":1,"t":"...","server_time_ms":...,...}`. Spectating (lobby +
//! match channels) needs no auth; gameplay frames and the wallet channel do.

use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

use syndicate_engine::service::{SignedActionIntent, SignedDefaultPolicy};
use syndicate_engine::{Action, DefaultAction};

use crate::app::AppState;
use crate::runtime::Cmd;
use crate::util::now_ms;

pub async fn upgrade(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| connection(st, socket))
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum ClientMsg {
    Auth {
        wallet: String,
        signature: String,
    },
    Subscribe {
        channel: Value,
        #[serde(default = "default_event_cursor")]
        last_seq: i64,
    },
    Unsubscribe {
        channel: Value,
    },
    Act {
        match_id: Uuid,
        seat_index: u16,
        nonce: u64,
        prev_head_hex: String,
        action: Value,
        signature: String,
    },
    SetDefault {
        match_id: Uuid,
        seat_index: u16,
        policy: String,
        signature: String,
    },
    Seal {
        match_id: Uuid,
        ciphertext_b64: String,
        commitment_hex: String,
        timelock_target: u64,
        signature: String,
        #[serde(default)]
        seal_tx_sig: Option<String>,
    },
    Ping,
}

struct Conn {
    st: AppState,
    wallet: Arc<RwLock<Option<String>>>,
    nonce: Option<String>,
    /// Per-subscription forwarder tasks, keyed by channel key.
    subs: std::collections::HashMap<String, tokio::task::JoinHandle<()>>,
    out: tokio::sync::mpsc::Sender<String>,
}

async fn connection(st: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<String>(256);

    // Writer task: single owner of the sink.
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    let mut conn = Conn {
        st,
        wallet: Arc::new(RwLock::new(None)),
        nonce: None,
        subs: Default::default(),
        out: out_tx.clone(),
    };

    // Challenge immediately (auth optional for spectators).
    let nonce = uuid::Uuid::new_v4().to_string();
    conn.nonce = Some(nonce.clone());
    conn.send(json!({ "v":1, "t":"challenge", "server_time_ms": now_ms(), "nonce": nonce }))
        .await;

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let parsed: Result<ClientMsg, _> = serde_json::from_str(&text);
        match parsed {
            Ok(msg) => conn.handle(msg).await,
            Err(e) => {
                conn.error("bad_frame", &format!("unparseable frame: {e}"))
                    .await;
            }
        }
    }

    for (_, task) in conn.subs.drain() {
        task.abort();
    }
    writer.abort();
}

impl Conn {
    fn current_wallet(&self) -> Option<String> {
        self.wallet.read().ok().and_then(|w| w.clone())
    }

    async fn send(&self, frame: Value) {
        let _ = self.out.send(frame.to_string()).await;
    }

    async fn error(&self, code: &str, msg: &str) {
        self.send(json!({
            "v":1, "t":"error", "server_time_ms": now_ms(), "code": code, "msg": msg,
        }))
        .await;
    }

    async fn handle(&mut self, msg: ClientMsg) {
        match msg {
            ClientMsg::Ping => {
                self.send(json!({ "v":1, "t":"pong", "server_time_ms": now_ms() }))
                    .await;
            }
            ClientMsg::Auth { wallet, signature } => self.auth(wallet, signature).await,
            ClientMsg::Subscribe { channel, last_seq } => self.subscribe(channel, last_seq).await,
            ClientMsg::Unsubscribe { channel } => {
                if let Some(t) = self.subs.remove(&channel_key(&channel)) {
                    t.abort()
                }
            }
            ClientMsg::Act {
                match_id,
                seat_index,
                nonce,
                prev_head_hex,
                action,
                signature,
            } => {
                self.act(
                    match_id,
                    seat_index,
                    nonce,
                    prev_head_hex,
                    action,
                    signature,
                )
                .await
            }
            ClientMsg::SetDefault {
                match_id,
                seat_index,
                policy,
                signature,
            } => {
                self.set_default(match_id, seat_index, policy, signature)
                    .await
            }
            ClientMsg::Seal {
                match_id,
                ciphertext_b64,
                commitment_hex,
                timelock_target,
                signature,
                seal_tx_sig,
            } => {
                let Some(wallet) = self.current_wallet() else {
                    return self.error("unauthorized", "auth required to seal").await;
                };
                let body = crate::api::matches::SealBody {
                    ciphertext_b64,
                    commitment_hex,
                    timelock_target,
                    signature,
                    seal_tx_sig,
                };
                match crate::api::matches::submit_seal(&self.st, match_id, &wallet, body).await {
                    Ok(resp) => self.send(resp.0).await,
                    Err(e) => self.error(e.code, &e.message).await,
                }
            }
        }
    }

    async fn auth(&mut self, wallet: String, signature: String) {
        let Some(nonce) = self.nonce.take() else {
            return self
                .error("no_challenge", "challenge already consumed")
                .await;
        };
        if syndicate_engine::verify::verify_ed25519(&wallet, nonce.as_bytes(), &signature).is_err()
        {
            self.nonce = Some(nonce);
            return self
                .error("bad_signature", "signature over nonce invalid")
                .await;
        }
        // Issue an HTTP-usable session too (parity with POST /v1/auth/verify).
        self.st.nonces.install(&wallet, &nonce);
        let session =
            crate::auth::session::verify_and_create_session(&self.st, &wallet, &signature)
                .await
                .ok();
        if let Ok(mut current) = self.wallet.write() {
            *current = Some(wallet.clone());
        }
        self.send(json!({
            "v":1, "t":"authenticated", "server_time_ms": now_ms(),
            "wallet": wallet,
            "session": session.as_ref().map(|s| s.0.clone()),
            "expires_at": session.map(|s| s.1),
        }))
        .await;
        // Fresh challenge for potential re-auth.
        let nonce = uuid::Uuid::new_v4().to_string();
        self.nonce = Some(nonce);
    }

    async fn subscribe(&mut self, channel: Value, last_seq: i64) {
        let key = channel_key(&channel);
        if let Some(task) = self.subs.remove(&key) {
            task.abort();
        }
        if key == "lobby" {
            let rx = self.st.registry.lobby.sender().subscribe();
            self.spawn_forwarder(key, rx, None);
            return;
        }
        if let Some(match_id) = channel
            .get("match")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok())
            .or_else(|| {
                channel
                    .get("match")
                    .and_then(Value::as_object)
                    .and_then(|o| o.get("match_id"))
                    .and_then(Value::as_str)
                    .and_then(|s| Uuid::parse_str(s).ok())
            })
        {
            // Pin the live stream FIRST (gap-free), then snapshot + backfill.
            let live_rx = self
                .st
                .registry
                .get(&match_id)
                .map(|h| h.events.subscribe());

            // Snapshot.
            if let Some(handle) = self.st.registry.get(&match_id) {
                let (tx, rx) = tokio::sync::oneshot::channel();
                if handle.cmd.send(Cmd::Snapshot(tx)).await.is_ok() {
                    if let Ok(view) = rx.await {
                        self.send(json!({
                            "v":1, "t":"snapshot", "server_time_ms": now_ms(),
                            "match_id": match_id, "state": view,
                        }))
                        .await;
                    }
                }
            } else if let Ok(client) = self.st.pool.get().await {
                if let Ok(Some(row)) = crate::db::load_match(&client, match_id).await {
                    drop(client);
                    let view = crate::view::match_view(&self.st, &row, None).await;
                    self.send(json!({
                        "v":1, "t":"snapshot", "server_time_ms": now_ms(),
                        "match_id": match_id, "state": view,
                    }))
                    .await;
                }
            }

            // Backfill events > last_seq (redacted).
            let backfill_after = backfill_cursor(last_seq);
            if let Ok(client) = self.st.pool.get().await {
                if let Ok(rows) = client
                    .query(
                        r#"SELECT seq, event_type, payload, hash FROM match_events
                           WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 2000"#,
                        &[&match_id, &backfill_after],
                    )
                    .await
                {
                    for r in rows {
                        let mut payload: Value = r.get("payload");
                        crate::api::matches::redact_event_payload(&mut payload);
                        self.send(json!({
                            "v":1, "t":"event", "server_time_ms": now_ms(),
                            "match_id": match_id,
                            "seq": r.get::<_, i64>("seq"),
                            "type": r.get::<_, String>("event_type"),
                            "body": payload,
                            "hash": hex::encode(r.get::<_, Vec<u8>>("hash")),
                        }))
                        .await;
                    }
                }
            }

            // Count this connection as a watcher only when an actor is actually live to
            // watch (a snapshot-only request against a dead/terminal match isn't spectating).
            let guard = live_rx.is_some().then(|| self.st.watchers.inc(match_id));
            if let Some(rx) = live_rx {
                self.spawn_forwarder(key, rx, guard);
            }
        }
    }

    fn spawn_forwarder(
        &mut self,
        key: String,
        mut rx: broadcast::Receiver<std::sync::Arc<Value>>,
        guard: Option<crate::app::WatcherGuard>,
    ) {
        let out = self.out.clone();
        let wallet = self.wallet.clone();
        let task = tokio::spawn(async move {
            let _guard = guard; // held for the forwarder's lifetime; Drop decrements the count
            loop {
                match rx.recv().await {
                    Ok(frame) => {
                        let current = wallet.read().ok().and_then(|w| w.clone());
                        let Some(outbound) =
                            prepare_forward_frame(frame.as_ref(), current.as_deref())
                        else {
                            continue;
                        };
                        if out.send(outbound.to_string()).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("ws subscriber lagged {n} frames");
                        let _ = out
                            .send(
                                json!({
                                    "v":1, "t":"error", "server_time_ms": now_ms(),
                                    "code": "lagged",
                                    "msg": "stream lagged; re-subscribe with last_seq",
                                })
                                .to_string(),
                            )
                            .await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        self.subs.insert(key, task);
    }

    async fn act(
        &mut self,
        match_id: Uuid,
        seat_index: u16,
        nonce: u64,
        prev_head_hex: String,
        action: Value,
        signature: String,
    ) {
        let Some(wallet) = self.current_wallet() else {
            return self.error("unauthorized", "auth required to act").await;
        };
        if self.st.limits.check_actions(&wallet).is_err() {
            return self.error("rate_limited", "slow down").await;
        }
        let Some(prev_head) = hex::decode(&prev_head_hex)
            .ok()
            .and_then(|v| <[u8; 32]>::try_from(v).ok())
        else {
            return self
                .error("bad_frame", "prev_head_hex must be 32 bytes hex")
                .await;
        };
        let Some(parsed_action) = parse_action(&action) else {
            return self.error("bad_frame", "unknown action").await;
        };
        let intent = SignedActionIntent {
            seat_index: seat_index as usize,
            wallet,
            nonce,
            prev_head,
            signature,
            action: parsed_action,
        };
        let Some(handle) = self.st.registry.get(&match_id) else {
            return self.error("not_found", "match not active").await;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        if handle
            .cmd
            .send(Cmd::Act { intent, reply: tx })
            .await
            .is_err()
        {
            return self.error("not_found", "match actor gone").await;
        }
        match rx.await {
            Ok(Ok(ack)) => self.send(ack).await,
            Ok(Err(e)) => self.error(e.code, &e.message).await,
            Err(_) => self.error("internal", "actor dropped reply").await,
        }
    }

    async fn set_default(
        &mut self,
        match_id: Uuid,
        seat_index: u16,
        policy: String,
        signature: String,
    ) {
        let Some(wallet) = self.current_wallet() else {
            return self.error("unauthorized", "auth required").await;
        };
        let parsed_policy = match policy.as_str() {
            "check_fold" => DefaultAction::CheckFold,
            "check_call_any" => DefaultAction::CheckCallAny,
            _ => {
                return self
                    .error("bad_frame", "policy must be check_fold|check_call_any")
                    .await
            }
        };
        let policy = SignedDefaultPolicy {
            seat_index: seat_index as usize,
            wallet,
            policy: parsed_policy,
            signature,
        };
        let Some(handle) = self.st.registry.get(&match_id) else {
            return self.error("not_found", "match not active").await;
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        if handle
            .cmd
            .send(Cmd::SetDefault { policy, reply: tx })
            .await
            .is_err()
        {
            return self.error("not_found", "match actor gone").await;
        }
        match rx.await {
            Ok(Ok(())) => {
                self.send(json!({
                    "v":1, "t":"default_set", "server_time_ms": now_ms(),
                    "match_id": match_id, "seat": seat_index,
                }))
                .await
            }
            Ok(Err(e)) => self.error(e.code, &e.message).await,
            Err(_) => self.error("internal", "actor dropped reply").await,
        }
    }
}

fn default_event_cursor() -> i64 {
    -1
}

fn backfill_cursor(last_seq: i64) -> i64 {
    if last_seq <= 0 {
        -1
    } else {
        last_seq
    }
}

fn prepare_forward_frame(frame: &Value, wallet: Option<&str>) -> Option<Value> {
    let mut outbound = frame.clone();
    if let Some(target) = outbound.get("_to_wallet").and_then(Value::as_str) {
        if wallet != Some(target) {
            return None;
        }
        if let Some(obj) = outbound.as_object_mut() {
            obj.remove("_to_wallet");
        }
    }
    Some(outbound)
}

fn channel_key(channel: &Value) -> String {
    if channel.as_str() == Some("lobby") {
        return "lobby".into();
    }
    if let Some(m) = channel.get("match") {
        if let Some(id) = m.as_str().filter(|s| !s.is_empty()) {
            return format!("match:{id}");
        }
        if let Some(id) = m
            .as_object()
            .and_then(|o| o.get("match_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return format!("match:{id}");
        }
        return format!("match:{m}");
    }
    if channel.as_str() == Some("wallet") {
        return "wallet".into();
    }
    format!("{channel}")
}

/// `{"kind":"fold"}` | `{"kind":"bet_to","amount":120}` | plain string tags.
fn parse_action(action: &Value) -> Option<Action> {
    let kind = action
        .as_str()
        .or_else(|| action.get("kind").and_then(Value::as_str))?;
    let amount = action.get("amount").and_then(Value::as_u64).unwrap_or(0);
    Some(match kind {
        "fold" => Action::Fold,
        "check" => Action::Check,
        "call" => Action::Call,
        "bet_to" => Action::BetTo(amount),
        "raise_to" => Action::RaiseTo(amount),
        "all_in" => Action::AllIn,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_frames_parse() {
        let act: ClientMsg = serde_json::from_str(
            r#"{"t":"act","match_id":"11111111-2222-3333-4444-555555555555","seat_index":1,
                "nonce":3,"prev_head_hex":"00","action":{"kind":"raise_to","amount":40},
                "signature":"sig"}"#,
        )
        .unwrap();
        assert!(matches!(act, ClientMsg::Act { .. }));
        let sub: ClientMsg =
            serde_json::from_str(r#"{"t":"subscribe","channel":"lobby"}"#).unwrap();
        assert!(matches!(sub, ClientMsg::Subscribe { .. }));
    }

    #[test]
    fn subscribe_cursor_defaults_before_genesis_and_accepts_negative_one() {
        let sub: ClientMsg = serde_json::from_str(
            r#"{"t":"subscribe","channel":{"match":"11111111-2222-3333-4444-555555555555"}}"#,
        )
        .unwrap();
        assert!(matches!(sub, ClientMsg::Subscribe { last_seq: -1, .. }));

        let sub: ClientMsg =
            serde_json::from_str(r#"{"t":"subscribe","channel":"lobby","last_seq":-1}"#).unwrap();
        assert!(matches!(sub, ClientMsg::Subscribe { last_seq: -1, .. }));
    }

    #[test]
    fn ws_bootstrap_cursor_fetches_genesis_for_legacy_zero() {
        assert_eq!(backfill_cursor(-1), -1);
        assert_eq!(backfill_cursor(0), -1);
        assert_eq!(backfill_cursor(7), 7);
    }

    #[test]
    fn action_tags() {
        assert_eq!(parse_action(&json!("fold")), Some(Action::Fold));
        assert_eq!(
            parse_action(&json!({"kind":"bet_to","amount":120})),
            Some(Action::BetTo(120))
        );
        assert_eq!(parse_action(&json!({"kind":"nope"})), None);
    }

    #[test]
    fn match_channel_keys_are_canonical_for_supported_shapes() {
        let id = "11111111-2222-3333-4444-555555555555";
        assert_eq!(channel_key(&json!({"match": id})), format!("match:{id}"));
        assert_eq!(
            channel_key(&json!({"match": {"match_id": id}})),
            format!("match:{id}")
        );
    }

    #[test]
    fn malformed_match_channel_keys_do_not_collapse_to_match_empty() {
        let key = channel_key(&json!({"match": {"bad": "shape"}}));
        assert!(key.starts_with("match:{"));
        assert_ne!(key, "match:");
    }

    #[test]
    fn private_frames_only_forward_to_target_wallet() {
        let frame = json!({
            "v": 1,
            "t": "your_turn",
            "seat": 0,
            "_to_wallet": "wallet-a",
        });

        assert!(prepare_forward_frame(&frame, None).is_none());
        assert!(prepare_forward_frame(&frame, Some("wallet-b")).is_none());

        let forwarded = prepare_forward_frame(&frame, Some("wallet-a")).unwrap();
        assert_eq!(forwarded["t"], "your_turn");
        assert!(forwarded.get("_to_wallet").is_none());
    }

    #[test]
    fn public_frames_forward_to_any_subscriber() {
        let frame = json!({"v": 1, "t": "turn_update", "seat": 0});
        assert_eq!(prepare_forward_frame(&frame, None), Some(frame));
    }
}
