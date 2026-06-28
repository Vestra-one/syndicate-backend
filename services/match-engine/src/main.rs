use syndicate_engine::server::{run, EngineServerState};

#[tokio::main]
async fn main() {
    let host = std::env::var("MATCH_ENGINE_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("MATCH_ENGINE_PORT").unwrap_or_else(|_| "8083".into());
    let addr = format!("{host}:{port}");
    let state = match EngineServerState::from_env().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("match-engine: {e}; running demo mode without DATABASE_URL persistence");
            EngineServerState::demo()
        }
    };
    if let Err(err) = run(state, &addr).await {
        eprintln!("match-engine fatal: {err}");
        std::process::exit(1);
    }
}
