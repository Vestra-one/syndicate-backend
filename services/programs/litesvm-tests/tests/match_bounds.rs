//! Operator-governed buy-in / fill-window bounds (replaces discrete tiers).
//!
//! `create_match` must reject a `buy_in` outside `[buy_in_min, buy_in_max]` or a fill window
//! outside `[fill_window_min_sec, fill_window_max_sec]`, and `set_match_bounds` must reject an
//! inverted (min > max) range. The harness admin holds the `config_admin` role.

mod common;

use common::{MatchBounds, MatchConfig, MatchHarness, BASE_TS};

/// Tighten bounds to a known window so the rejection/acceptance cases are unambiguous.
const TIGHT_BOUNDS: MatchBounds = MatchBounds {
    buy_in_min: 50,
    buy_in_max: 200,
    fill_window_min_sec: 10,
    fill_window_max_sec: 1_000,
};

fn bare_with(buy_in: u64, fill_window_sec: u64) -> MatchHarness {
    let cfg = MatchConfig {
        buy_in,
        // harness expresses the desired absolute deadline; window = deadline - now (now == BASE_TS).
        fill_deadline_ts: BASE_TS + fill_window_sec,
        num_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.set_match_bounds(TIGHT_BOUNDS).expect("set_match_bounds");
    h
}

#[test]
fn buy_in_in_range_creates() {
    let mut h = bare_with(100, 500);
    h.try_create_match().expect("in-range create should succeed");
}

#[test]
fn buy_in_below_min_rejected() {
    let mut h = bare_with(10, 500);
    assert!(
        h.try_create_match().is_err(),
        "buy_in below min must be rejected"
    );
}

#[test]
fn buy_in_above_max_rejected() {
    let mut h = bare_with(1_000, 500);
    assert!(
        h.try_create_match().is_err(),
        "buy_in above max must be rejected"
    );
}

#[test]
fn fill_window_above_max_rejected() {
    let mut h = bare_with(100, 5_000);
    assert!(
        h.try_create_match().is_err(),
        "fill window above max must be rejected"
    );
}

#[test]
fn fill_window_below_min_rejected() {
    let mut h = bare_with(100, 5);
    assert!(
        h.try_create_match().is_err(),
        "fill window below min must be rejected"
    );
}

#[test]
fn set_match_bounds_rejects_inverted_range() {
    let mut h = MatchHarness::bare(MatchConfig::default());
    let inverted = MatchBounds {
        buy_in_min: 200,
        buy_in_max: 100,
        fill_window_min_sec: 10,
        fill_window_max_sec: 1_000,
    };
    assert!(
        h.set_match_bounds(inverted).is_err(),
        "min > max bounds must be rejected"
    );
}
