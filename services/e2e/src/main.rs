//! Comprehensive, real-world end-to-end suite against a live v2 stack on devnet.
//!
//! **Server is the source of truth.** No player is handed another player's local state.
//! Each participant learns about a match only the way a real client would:
//!   * the creator gets its `create_params` + `match_pda` + `chips_token_mint` from its OWN
//!     `POST /v1/rooms/intents` response;
//!   * a public joiner is told only the table's public `onchain_match_id`, then **discovers
//!     everything else from `GET /v1/lobby`** (buy-in, token, phase) and derives the PDAs
//!     client-side (deterministic program-address math, exactly as the FE does);
//!   * a private joiner is told only the **room code** (shared out-of-band) and fetches the
//!     match + its server-computed `join_commitment` from `GET /v1/rooms/code/{code}`.
//! Seat indexes, phases, deadlines, timelock inputs, claimables — all re-read from the API.
//!
//! It also asserts EVERY endpoint returns the expected values (health, metrics, config,
//! lobby, live, history, detail, candidate, events, seal, wallet active/matches/claimables,
//! admin config + admin void, and the WebSocket challenge/auth/subscribe/snapshot path),
//! plus the adversarial "someone else plays my game / steals my funds" paths — all against
//! the real on-chain program.
//!
//! Scenarios (subset via E2E_SCENARIOS="public,theft,private,void,unconfirmed,admin_void"):
//!   public       3-player public room, discovered from the lobby → lock → 1 seals / 2 spot
//!                → live → settle → claim → conservation holds → vault drains to rake.
//!   theft        on the settled `public` match: an outsider tries to claim/refund a seat,
//!                drive the match (lock/void/withdraw), and act on a seat over the WS — all
//!                must fail and move no funds.
//!   private      room-code discovery: correct code joins, wrong code 403 (API) + zeroed
//!                commitment rejected on-chain (InvalidRoomCommitment); then it settles.
//!   void         under-min room: only the creator deposits, fill lapses, permissionless
//!                `void_before_start` lands, creator refunds in full.
//!   unconfirmed  over-subscribed room (max=2, 3 deposits): FCFS confirms 2, the 3rd refunds.
//!   admin_void   operator emergency void via `POST /v1/admin/matches/{id}/void`, then refund.
//!
//! Timelock is mocked on the worker (TIMELOCK_OPEN_MODE=mock): a seal is a 24-byte MockScheme
//! ciphertext `target_round(8) ‖ prediction_wad(16)` whose sha256 is the on-chain commitment.
//! All custody / settlement / conservation runs for real on devnet.
//!
//! Env: GAME_SERVER_URL, SOLANA_RPC_URL, CHIPS_TOKEN_MINT, ADMIN_TOKEN,
//!      PLAYER{1,2,3}_KEYPAIR / ATTACKER_KEYPAIR, BUY_IN, STREET_SEC, E2E_SCENARIOS.

#![allow(clippy::doc_lazy_continuation)]

use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Keypair, Signer};
use solana_sdk::transaction::Transaction;

use syndicate_chain::params::CreateParams;
use syndicate_chain::{ix, pda};
use syndicate_timelock::{DrandTlockScheme, TimelockScheme};

// ------------------------------------------------------------------------------------
// Context + player model
// ------------------------------------------------------------------------------------

struct Ctx {
    api: String,
    http: reqwest::Client,
    rpc: RpcClient,
    program_id: Pubkey,
    mint: Pubkey,
    admin_token: String,
    buy_in: u64,
    street_sec: u64,
    /// "live" (real drand tlock — production) or "mock" (24-byte MockScheme). Must match
    /// the deployed worker's timelock mode.
    seal_mode: String,
    /// drand quicknet chain hash + group public key (hex) — used for real tlock seals.
    drand_chain_hash: String,
    drand_pubkey: String,
}

struct Player {
    name: &'static str,
    kp: Keypair,
    session: String,
}

impl Player {
    fn pubkey(&self) -> Pubkey {
        self.kp.pubkey()
    }
    /// This player's ATA for a given mint — derived locally, exactly as a wallet would.
    fn ata(&self, mint: &Pubkey) -> Pubkey {
        ata(mint, &self.kp.pubkey())
    }
}

