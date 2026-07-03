//! Deadline backstop: every 10s, make sure every non-terminal match has an actor and
//! poke actors whose deadlines may have been missed (e.g. after clock skew or a lost
//! sleep). Also prunes expired intents and sessions.

use tracing::warn;

use crate::app::AppState;
use crate::db;
use crate::runtime::Cmd;

pub async fn run(st: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(10));
    loop {
        tick.tick().await;
        if let Err(e) = sweep(&st).await {
            warn!("sweeper: {e}");
        }
    }
}

async fn sweep(st: &AppState) -> Result<(), crate::error::ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            &format!(
                "SELECT {} FROM matches WHERE status NOT IN ('settled', 'voided')",
                db::MATCH_COLUMNS
            ),
            &[],
        )
        .await?;
    let _ = client
        .execute(
            "DELETE FROM match_intents WHERE consumed_at IS NULL AND expires_at < now() - interval '1 hour'",
            &[],
        )
        .await;
    let _ = client
        .execute("DELETE FROM sessions WHERE expires_at < now()", &[])
        .await;
    drop(client);

    for row in &rows {
        let m = db::MatchRow::from_row(row)?;
        let id = m.id;
        match st.registry.get(&id) {
            Some(handle) => {
                let _ = handle.cmd.send(Cmd::Poke).await;
            }
            None => {
                st.registry.spawn(st, m);
            }
        }
    }
    Ok(())
}

/// Boot-time recovery: spawn actors for every non-terminal match.
pub async fn recover_all(st: &AppState) -> Result<usize, crate::error::ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            &format!(
                "SELECT {} FROM matches WHERE status NOT IN ('settled', 'voided')",
                db::MATCH_COLUMNS
            ),
            &[],
        )
        .await?;
    drop(client);
    let mut count = 0;
    for row in &rows {
        let m = db::MatchRow::from_row(row)?;
        st.registry.spawn(st, m);
        count += 1;
    }
    Ok(count)
}
