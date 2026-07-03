//! Country geofence (default blocklist `["IN"]`, admin-tunable via `runtime_config`)
//! plus a per-wallet enforcement-action gate. Country comes from the CDN edge headers
//! `CF-IPCountry` / `X-Country`.

use axum::http::HeaderMap;

use crate::app::AppState;
use crate::error::ApiError;

pub fn request_country(headers: &HeaderMap) -> Option<String> {
    for h in ["cf-ipcountry", "x-country"] {
        if let Some(v) = headers.get(h).and_then(|v| v.to_str().ok()) {
            let v = v.trim().to_ascii_uppercase();
            if !v.is_empty() && v != "XX" {
                return Some(v);
            }
        }
    }
    None
}

/// Reject requests from blocked countries. Absent header ⇒ allowed (the edge proxy is
/// the source of truth; direct-to-origin traffic is expected only in dev).
pub fn check_geofence(st: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(country) = request_country(headers) else {
        return Ok(());
    };
    let blocklist = {
        let overlay = st.overlay.read().expect("overlay lock");
        if overlay.geofence_blocklist.is_empty() {
            st.cfg.geofence_blocklist.clone()
        } else {
            overlay.geofence_blocklist.clone()
        }
    };
    if blocklist.iter().any(|c| c.eq_ignore_ascii_case(&country)) {
        return Err(ApiError::forbidden(
            "geofenced",
            format!("service unavailable in region {country}"),
        ));
    }
    Ok(())
}

/// Consult `enforcement_actions` before seating a wallet.
pub async fn check_enforcement(st: &AppState, wallet: &str) -> Result<(), ApiError> {
    let client = st.pool.get().await?;
    let row = client
        .query_opt(
            r#"
            SELECT action_type FROM enforcement_actions
            WHERE wallet_address = $1 AND status = 'active'
              AND action_type IN ('seat_deny', 'temporary_ban', 'ban', 'geofence_block', 'kyc_required')
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
            "#,
            &[&wallet],
        )
        .await?;
    if let Some(r) = row {
        let action: String = r.get("action_type");
        return Err(ApiError::forbidden(
            "enforcement",
            format!("wallet blocked by enforcement action: {action}"),
        ));
    }
    Ok(())
}