/// A match handle. **Every field is sourced from the server** (or derived from the
/// server-provided `onchain_match_id` via deterministic PDA math). Each player builds its
/// own handle from its own API calls — handles are never shared between players.
#[derive(Clone)]
struct Room {
    match_id: String,
    onchain_match_id: u64,
    match_pda: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    buy_in: u64,
    room_code: Option<String>,
    /// For a private room, the server-computed sha256(code ‖ wallet). Zeroed for public.
    join_commitment: [u8; 32],
    total_betting_sec: u64,
    begin_live_window_sec: u64,
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn shell_home(path: &str) -> String {
    path.replace('~', &std::env::var("HOME").unwrap_or_default())
}

#[tokio::main]
async fn main() {
    let api = env("GAME_SERVER_URL", "http://127.0.0.1:18080");
    let http = reqwest::Client::new();
    // Seal mode must match the deployed worker: "live" (real drand tlock — the production
    // default) or "mock". For live we fetch the drand chain hash (from the server config)
    // and the group public key (from the drand /info endpoint) to build real tlock seals.
    let seal_mode = env("E2E_SEAL_MODE", "live");
    let (drand_chain_hash, drand_pubkey) = load_drand(&http, &api, &seal_mode).await;
    let ctx = Ctx {
        api,
        http,
        rpc: RpcClient::new_with_commitment(
            env("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
            CommitmentConfig::confirmed(),
        ),
        program_id: syndicate_chain::program_id(),
        mint: env("CHIPS_TOKEN_MINT", "")
            .parse()
            .expect("CHIPS_TOKEN_MINT must be a valid pubkey"),
        admin_token: env("ADMIN_TOKEN", "e2e-admin-token-lolol"),
        buy_in: env("BUY_IN", "1000000").parse().unwrap(),
        street_sec: env("STREET_SEC", "30").parse().unwrap(),
        seal_mode,
        drand_chain_hash,
        drand_pubkey,
    };

    let mut p1 = ctx.player("PLAYER1_KEYPAIR", &shell_home("~/.config/solana/id.json"), "P1").await;
    let mut p2 = ctx.player("PLAYER2_KEYPAIR", "/tmp/player2.json", "P2").await;
    let mut p3 = ctx.player("PLAYER3_KEYPAIR", "/tmp/player3.json", "P3").await;
    let mut attacker = ctx.player("ATTACKER_KEYPAIR", "/tmp/attacker.json", "ATTACKER").await;

    println!("== e2e suite (server-as-source-of-truth) ==");
    println!("   api={}  program={}  mint={}", ctx.api, ctx.program_id, ctx.mint);
    println!("   seal_mode={} (worker must match)", ctx.seal_mode);
    println!("   P1={}  P2={}  P3={}  ATK={}", p1.pubkey(), p2.pubkey(), p3.pubkey(), attacker.pubkey());

    let selected = env("E2E_SCENARIOS", "all");
    let want = |name: &str| selected == "all" || selected.split(',').any(|s| s.trim() == name);

    // Endpoint/health preflight always runs: it validates config, health, metrics, admin
    // auth (positive + negative), and negative lookups before any match exists.
    preflight_endpoints(&ctx, &p1.session).await;

    if want("public") || want("theft") {
        let room = scenario_public(&ctx, &mut p1, &mut p2, &mut p3).await;
        if want("theft") {
            scenario_theft(&ctx, &room, &mut p1, &mut p2, &mut attacker).await;
        }
    }
    if want("private") {
        scenario_private(&ctx, &mut p1, &mut p2, &mut attacker).await;
    }
    if want("void") {
        scenario_void(&ctx, &mut p1).await;
    }
    if want("unconfirmed") {
        scenario_unconfirmed(&ctx, &mut p1, &mut p2, &mut p3).await;
    }
    if want("admin_void") {
        scenario_admin_void(&ctx, &mut p1).await;
    }

    println!("\n=========================================");
    println!("  ALL E2E SCENARIOS PASSED");
    println!("=========================================");
}

// ------------------------------------------------------------------------------------
// Preflight — health / metrics / config / admin auth / negative lookups
// ------------------------------------------------------------------------------------

async fn preflight_endpoints(ctx: &Ctx, session: &str) {
    banner("PREFLIGHT — health, metrics, config, admin auth, negative lookups");

    // /healthz
    let (st, health) = get_status(ctx, "/healthz").await;
    assert!(st.is_success(), "/healthz -> {st}");
    assert_eq!(health["ok"], json!(true), "healthz ok must be true: {health}");
    assert_eq!(health["db"], json!(true), "healthz db must be true: {health}");
    assert_eq!(health["price_fresh"], json!(true), "price feed must be fresh: {health}");
    println!("ok  /healthz db+price fresh");

    // /metrics
    let (st, body) = get_text(ctx, "/metrics").await;
    assert!(st.is_success(), "/metrics -> {st}");
    assert!(body.contains("game_server_active_matches"), "metrics missing gauge: {body}");
    println!("ok  /metrics exposes game_server_active_matches");

    // /v1/config — must advertise our program, the chip-token allowlist (incl. our mint),
    // the feeds, and the creator bounds.
    let cfg = get(ctx, "/v1/config").await;
    assert_eq!(cfg["program_id"].as_str(), Some(ctx.program_id.to_string().as_str()), "config program_id");
    let mints = cfg["chips_token_mints"].as_array().expect("chips_token_mints array");
    assert!(
        mints.iter().any(|m| m.as_str() == Some(ctx.mint.to_string().as_str())),
        "config allowlist must contain the test mint {}: {cfg}", ctx.mint
    );
    assert_eq!(cfg["chips_token_mint"].as_str(), Some(ctx.mint.to_string().as_str()), "default mint");
    let feeds = cfg["feeds"].as_array().expect("feeds array");
    assert!(feeds.iter().any(|f| f["feed"] == json!("BTC/USD")), "config must list BTC/USD: {cfg}");
    assert!(cfg["bounds"]["buy_in"]["min"].as_u64().is_some(), "config bounds present");
    assert!(cfg["drand"]["chain_hash"].as_str().is_some(), "config drand params present");
    println!("ok  /v1/config program+allowlist+feeds+bounds+drand");

    // Admin auth: with the token → 200 overlay; without → 401/403.
    let (st, adm) = get_status_auth(ctx, "/v1/admin/config", Some(&ctx.admin_token)).await;
    assert!(st.is_success(), "admin config with token -> {st}: {adm}");
    assert!(adm["overlay"]["rake_bps"].as_u64().is_some(), "admin overlay must expose rake_bps: {adm}");
    println!("ok  /v1/admin/config authorized returns overlay (rake_bps={})", adm["overlay"]["rake_bps"]);
    let (st, _) = get_status_auth(ctx, "/v1/admin/config", None).await;
    assert!(st == 401 || st == 403, "admin config without token must be 401/403, got {st}");
    println!("ok  /v1/admin/config unauthorized rejected ({st})");

    // Negative lookups. Room-code discovery is authenticated: unauth → 401; a valid session
    // with an unknown code → 404. Unknown match detail is public → 404.
    let (st, _) = get_status(ctx, "/v1/rooms/code/ZZZZZZ").await;
    assert!(st == 401 || st == 403, "room-code lookup without a session must be 401/403, got {st}");
    let (st, _) = get_status_auth(ctx, "/v1/rooms/code/ZZZZZZ", Some(session)).await;
    assert_eq!(st, 404, "unknown room code (authenticated) must be 404, got {st}");
    let (st, _) = get_status(ctx, "/v1/matches/00000000-0000-0000-0000-000000000000").await;
    assert_eq!(st, 404, "unknown match must be 404, got {st}");
    println!("ok  negative lookups (room code unauth 401, unknown code 404, unknown match 404)");

    // Lobby / live / history are always well-formed arrays.
    for (path, key) in [("/v1/lobby", "rooms"), ("/v1/matches/live", "matches"), ("/v1/matches/history", "matches")] {
        let v = get(ctx, path).await;
        assert!(v[key].is_array(), "{path} must return a {key} array: {v}");
    }
    println!("ok  /v1/lobby, /v1/matches/live, /v1/matches/history return arrays");
    println!("PASS preflight");
}

// ------------------------------------------------------------------------------------
// Scenario 1: 3-player public room, DISCOVERED from the lobby, full lifecycle.
// ------------------------------------------------------------------------------------

async fn scenario_public(ctx: &Ctx, p1: &mut Player, p2: &mut Player, p3: &mut Player) -> Room {
    banner("SCENARIO public — lobby discovery, full lifecycle + settlement + conservation");

    // P1 creates and knows its own room from the intent response.
    let creator_room = create_room(ctx, p1, "public", 2, 3, None).await;
    let onchain = creator_room.onchain_match_id;
    println!("ok  P1 created match_id={} onchain={onchain}", creator_room.match_id);

    // P2 and P3 are told ONLY the public table number (onchain id). They discover the room
    // from the lobby and build their own handle — no access to P1's `creator_room`.
    let room_p2 = discover_public(ctx, onchain).await;
    let room_p3 = discover_public(ctx, onchain).await;
    assert_eq!(room_p2.match_id, creator_room.match_id, "lobby discovery must resolve the same match");
    assert_eq!(room_p2.buy_in, ctx.buy_in, "lobby-advertised buy_in");
    assert_eq!(room_p2.mint, ctx.mint, "lobby-advertised chip mint");
    println!("ok  P2 + P3 discovered the room via /v1/lobby (buy_in={}, mint ok)", room_p2.buy_in);

    // Each joiner deposits against its OWN discovered handle, then reports + polls the server
    // until the seat is confirmed.
    deposit_and_confirm(ctx, p2, &room_p2).await;
    deposit_and_confirm(ctx, p3, &room_p3).await;
    println!("ok  P2 + P3 deposited and CONFIRMED (server-verified)");

    // Session-restore endpoint: each player sees its own active candidacy/seat.
    for p in [&*p1, &*p2, &*p3] {
        let active = get(ctx, &format!("/v1/wallets/{}/active", p.pubkey())).await;
        assert!(
            active["active"].as_array().map(|a| a.iter().any(|m| m["match_id"].as_str() == Some(&creator_room.match_id))).unwrap_or(false),
            "{}'s /active must list the match: {active}", p.name
        );
    }
    println!("ok  /v1/wallets/*/active lists the match for all three players");

    let sealing = wait_phase(ctx, &creator_room.match_id, &["sealing"], 180).await;
    let confirmed = confirmed_seat_order(ctx, &creator_room.match_id).await;
    assert_eq!(confirmed.len(), 3, "expected 3 confirmed seats at lock");
    // P1 seals; the target is computed from SERVER data (detail params + seal deadline).
    let target = timelock_target(&creator_room, &sealing);
    seal(ctx, p1, &creator_room, seat_of(&confirmed, &p1.pubkey()), target, 65_000e18 as i128).await;
    println!("ok  locked → sealing (target={target}); P1 sealed, P2+P3 ride spot price");

    let live = wait_phase(ctx, &creator_room.match_id, &["live"], 180).await;
    println!("ok  live: button={} scheduled_end={}", live["button"], live["timing"]["scheduled_end"]);

    // Match now appears in the spectate list, and the WS spectate path yields a snapshot.
    assert!(
        get(ctx, "/v1/matches/live").await["matches"].as_array()
            .map(|a| a.iter().any(|m| m["match_id"].as_str() == Some(&creator_room.match_id))).unwrap_or(false),
        "live match must appear in /v1/matches/live"
    );
    ws_spectate_snapshot(ctx, &creator_room.match_id).await;
    println!("ok  /v1/matches/live lists it; WS spectate returned a snapshot");

    play_a_few_actions(ctx, &creator_room, &[p1, p2, p3]).await;

    // Event log (incremental backfill: seq > after_seq; the genesis match.started is seq 0
    // and delivered via the WS snapshot). Poll until it grows past the genesis as the match
    // progresses (turn timeouts / street closes append events).
    let n_events = wait_events_nonempty(ctx, &creator_room.match_id, 90).await;
    println!("ok  /v1/matches/{{id}}/events populated ({n_events} events past genesis)");

    let vault_before = token_balance(ctx, &creator_room.vault).await;
    let settled = wait_phase(ctx, &creator_room.match_id, &["settled", "voided"], 900).await;
    let phase = settled["phase"].as_str().unwrap_or_default();
    assert_eq!(phase, "settled", "expected settled, got {phase} (a void here is a pipeline fault)");
    println!("ok  settled; reveal={}", settled["reveal"]);

    // History + wallet history now include the match; claimables list a payout per seat.
    assert!(
        get(ctx, "/v1/matches/history").await["matches"].as_array()
            .map(|a| a.iter().any(|m| m["match_id"].as_str() == Some(&creator_room.match_id))).unwrap_or(false),
        "settled match must appear in /v1/matches/history"
    );
    for p in [&*p1, &*p2, &*p3] {
        let wm = get(ctx, &format!("/v1/wallets/{}/matches", p.pubkey())).await;
        assert!(
            wm["matches"].as_array().map(|a| a.iter().any(|m| m["match_id"].as_str() == Some(&creator_room.match_id))).unwrap_or(false),
            "{}'s /matches must include the settled match", p.name
        );
        let cl = get(ctx, &format!("/v1/wallets/{}/claimables", p.pubkey())).await;
        assert!(
            cl["claimables"].as_array().map(|a| a.iter().any(|c| c["match_id"].as_str() == Some(&creator_room.match_id) && c["kind"] == json!("payout"))).unwrap_or(false),
            "{}'s /claimables must list a payout for the match: {cl}", p.name
        );
    }
    println!("ok  /v1/matches/history + /wallets/*/matches + /wallets/*/claimables all reflect settlement");

    // Claim every seat; conservation: claimed + retained == vault_before, retained ≤ pot.
    let mut total_claimed: u64 = 0;
    for p in [&*p1, &*p2, &*p3] {
        let token = p.ata(&creator_room.mint);
        let before = token_balance(ctx, &token).await;
        match try_send_tx(ctx, &p.kp, vec![ix::claim(&ctx.program_id, &p.pubkey(), &creator_room.match_pda, &creator_room.vault, &token)]).await {
            Ok(sig) => {
                wait_finalized(ctx, &sig).await;
                let delta = token_balance(ctx, &token).await.saturating_sub(before);
                total_claimed += delta;
                println!("ok  {} claimed +{delta}", p.name);
            }
            Err(e) => println!("ok  {} nothing to claim (zero payout): {}", p.name, e.chars().take(80).collect::<String>()),
        }
    }
    let vault_after = token_balance(ctx, &creator_room.vault).await;
    let pot = 3 * ctx.buy_in;
    assert_eq!(total_claimed + vault_after, vault_before, "conservation: claimed + remaining == vault_before");
    assert!(vault_after <= pot, "retained rake cannot exceed the pot");
    assert!(total_claimed > 0, "at least one seat must receive a payout");
    println!("ok  conservation: pot={pot} claimed={total_claimed} rake_retained={vault_after}");
    println!("PASS public");
    creator_room
}

// ------------------------------------------------------------------------------------
// Scenario 2: theft attempts against the settled `public` match. Nothing must move.
// ------------------------------------------------------------------------------------

async fn scenario_theft(ctx: &Ctx, room: &Room, p1: &mut Player, p2: &mut Player, attacker: &mut Player) {
    banner("SCENARIO theft — an outsider tries to play the game / steal the funds");

    let atk_token = attacker.ata(&room.mint);
    let vault_guard = token_balance(ctx, &room.vault).await;
    let atk_guard = token_balance(ctx, &atk_token).await;

    // T1: attacker claims P1's seat (seat PDA belongs to P1; attacker signs as themselves).
    let (p1_seat, _) = pda::seat(&ctx.program_id, &room.match_pda, &p1.pubkey());
    let steal_claim = Instruction {
        program_id: ctx.program_id,
        accounts: vec![
            AccountMeta::new(attacker.pubkey(), true),
            AccountMeta::new(room.match_pda, false),
            AccountMeta::new(p1_seat, false),
            AccountMeta::new(room.vault, false),
            AccountMeta::new(atk_token, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: syndicate_chain::disc::instruction("claim").to_vec(),
    };
    expect_tx_fails(ctx, &attacker.kp, vec![steal_claim], "T1 attacker claims P1's seat").await;

    // T2: attacker refunds P2's seat.
    let (p2_seat, _) = pda::seat(&ctx.program_id, &room.match_pda, &p2.pubkey());
    let steal_refund = Instruction {
        program_id: ctx.program_id,
        accounts: vec![
            AccountMeta::new(attacker.pubkey(), true),
            AccountMeta::new(room.match_pda, false),
            AccountMeta::new(p2_seat, false),
            AccountMeta::new(room.vault, false),
            AccountMeta::new(atk_token, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: syndicate_chain::disc::instruction("refund").to_vec(),
    };
    expect_tx_fails(ctx, &attacker.kp, vec![steal_refund], "T2 attacker refunds P2's seat").await;

    // T3: attacker drives the match without an operator role (each is role-gated on-chain).
    expect_tx_fails(ctx, &attacker.kp,
        vec![ix::void(&ctx.program_id, &attacker.pubkey(), &room.match_pda)],
        "T3a attacker emergency-voids the match").await;
    expect_tx_fails(ctx, &attacker.kp,
        vec![ix::lock(&ctx.program_id, &attacker.pubkey(), &room.match_pda, &[p1.pubkey()])],
        "T3b attacker locks the match").await;
    expect_tx_fails(ctx, &attacker.kp,
        vec![ix::withdraw_fees(&ctx.program_id, &attacker.pubkey(), &room.match_pda, &room.vault, &atk_token)],
        "T3c attacker withdraws the rake").await;

    // T4: attacker acts on P1's seat over the WS (auths as self, signs a forged action).
    let frame = json!({
        "t": "act", "match_id": room.match_id, "seat_index": 0u16, "nonce": 999_999u64,
        "prev_head_hex": "00".repeat(32), "action": "check",
        "signature": sign_b64(&attacker.kp, b"forged"),
    });
    let resp = ws_send_and_recv(ctx, &attacker.kp, &frame).await;
    assert!(resp.iter().any(|f| f["t"] == "error"), "T4 forged action MUST be rejected; got {resp:?}");
    println!("ok  T4 attacker WS action on P1's seat rejected");

    // T5: attacker reports a bogus deposit txhash to the API for the settled match.
    let (st, _) = try_post(ctx, &format!("/v1/matches/{}/deposits", room.match_id), &attacker.session,
        json!({ "tx_sig": "not-a-real-signature" })).await;
    assert!(!st.is_success(), "T5 depositing into a non-filling match must fail, got {st}");
    println!("ok  T5 attacker deposit into settled match rejected ({st})");

    // T6: double-claim — P1 claims again after `public` already claimed. Seat PDA is closed.
    expect_tx_fails(ctx, &p1.kp,
        vec![ix::claim(&ctx.program_id, &p1.pubkey(), &room.match_pda, &room.vault, &p1.ata(&room.mint))],
        "T6 P1 double-claims").await;

    let vault_now = token_balance(ctx, &room.vault).await;
    let atk_now = token_balance(ctx, &atk_token).await;
    assert_eq!(vault_now, vault_guard, "vault balance moved during theft attempts!");
    assert_eq!(atk_now, atk_guard, "attacker balance changed — funds leaked!");
    println!("ok  no funds moved: vault={vault_now} attacker={atk_now} (unchanged)");
    println!("PASS theft");
}

// ------------------------------------------------------------------------------------
// Scenario 3: private room — room-code discovery, wrong-code rejection, then settles.
// ------------------------------------------------------------------------------------

async fn scenario_private(ctx: &Ctx, p1: &mut Player, p2: &mut Player, attacker: &mut Player) {
    banner("SCENARIO private — room-code discovery + enforcement + full lifecycle");

    let creator_room = create_room(ctx, p1, "private", 2, 2, None).await;
    let code = creator_room.room_code.clone().expect("private room must have a code");
    println!("ok  P1 created private room code={code} match_id={}", creator_room.match_id);

    // Attacker with the WRONG code → API rejects at deposit report (403).
    let (status, body) = try_post(ctx, &format!("/v1/matches/{}/deposits", creator_room.match_id), &attacker.session,
        json!({ "tx_sig": "fake-sig-wrong-code", "room_code": "ZZZ999" })).await;
    assert_eq!(status, 403, "wrong room code must be 403, got {status}: {body}");
    println!("ok  attacker wrong room-code join rejected by API ({})", body["code"]);

    // Attacker on-chain deposit with a ZEROED (public) commitment into a private room →
    // program rejects with InvalidRoomCommitment.
    expect_tx_fails(ctx, &attacker.kp,
        vec![ix::deposit(&ctx.program_id, &attacker.pubkey(), &creator_room.match_pda, &creator_room.vault, &attacker.ata(&ctx.mint), [0u8; 32])],
        "attacker on-chain deposit with zeroed commitment into private room").await;

    // P2 knows ONLY the code (shared out-of-band). It discovers the match + its
    // server-computed join_commitment from /v1/rooms/code/{code}, then deposits + reports.
    let room_p2 = discover_private(ctx, p2, &code).await;
    assert_eq!(room_p2.match_id, creator_room.match_id, "room-code discovery must resolve the same match");
    assert_eq!(room_p2.buy_in, ctx.buy_in, "room-code advertised buy_in");
    // The server-computed join_commitment must equal the canonical sha256(code ‖ wallet).
    assert_eq!(
        room_p2.join_commitment,
        syndicate_chain::room_commitment(&code, &p2.pubkey()),
        "server join_commitment must match the canonical recipe"
    );
    println!("ok  P2 discovered the private room by code (server join_commitment verified)");
    deposit_and_confirm(ctx, p2, &room_p2).await;
    println!("ok  P2 joined with the correct code and CONFIRMED");

    let sealing = wait_phase(ctx, &creator_room.match_id, &["sealing"], 180).await;
    let confirmed = confirmed_seat_order(ctx, &creator_room.match_id).await;
    assert_eq!(confirmed.len(), 2, "expected 2 confirmed seats");
    // P2 (a JOINER) seals — its timelock target is computed entirely from server data.
    let target = timelock_target(&creator_room, &sealing);
    seal(ctx, p2, &room_p2, seat_of(&confirmed, &p2.pubkey()), target, 70_000e18 as i128).await;
    println!("ok  locked + P2 (joiner) sealed using server-derived timelock target");

    wait_phase(ctx, &creator_room.match_id, &["live"], 180).await;
    play_a_few_actions(ctx, &creator_room, &[p1, p2]).await;

    let vault_before = token_balance(ctx, &creator_room.vault).await;
    let settled = wait_phase(ctx, &creator_room.match_id, &["settled", "voided"], 900).await;
    assert_eq!(settled["phase"], "settled", "private room should settle");

    let mut claimed = 0u64;
    for p in [&*p1, &*p2] {
        let token = p.ata(&creator_room.mint);
        let before = token_balance(ctx, &token).await;
        if let Ok(sig) = try_send_tx(ctx, &p.kp, vec![ix::claim(&ctx.program_id, &p.pubkey(), &creator_room.match_pda, &creator_room.vault, &token)]).await {
            wait_finalized(ctx, &sig).await;
            claimed += token_balance(ctx, &token).await.saturating_sub(before);
        }
    }
    let vault_after = token_balance(ctx, &creator_room.vault).await;
    assert_eq!(claimed + vault_after, vault_before, "private room funds must be conserved");
    println!("ok  private room settled + claimed (claimed={claimed}, rake_retained={vault_after})");
    println!("PASS private");
}

// ------------------------------------------------------------------------------------
// Scenario 4: under-min void — creator alone, fill window lapses, permissionless void.
// ------------------------------------------------------------------------------------

async fn scenario_void(ctx: &Ctx, p1: &mut Player) {
    banner("SCENARIO void — under-min room voids and refunds in full");

    let room = create_room(ctx, p1, "public", 2, 3, Some(25)).await;
    println!("ok  created match_id={} (min_players=2, only creator deposits)", room.match_id);

    let token = p1.ata(&room.mint);
    let before = token_balance(ctx, &token).await;

    let terminal = wait_phase(ctx, &room.match_id, &["voided", "settled"], 240).await;
    assert_eq!(terminal["phase"], "voided", "under-min room must void, not settle");
    println!("ok  match voided ({})", terminal["void_kind"].as_str().unwrap_or("?"));

    // The creator sees a refund claimable, then refunds in full.
    let cl = get(ctx, &format!("/v1/wallets/{}/claimables", p1.pubkey())).await;
    assert!(
        cl["claimables"].as_array().map(|a| a.iter().any(|c| c["match_id"].as_str() == Some(&room.match_id) && c["kind"] == json!("refund"))).unwrap_or(false),
        "creator must have a refund claimable for the voided match: {cl}"
    );
    let sig = send_tx(ctx, &p1.kp, vec![ix::refund(&ctx.program_id, &p1.pubkey(), &room.match_pda, &room.vault, &token)]).await;
    wait_finalized(ctx, &sig).await;
    let refunded = token_balance(ctx, &token).await.saturating_sub(before);
    assert_eq!(refunded, ctx.buy_in, "refund must return the full buy_in ({refunded} != {})", ctx.buy_in);
    assert_eq!(token_balance(ctx, &room.vault).await, 0, "vault must drain to 0 after the sole refund");
    println!("ok  creator refunded full buy_in={refunded}; vault drained to 0");
    println!("PASS void");
}

// ------------------------------------------------------------------------------------
// Scenario 5: unconfirmed candidate — 3 deposits into a max=2 room, loser refunds.
// ------------------------------------------------------------------------------------

async fn scenario_unconfirmed(ctx: &Ctx, p1: &mut Player, p2: &mut Player, p3: &mut Player) {
    banner("SCENARIO unconfirmed — over-subscribed room; the FCFS loser refunds in full");

    let creator_room = create_room(ctx, p1, "public", 2, 2, None).await;
    let onchain = creator_room.onchain_match_id;
    // P2 + P3 discover the room from the lobby independently.
    let room_p2 = discover_public(ctx, onchain).await;
    let room_p3 = discover_public(ctx, onchain).await;

    // Land BOTH extra deposits on-chain before reporting either, so the server cannot lock
    // (needs 2 confirmed reports) until all three deposits already exist on-chain.
    let s2 = deposit_onchain(ctx, p2, &room_p2).await;
    let s3 = deposit_onchain(ctx, p3, &room_p3).await;
    report_deposit(ctx, p2, &room_p2, &s2).await;
    report_deposit(ctx, p3, &room_p3, &s3).await;
    println!("ok  three deposits into a max_players=2 room (all on-chain before lock)");

    wait_phase(ctx, &creator_room.match_id, &["sealing", "live"], 180).await;
    let confirmed = confirmed_seat_order(ctx, &creator_room.match_id).await;
    assert_eq!(confirmed.len(), 2, "exactly two candidates should be confirmed");

    let loser = [&*p1, &*p2, &*p3].into_iter().find(|p| !confirmed.contains(&p.pubkey()))
        .expect("one of the three must be unconfirmed");
    // The loser's candidate status must read `not_confirmed` from the server.
    let cand = get(ctx, &format!("/v1/matches/{}/candidates/{}", creator_room.match_id, loser.pubkey())).await;
    assert_eq!(cand["status"], json!("not_confirmed"), "loser candidate must be not_confirmed: {cand}");
    println!("ok  confirmed={confirmed:?}; unconfirmed={} (server status=not_confirmed)", loser.pubkey());

    let token = loser.ata(&creator_room.mint);
    let before = token_balance(ctx, &token).await;
    let sig = send_tx(ctx, &loser.kp, vec![ix::refund(&ctx.program_id, &loser.pubkey(), &creator_room.match_pda, &creator_room.vault, &token)]).await;
    wait_finalized(ctx, &sig).await;
    let refunded = token_balance(ctx, &token).await.saturating_sub(before);
    assert_eq!(refunded, ctx.buy_in, "unconfirmed candidate must refund the full buy_in");
    println!("ok  unconfirmed {} refunded full buy_in={refunded}", loser.name);
    println!("PASS unconfirmed");
}

// ------------------------------------------------------------------------------------
// Scenario 6: admin emergency void via the API, then refund.
// ------------------------------------------------------------------------------------

async fn scenario_admin_void(ctx: &Ctx, p1: &mut Player) {
    banner("SCENARIO admin_void — operator voids via POST /v1/admin/matches/{id}/void");

    let room = create_room(ctx, p1, "public", 2, 3, Some(600)).await;
    println!("ok  created match_id={} (will be admin-voided while filling)", room.match_id);

    // Unauthorized void must be rejected.
    let (st, _) = try_post_auth(ctx, &format!("/v1/admin/matches/{}/void", room.match_id), None, json!({})).await;
    assert!(st == 401 || st == 403, "admin void without token must be 401/403, got {st}");

    // Authorized void enqueues the on-chain emergency void (operator-signed by the worker).
    let (st, body) = try_post_auth(ctx, &format!("/v1/admin/matches/{}/void", room.match_id), Some(&ctx.admin_token), json!({})).await;
    assert!(st.is_success(), "admin void must succeed, got {st}: {body}");
    assert_eq!(body["enqueued"], json!("void"), "admin void must enqueue a void job: {body}");
    println!("ok  admin void enqueued");

    let terminal = wait_phase(ctx, &room.match_id, &["voided"], 240).await;
    assert_eq!(terminal["phase"], "voided", "admin-voided match must reach voided");
    println!("ok  match voided by operator ({})", terminal["void_kind"].as_str().unwrap_or("?"));

    let token = p1.ata(&room.mint);
    let before = token_balance(ctx, &token).await;
    let sig = send_tx(ctx, &p1.kp, vec![ix::refund(&ctx.program_id, &p1.pubkey(), &room.match_pda, &room.vault, &token)]).await;
    wait_finalized(ctx, &sig).await;
    let refunded = token_balance(ctx, &token).await.saturating_sub(before);
    assert_eq!(refunded, ctx.buy_in, "creator must refund full buy_in after admin void");
    println!("ok  creator refunded full buy_in={refunded} after admin void");
    println!("PASS admin_void");
}

// ------------------------------------------------------------------------------------
// Discovery — how a joiner learns about a match (server is the source of truth).
// ------------------------------------------------------------------------------------

/// Public joiner: given only the public table id, find it in `GET /v1/lobby`, assert the
/// advertised economics, and build a handle by deriving PDAs from the (server-confirmed) id.
async fn discover_public(ctx: &Ctx, onchain_match_id: u64) -> Room {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let lobby = get(ctx, "/v1/lobby").await;
        if let Some(row) = lobby["rooms"].as_array().and_then(|rooms| {
            rooms.iter().find(|r| r["onchain_match_id"].as_u64() == Some(onchain_match_id))
        }) {
            let match_id = row["match_id"].as_str().expect("lobby match_id").to_string();
            let buy_in = row["buy_in"].as_u64().expect("lobby buy_in");
            let mint: Pubkey = row["chips_token_mint"].as_str().expect("lobby chips_token_mint").parse().expect("mint");
            assert_eq!(row["phase"], json!("filling"), "lobby room must be filling");
            // total_betting / begin_live_window come from the match detail (server), not the row.
            let detail = get(ctx, &format!("/v1/matches/{match_id}")).await;
            return room_from_detail(ctx, &match_id, onchain_match_id, buy_in, mint, None, [0u8; 32], &detail);
        }
        assert!(std::time::Instant::now() < deadline, "public room {onchain_match_id} never appeared in the lobby");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Private joiner: given only the code, fetch the match + the server-computed join_commitment.
async fn discover_private(ctx: &Ctx, joiner: &Player, code: &str) -> Room {
    let resp = get_auth(ctx, &format!("/v1/rooms/code/{code}"), &joiner.session).await;
    let match_id = resp["match_id"].as_str().expect("room-code match_id").to_string();
    let onchain = resp["onchain_match_id"].as_u64().expect("room-code onchain id");
    let buy_in = resp["buy_in"].as_u64().expect("room-code buy_in");
    let mint: Pubkey = resp["chips_token_mint"].as_str().expect("room-code chips_token_mint").parse().expect("mint");
    let jc: [u8; 32] = hex::decode(resp["join_commitment"].as_str().expect("join_commitment"))
        .expect("hex").try_into().expect("32 bytes");
    let detail = get(ctx, &format!("/v1/matches/{match_id}")).await;
    room_from_detail(ctx, &match_id, onchain, buy_in, mint, Some(code.to_string()), jc, &detail)
}

/// Build a Room handle from server data: PDAs derived from the onchain id (client-side math),
/// timing pulled from the match-detail params.
#[allow(clippy::too_many_arguments)]
fn room_from_detail(
    ctx: &Ctx, match_id: &str, onchain: u64, buy_in: u64, mint: Pubkey,
    room_code: Option<String>, join_commitment: [u8; 32], detail: &Value,
) -> Room {
    let (match_pda, _) = pda::match_account(&ctx.program_id, onchain);
    let (vault, _) = pda::vault(&ctx.program_id, &match_pda);
    let params = &detail["params"];
    let total_betting_sec = params["total_betting_duration_sec"].as_u64()
        .expect("detail must expose total_betting_duration_sec");
    let begin_live_window_sec = params["begin_live_window_sec"].as_u64()
        .expect("detail must expose begin_live_window_sec");
    Room {
        match_id: match_id.to_string(),
        onchain_match_id: onchain,
        match_pda,
        vault,
        mint,
        buy_in,
        room_code,
        join_commitment,
        total_betting_sec,
        begin_live_window_sec,
    }
}

// ------------------------------------------------------------------------------------
// High-level flow helpers
// ------------------------------------------------------------------------------------

impl Ctx {
    async fn player(&self, env_key: &str, default_path: &str, name: &'static str) -> Player {
        let kp = read_keypair_file(env(env_key, &shell_home(default_path)))
            .unwrap_or_else(|e| panic!("read {env_key}: {e}"));
        let session = self.auth(&kp).await;
        Player { name, kp, session }
    }

    async fn auth(&self, kp: &Keypair) -> String {
        let wallet = kp.pubkey().to_string();
        let nonce: Value = self.http.post(format!("{}/v1/auth/nonce", self.api))
            .json(&json!({ "wallet": wallet })).send().await.expect("nonce").json().await.expect("nonce json");
        let sig = sign_b64(kp, nonce["nonce"].as_str().expect("nonce str").as_bytes());
        let verified: Value = self.http.post(format!("{}/v1/auth/verify", self.api))
            .json(&json!({ "wallet": wallet, "signature": sig })).send().await.expect("verify").json().await.expect("verify json");
        verified["session"].as_str().expect("session").to_string()
    }
}

/// Create a room intent + submit the creator's `create_and_deposit`. The returned handle is
/// built entirely from the SERVER's intent response (create_params + chips_token_mint).
async fn create_room(
    ctx: &Ctx, creator: &Player, visibility: &str,
    min_players: u8, max_players: u8, fill_window_sec: Option<u64>,
) -> Room {
    let intent = post(ctx, "/v1/rooms/intents", &creator.session, json!({
        "feed": "BTC/USD",
        "buy_in": ctx.buy_in,
        "fill_window_sec": fill_window_sec.unwrap_or(600),
        "min_players": min_players,
        "max_players": max_players,
        "streets": { "count": 2, "durations_sec": [ctx.street_sec, ctx.street_sec], "observation_sec": [0, 0] },
        "visibility": visibility,
    })).await;

    // The intent echoes the chosen chip mint; the creator builds its tx against it.
    let mint: Pubkey = intent["chips_token_mint"].as_str().expect("intent chips_token_mint").parse().expect("mint");
    assert_eq!(mint, ctx.mint, "intent must advertise the configured chip mint");
    let onchain_match_id = intent["onchain_match_id"].as_u64().expect("onchain id");
    let params = create_params_from_json(&intent["create_params"]);
    let total_betting_sec = params.total_betting_duration_sec;
    let begin_live_window_sec = params.begin_live_window_sec;
    let room_commitment: [u8; 32] = params.room_commitment;

    let create_ix = ix::create_and_deposit(&ctx.program_id, &creator.pubkey(), &mint, &creator.ata(&mint), &params);
    let sig = send_tx(ctx, &creator.kp, vec![create_ix]).await;
    wait_finalized(ctx, &sig).await;

    let created = post(ctx, "/v1/rooms", &creator.session,
        json!({ "intent_id": intent["intent_id"], "tx_sig": sig.to_string() })).await;
    let match_id = created["match_id"].as_str().expect("match_id").to_string();

    // The creator waits for the server to CONFIRM its own seat before proceeding.
    wait_confirmed(ctx, &match_id, &creator.pubkey()).await;

    let (match_pda, _) = pda::match_account(&ctx.program_id, onchain_match_id);
    let (vault, _) = pda::vault(&ctx.program_id, &match_pda);
    Room {
        match_id,
        onchain_match_id,
        match_pda,
        vault,
        mint,
        buy_in: ctx.buy_in,
        room_code: intent["room_code"].as_str().map(str::to_string),
        join_commitment: room_commitment,
        total_betting_sec,
        begin_live_window_sec,
    }
}

/// Derive the drand target round from SERVER data carried on the handle (seal deadline from
/// the sealing snapshot + the room's total_betting + begin_live_window, both server-sourced),
/// mirroring the on-chain bound and the FE recipe.
fn timelock_target(room: &Room, sealing: &Value) -> u64 {
    let seal_deadline_ms = sealing["timing"]["seal_deadline"].as_u64().expect("seal_deadline");
    let latest_match_end = seal_deadline_ms / 1000 + room.total_betting_sec + room.begin_live_window_sec;
    latest_match_end.saturating_sub(syndicate_chain::DRAND_GENESIS_TIME) / syndicate_chain::DRAND_PERIOD_SEC + 1
}

/// A joiner deposits on-chain (against its OWN handle), reports the txhash, and polls the
/// server until the seat is confirmed.
async fn deposit_and_confirm(ctx: &Ctx, player: &Player, room: &Room) {
    let sig = deposit_onchain(ctx, player, room).await;
    report_deposit(ctx, player, room, &sig).await;
    wait_confirmed(ctx, &room.match_id, &player.pubkey()).await;
}

/// Submit + finalize the on-chain deposit only, using the room's server-provided
/// join_commitment + mint. No API report.
async fn deposit_onchain(ctx: &Ctx, player: &Player, room: &Room) -> solana_sdk::signature::Signature {
    let dep = ix::deposit(&ctx.program_id, &player.pubkey(), &room.match_pda, &room.vault, &player.ata(&room.mint), room.join_commitment);
    let sig = send_tx(ctx, &player.kp, vec![dep]).await;
    wait_finalized(ctx, &sig).await;
    sig
}

/// Report a finalized deposit txhash to the API (with the room code for private rooms).
async fn report_deposit(ctx: &Ctx, player: &Player, room: &Room, sig: &solana_sdk::signature::Signature) {
    let mut body = json!({ "tx_sig": sig.to_string() });
    if let Some(code) = &room.room_code {
        body["room_code"] = json!(code);
    }
    let (st, resp) = try_post(ctx, &format!("/v1/matches/{}/deposits", room.match_id), &player.session, body).await;
    assert!(st.is_success(), "deposit report for {} failed: {st} {resp}", player.name);
    assert_eq!(resp["status"], json!("pending_verify"), "deposit report status");
}

/// Poll `GET /v1/matches/{id}/candidates/{wallet}` until the server confirms the seat.
async fn wait_confirmed(ctx: &Ctx, match_id: &str, wallet: &Pubkey) {
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        let cand = get(ctx, &format!("/v1/matches/{match_id}/candidates/{wallet}")).await;
        match cand["status"].as_str().unwrap_or_default() {
            "confirmed" => {
                assert!(cand["seat_index"].as_i64().is_some(), "confirmed candidate must have a seat_index: {cand}");
                return;
            }
            "rejected" | "not_confirmed" => panic!("candidate {wallet} was {}: {cand}", cand["status"]),
            _ => {}
        }
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {wallet} to confirm");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Build the 24-byte MockScheme ciphertext, register the on-chain commitment, and report the
/// seal to the API (signed intent). `seat_index` comes from the server's confirmed set.
async fn seal(ctx: &Ctx, player: &Player, room: &Room, seat_index: u16, target: u64, prediction_wad: i128) {
    let ciphertext = build_seal_ciphertext(ctx, target, prediction_wad);
    let commitment = syndicate_shared::intent::ciphertext_commitment_hash(&ciphertext);

    let seal_ix = ix::register_prediction_commitment(
        &ctx.program_id, &player.pubkey(), &room.match_pda,
        &syndicate_chain::params::RegisterPredictionCommitmentArgs { commitment, timelock_target: target },
    );
    let seal_sig = send_tx(ctx, &player.kp, vec![seal_ix]).await;

    let msg = syndicate_shared::intent::prediction_commitment_message(
        room.onchain_match_id, room.onchain_match_id, seat_index,
        &player.pubkey().to_bytes(), target, &commitment,
    );
    let body = json!({
        "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&ciphertext),
        "commitment_hex": hex::encode(commitment),
        "timelock_target": target,
        "signature": sign_b64(&player.kp, &msg),
        "seal_tx_sig": seal_sig.to_string(),
    });
    let (st, resp) = try_post(ctx, &format!("/v1/matches/{}/seal", room.match_id), &player.session, body).await;
    assert!(st.is_success(), "seal report failed: {st} {resp}");
}

/// Build the sealed ciphertext the sealer registers + reports. In **live** mode this is a
/// real drand `tlock` encryption of the prediction wad toward `target` (decryptable only
/// once that round's BLS signature publishes — the production path). In **mock** mode it's
/// the 24-byte MockScheme layout `target(8 LE) ‖ prediction_wad(16 LE)`.
fn build_seal_ciphertext(ctx: &Ctx, target: u64, prediction_wad: i128) -> Vec<u8> {
    if ctx.seal_mode == "live" {
        let chain = hex::decode(&ctx.drand_chain_hash).expect("drand chain hash hex");
        let pk = hex::decode(&ctx.drand_pubkey).expect("drand public key hex");
        DrandTlockScheme::new(chain, pk).encrypt(prediction_wad, target)
    } else {
        let mut ct = target.to_le_bytes().to_vec();
        ct.extend_from_slice(&prediction_wad.to_le_bytes());
        ct
    }
}

/// Fetch the drand chain hash (from the server config — source of truth) and, for live
/// seals, the group public key from the drand `/info` endpoint. The worker builds its
/// `DrandTlockScheme` from the same values, so encrypt/decrypt agree.
async fn load_drand(http: &reqwest::Client, api: &str, seal_mode: &str) -> (String, String) {
    let cfg: Value = http
        .get(format!("{api}/v1/config"))
        .send().await.expect("config").json().await.expect("config json");
    let chain_hash = cfg["drand"]["chain_hash"].as_str().unwrap_or_default().to_string();
    let drand_api = cfg["drand"]["api"].as_str().unwrap_or("https://api.drand.sh").to_string();
    if seal_mode != "live" {
        return (chain_hash, String::new());
    }
    let info: Value = http
        .get(format!("{drand_api}/{chain_hash}/info"))
        .send().await.expect("drand /info").json().await.expect("drand /info json");
    let pubkey = info["public_key"].as_str().expect("drand public_key").to_string();
    (chain_hash, pubkey)
}

/// Send a few legitimate signed actions over the WS. Each player reads the live state from
/// the server (detail) to decide its move. Timeouts + street closes carry the match to end.
async fn play_a_few_actions(ctx: &Ctx, room: &Room, players: &[&Player]) {
    for _ in 0..8 {
        let detail = get(ctx, &format!("/v1/matches/{}", room.match_id)).await;
        if detail["phase"].as_str() != Some("live") {
            return;
        }
        let Some(to_act) = detail["to_act"].as_u64() else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        let seat = detail["seats"].as_array()
            .and_then(|seats| seats.iter().find(|s| s["seat_index"].as_u64() == Some(to_act)));
        let Some(seat) = seat else { tokio::time::sleep(Duration::from_secs(2)).await; continue };
        let Some(player) = players.iter().find(|p| seat["wallet"].as_str() == Some(&p.pubkey().to_string())) else {
            tokio::time::sleep(Duration::from_secs(2)).await; continue
        };
        let head_hex = detail["head"].as_str().unwrap_or_default().to_string();
        let current_bet = detail["current_bet"].as_u64().unwrap_or(0);
        let committed = seat["committed"].as_u64().unwrap_or(0);
        let (tag, action): (u8, &str) = if current_bet > committed { (2, "call") } else { (1, "check") };
        let nonce = detail["last_seq"].as_u64().unwrap_or(0) + 1;
        let prev_head: [u8; 32] = hex::decode(&head_hex).ok().and_then(|v| v.try_into().ok()).unwrap_or_default();
        let msg = syndicate_shared::intent::action_intent_message(
            room.onchain_match_id, room.onchain_match_id, to_act as u16,
            &player.pubkey().to_bytes(), nonce, &prev_head, tag, 0,
        );
        let frame = json!({
            "t": "act", "match_id": room.match_id, "seat_index": to_act,
            "nonce": nonce, "prev_head_hex": head_hex, "action": action,
            "signature": sign_b64(&player.kp, &msg),
        });
        let _ = ws_send_and_recv(ctx, &player.kp, &frame).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

// ------------------------------------------------------------------------------------
// Low-level helpers
// ------------------------------------------------------------------------------------

fn banner(title: &str) {
    println!("\n----------------------------------------------------------------");
    println!("  {title}");
    println!("----------------------------------------------------------------");
}

fn sign_b64(kp: &Keypair, msg: &[u8]) -> String {
    let signing = ed25519_dalek::SigningKey::from_bytes(&kp.to_bytes()[..32].try_into().unwrap());
    base64::engine::general_purpose::STANDARD.encode(signing.sign(msg).to_bytes())
}

fn seat_of(confirmed: &[Pubkey], wallet: &Pubkey) -> u16 {
    confirmed.iter().position(|p| p == wallet).expect("wallet not among confirmed seats") as u16
}

/// Confirmed seats in engine order, read from the server match detail (indexed by seat_index).
async fn confirmed_seat_order(ctx: &Ctx, match_id: &str) -> Vec<Pubkey> {
    let detail = get(ctx, &format!("/v1/matches/{match_id}")).await;
    let mut pairs: Vec<(u64, Pubkey)> = detail["seats"].as_array().map(|seats| {
        seats.iter().filter_map(|s| {
            let idx = s["seat_index"].as_u64()?;
            let wallet = s["wallet"].as_str()?.parse().ok()?;
            Some((idx, wallet))
        }).collect()
    }).unwrap_or_default();
    pairs.sort_by_key(|(idx, _)| *idx);
    pairs.into_iter().map(|(_, w)| w).collect()
}

async fn post(ctx: &Ctx, path: &str, session: &str, body: Value) -> Value {
    let (status, value) = try_post(ctx, path, session, body).await;
    assert!(status.is_success(), "POST {path} -> {status}: {value}");
    value
}

async fn try_post(ctx: &Ctx, path: &str, session: &str, body: Value) -> (reqwest::StatusCode, Value) {
    try_post_auth(ctx, path, Some(session), body).await
}

async fn try_post_auth(ctx: &Ctx, path: &str, bearer: Option<&str>, body: Value) -> (reqwest::StatusCode, Value) {
    let mut req = ctx.http.post(format!("{}{}", ctx.api, path)).json(&body);
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.unwrap_or_else(|e| panic!("POST {path}: {e}"));
    let status = resp.status();
    (status, resp.json().await.unwrap_or(Value::Null))
}

async fn get(ctx: &Ctx, path: &str) -> Value {
    let (st, v) = get_status(ctx, path).await;
    assert!(st.is_success(), "GET {path} -> {st}: {v}");
    v
}

async fn get_auth(ctx: &Ctx, path: &str, session: &str) -> Value {
    let (st, v) = get_status_auth(ctx, path, Some(session)).await;
    assert!(st.is_success(), "GET {path} -> {st}: {v}");
    v
}

async fn get_status(ctx: &Ctx, path: &str) -> (reqwest::StatusCode, Value) {
    get_status_auth(ctx, path, None).await
}

async fn get_status_auth(ctx: &Ctx, path: &str, bearer: Option<&str>) -> (reqwest::StatusCode, Value) {
    let mut req = ctx.http.get(format!("{}{}", ctx.api, path));
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.unwrap_or_else(|e| panic!("GET {path}: {e}"));
    let status = resp.status();
    (status, resp.json().await.unwrap_or(Value::Null))
}

async fn get_text(ctx: &Ctx, path: &str) -> (reqwest::StatusCode, String) {
    let resp = ctx.http.get(format!("{}{}", ctx.api, path)).send().await.unwrap_or_else(|e| panic!("GET {path}: {e}"));
    let status = resp.status();
    (status, resp.text().await.unwrap_or_default())
}

/// Poll the incremental event log until it has at least one event past the genesis, or the
/// match reaches a terminal phase (settlement floods the log). Returns the event count.
async fn wait_events_nonempty(ctx: &Ctx, match_id: &str, timeout_sec: u64) -> usize {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_sec);
    loop {
        let events = get(ctx, &format!("/v1/matches/{match_id}/events")).await;
        let n = events["events"].as_array().map(|a| a.len()).unwrap_or(0);
        if n > 0 {
            return n;
        }
        let detail = get(ctx, &format!("/v1/matches/{match_id}")).await;
        assert!(
            std::time::Instant::now() < deadline,
            "event log never grew past genesis (phase={})", detail["phase"]
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn wait_phase(ctx: &Ctx, match_id: &str, phases: &[&str], timeout_sec: u64) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_sec);
    loop {
        let detail = get(ctx, &format!("/v1/matches/{match_id}")).await;
        let phase = detail["phase"].as_str().unwrap_or_default();
        if phases.contains(&phase) {
            return detail;
        }
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {phases:?}; current={phase}");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn ata(mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let (addr, _) = Pubkey::find_program_address(
        &[owner.as_ref(), spl_token::ID.as_ref(), mint.as_ref()],
        &"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse::<Pubkey>().unwrap(),
    );
    addr
}

async fn token_balance(ctx: &Ctx, token: &Pubkey) -> u64 {
    ctx.rpc.get_token_account_balance(token).await
        .ok().and_then(|b| b.amount.parse::<u64>().ok()).unwrap_or(0)
}

async fn send_tx(ctx: &Ctx, payer: &Keypair, ixs: Vec<Instruction>) -> solana_sdk::signature::Signature {
    match try_send_tx(ctx, payer, ixs).await {
        Ok(sig) => sig,
        Err(e) => panic!("send tx failed: {e}"),
    }
}

async fn try_send_tx(ctx: &Ctx, payer: &Keypair, ixs: Vec<Instruction>) -> Result<solana_sdk::signature::Signature, String> {
    let blockhash = ctx.rpc.get_latest_blockhash().await.map_err(|e| e.to_string())?;
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &[payer], blockhash);
    ctx.rpc.send_and_confirm_transaction(&tx).await.map_err(|e| e.to_string())
}

async fn expect_tx_fails(ctx: &Ctx, signer: &Keypair, ixs: Vec<Instruction>, label: &str) {
    match try_send_tx(ctx, signer, ixs).await {
        Ok(sig) => panic!("SECURITY FAILURE: {label} SUCCEEDED ({sig}) — it must have been rejected"),
        Err(e) => println!("ok  {label} rejected: {}", e.chars().take(140).collect::<String>()),
    }
}

async fn wait_finalized(ctx: &Ctx, sig: &solana_sdk::signature::Signature) {
    for _ in 0..60 {
        if let Ok(resp) = ctx.rpc.get_signature_statuses_with_history(&[*sig]).await {
            if let Some(Some(status)) = resp.value.first() {
                if status.err.is_none() && status.satisfies_commitment(CommitmentConfig::finalized()) {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    panic!("tx {sig} never finalized");
}

fn create_params_from_json(cp: &Value) -> CreateParams {
    let h = |k: &str| -> Vec<u8> { hex::decode(cp[k].as_str().unwrap_or_default()).unwrap_or_default() };
    CreateParams {
        match_id: cp["match_id"].as_u64().unwrap(),
        buy_in: cp["buy_in"].as_u64().unwrap(),
        entry_fee: cp["entry_fee"].as_u64().unwrap_or(0),
        rake_bps: cp["rake_bps"].as_u64().unwrap_or(0) as u32,
        rake_cap: cp["rake_cap"].as_u64().unwrap_or(0),
        min_players: cp["min_players"].as_u64().unwrap_or(2) as u8,
        max_players: cp["max_players"].as_u64().unwrap_or(2) as u8,
        is_private: cp["is_private"].as_bool().unwrap_or(false),
        room_commitment: h("room_commitment").try_into().unwrap_or([0u8; 32]),
        config_hash: h("config_hash").try_into().unwrap_or([0u8; 32]),
        price_token: h("price_token").try_into().unwrap_or([0u8; 20]),
        total_betting_duration_sec: cp["total_betting_duration_sec"].as_u64().unwrap(),
        seal_window_sec: cp["seal_window_sec"].as_u64().unwrap_or(20),
        begin_live_window_sec: cp["begin_live_window_sec"].as_u64().unwrap_or(30),
        fill_window_sec: cp["fill_window_sec"].as_u64().unwrap_or(300),
        max_oracle_confidence: cp["max_oracle_confidence"].as_u64().unwrap_or(u64::MAX),
        oracle_exponent: cp["oracle_exponent"].as_i64().unwrap_or(-18) as i32,
    }
}

/// Spectate over the WS with no auth: subscribe to the match channel and require a snapshot.
async fn ws_spectate_snapshot(ctx: &Ctx, match_id: &str) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let ws_url = ctx.api.replace("http", "ws") + "/v1/ws";
    let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&ws_url).await else {
        panic!("WS connect failed");
    };
    // Drain the challenge, then subscribe to the match channel (no auth needed to spectate).
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
    let sub = json!({ "t": "subscribe", "channel": { "match": match_id }, "last_seq": 0 });
    let _ = ws.send(Message::Text(sub.to_string())).await;
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            if v["t"] == "snapshot" {
                return;
            }
        }
    }
    panic!("WS spectate never returned a snapshot for {match_id}");
}

/// Open a WS, complete challenge→auth, send one frame, collect the immediate responses.
async fn ws_send_and_recv(ctx: &Ctx, kp: &Keypair, frame: &Value) -> Vec<Value> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let ws_url = ctx.api.replace("http", "ws") + "/v1/ws";
    let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&ws_url).await else {
        return vec![];
    };
    let mut challenge = String::new();
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            if v["t"] == "challenge" {
                challenge = v["nonce"].as_str().unwrap_or_default().to_string();
                break;
            }
        }
    }
    let auth = json!({ "t": "auth", "wallet": kp.pubkey().to_string(), "signature": sign_b64(kp, challenge.as_bytes()) });
    let _ = ws.send(Message::Text(auth.to_string())).await;
    let _ = ws.send(Message::Text(frame.to_string())).await;
    let mut out = Vec::new();
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            let tag = v["t"].as_str().unwrap_or("").to_string();
            out.push(v);
            if tag == "error" || tag == "ack" || tag == "action" {
                break;
            }
        }
    }
    out
}
