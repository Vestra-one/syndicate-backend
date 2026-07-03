//! Minimal ops HTTP server: `/healthz` + `/metrics`. Hand-rolled HTTP/1.1 over tokio to
//! avoid pulling a web framework into the worker.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, warn};

use crate::config::WorkerConfig;
use crate::metrics::WorkerMetrics;
use crate::oracle::SignedPriceClient;
use crate::rpc::ChainRpc;

pub struct OpsServer {
    pub cfg: WorkerConfig,
    pub metrics: Arc<WorkerMetrics>,
    pub rpc: Arc<dyn ChainRpc>,
    pub signer: solana_sdk::pubkey::Pubkey,
    pub pool: deadpool_postgres::Pool,
}

impl OpsServer {
    pub async fn run(self: Arc<Self>) {
        let addr = format!("0.0.0.0:{}", self.cfg.port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                warn!("ops server bind {addr}: {e}");
                return;
            }
        };
        info!(%addr, "ops server listening");
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let server = self.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                let Ok(n) = stream.read(&mut buf).await else {
                    return;
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (status, content_type, body) = match path {
                    "/healthz" => {
                        let body = server.health_json().await;
                        ("200 OK", "application/json", body)
                    }
                    "/metrics" => (
                        "200 OK",
                        "text/plain; version=0.0.4",
                        server.metrics.render_prometheus(),
                    ),
                    _ => ("404 Not Found", "text/plain", "not found".into()),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    }

    async fn health_json(&self) -> String {
        let db_ok = match self.pool.get().await {
            Ok(client) => client.simple_query("SELECT 1").await.is_ok(),
            Err(_) => false,
        };
        let signer_lamports = self.rpc.balance(&self.signer).await.unwrap_or(0);
        self.metrics.set_signer_lamports(signer_lamports);
        let rpc_ok = signer_lamports > 0 || self.rpc.balance(&self.signer).await.is_ok();
        let price = SignedPriceClient::new(self.cfg.signed_price_server_url.clone());
        let price_ok = tokio::task::spawn_blocking(move || price.health())
            .await
            .unwrap_or(false);
        let healthy = db_ok && rpc_ok;
        format!(
            r#"{{"ok":{healthy},"db":{db_ok},"rpc":{rpc_ok},"price_server":{price_ok},"signer":"{}","signer_lamports":{signer_lamports}}}"#,
            self.signer
        )
    }
}
