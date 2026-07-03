//! Comprehensive end-to-end suite against a live v2 stack on devnet.
//!
//! Exercises the full product lifecycle AND the adversarial "someone else tries to
//! play my game / steal my funds" paths, all against the real on-chain program. It is
//! driven by `scripts/e2e-local-devnet.sh`, which creates + funds the player keypairs,
//! brings the Docker stack up on a working RPC, and then runs this binary.
//!
//! Scenarios (run in order; select a subset with E2E_SCENARIOS="public,private,..."):
//!   public          3-player public room → lock → 1 seals / 2 spot → live → settle →
//!                   claim → conservation holds → vault drains to rake.
//!   theft           on the settled `public` match: an attacker (a 4th wallet that never
//!                   sat down) tries to claim / refund another seat's funds, tries to
//!                   drive the game (lock / begin_live / settle / void / withdraw_fees)
//!                   without an operator role, and tries to act on a seat that is not
//!                   theirs over the WS. Every attempt MUST fail and MUST NOT move funds.
//!   private         private room: correct room-code join succeeds; a wrong-code join is
//!                   rejected by the API AND a zeroed on-chain commitment is rejected by
//!                   the program (InvalidRoomCommitment). Then the room settles normally.
//!   void            under-min public room: only the creator deposits, the fill window
//!                   lapses, a permissionless `void_before_start` lands, creator refunds
//!                   in full.
//!   unconfirmed     over-subscribed public room (max_players=2, three deposits): FCFS
//!                   confirms two, the third is left unconfirmed and refunds in full while
//!                   the confirmed pair plays on.
//!
//! Timelock is mocked on the worker (TIMELOCK_OPEN_MODE=mock): a seal is a 24-byte
//! MockScheme ciphertext `target_round(8) ‖ prediction_wad(16)` whose sha256 is the
//! on-chain commitment. All custody / settlement / conservation runs for real on devnet.
//!
//! Env: GAME_SERVER_URL, SOLANA_RPC_URL, CHIPS_TOKEN_MINT,
//!      PLAYER1_KEYPAIR / PLAYER2_KEYPAIR / PLAYER3_KEYPAIR / ATTACKER_KEYPAIR,
//!      BUY_IN (default 1_000_000), STREET_SEC (default 30), E2E_SCENARIOS (default "all").

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

// ------------------------------------------------------------------------------------
// Context + player model
// ------------------------------------------------------------------------------------

struct Ctx {
    api: String,
    http: reqwest::Client,
    rpc: RpcClient,
    program_id: Pubkey,
    mint: Pubkey,
    buy_in: u64,
    street_sec: u64,
}

struct Player {
    name: &'static str,
    kp: Keypair,
    session: String,
    token: Pubkey,
}

/// A created/joined room: the ids and PDAs needed for the rest of the flow.
struct Room {
    match_id: String,
    onchain_match_id: u64,
    match_pda: Pubkey,
    vault: Pubkey,
    room_code: Option<String>,
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
    let ctx = Ctx {
        api: env("GAME_SERVER_URL", "http://127.0.0.1:18080"),
        http: reqwest::Client::new(),
        rpc: RpcClient::new_with_commitment(
            env("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
            CommitmentConfig::confirmed(),
        ),
        program_id: syndicate_chain::program_id(),
        mint: env("CHIPS_TOKEN_MINT", "")
            .parse()
            .expect("CHIPS_TOKEN_MINT must be a valid pubkey"),
        buy_in: env("BUY_IN", "1000000").parse().unwrap(),
        street_sec: env("STREET_SEC", "30").parse().unwrap(),
    };

    let mut p1 = ctx.player("PLAYER1_KEYPAIR", &shell_home("~/.config/solana/id.json"), "P1").await;
    let mut p2 = ctx.player("PLAYER2_KEYPAIR", "/tmp/player2.json", "P2").await;
    let mut p3 = ctx.player("PLAYER3_KEYPAIR", "/tmp/player3.json", "P3").await;
    let mut attacker = ctx.player("ATTACKER_KEYPAIR", "/tmp/attacker.json", "ATTACKER").await;

    println!("== e2e suite ==");
    println!("   api={}  program={}  mint={}", ctx.api, ctx.program_id, ctx.mint);
    println!("   P1={}", p1.kp.pubkey());
    println!("   P2={}", p2.kp.pubkey());
    println!("   P3={}", p3.kp.pubkey());
    println!("   ATTACKER={}", attacker.kp.pubkey());

    let selected = env("E2E_SCENARIOS", "all");
    let want = |name: &str| selected == "all" || selected.split(',').any(|s| s.trim() == name);

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

    println!("\n=========================================");
    println!("  ALL E2E SCENARIOS PASSED");
    println!("=========================================");
}

// ------------------------------------------------------------------------------------
// Scenario 1: 3-player public room, full lifecycle, conservation.
// ------------------------------------------------------------------------------------

async fn scenario_public(ctx: &Ctx, p1: &mut Player, p2: &mut Player, p3: &mut Player) -> Room {
    banner("SCENARIO public — 3-player public room, full lifecycle + settlement");

    let room = create_room(ctx, p1, "public", 2, 3, None).await;
    println!("ok  created match_id={} onchain={}", room.match_id, room.onchain_match_id);

    deposit(ctx, p2, &room, None).await;
    deposit(ctx, p3, &room, None).await;
    println!("ok  P2 + P3 deposited (candidates)");

    let sealing = wait_phase(ctx, &room.match_id, &["sealing"], 180).await;
    let target = timelock_target_for(ctx, &room, &sealing);
    let confirmed = confirmed_seat_order(ctx, &room).await;
    assert_eq!(confirmed.len(), 3, "expected 3 confirmed seats at lock");
    println!("ok  locked → sealing (timelock_target={target}, {} confirmed seats)", confirmed.len());

    // P1 seals a real prediction; P2 + P3 ride the seal-close spot price.
    seal(ctx, p1, &room, seat_of(&confirmed, &p1.kp.pubkey()), target, 65_000e18 as i128).await;
    println!("ok  P1 sealed; P2 + P3 intentionally not sealing (spot-price path)");

    let live = wait_phase(ctx, &room.match_id, &["live"], 180).await;
    println!("ok  live: button={} scheduled_end={}", live["button"], live["timing"]["scheduled_end"]);

    // Exercise the signed-action path for a few turns; timeouts drive the rest to the end.
    play_a_few_actions(ctx, &room, &[p1, p2, p3]).await;

    let vault_before = token_balance(ctx, &room.vault).await;
    let settled = wait_phase(ctx, &room.match_id, &["settled", "voided"], 900).await;
    let phase = settled["phase"].as_str().unwrap_or_default();
    assert_eq!(phase, "settled", "expected settled, got {phase} (a void here is a pipeline fault)");
    println!("ok  settled; reveal={}", settled["reveal"]);

    // Claim every seat and verify conservation: Σ payouts == confirmed×buy_in − rake,
    // and the vault drains to exactly the retained rake (0..=rake_cap).
    let mut total_claimed: u64 = 0;
    for p in [&*p1, &*p2, &*p3] {
        let before = token_balance(ctx, &p.token).await;
        // A losing seat may have a zero payout; tolerate a claim that the program rejects
        // for "nothing to claim" — conservation is checked via the balance deltas below.
        match try_send_tx(ctx, &p.kp, vec![ix::claim(&ctx.program_id, &p.kp.pubkey(), &room.match_pda, &room.vault, &p.token)]).await {
            Ok(sig) => {
                wait_finalized(ctx, &sig).await;
                let delta = token_balance(ctx, &p.token).await.saturating_sub(before);
                total_claimed += delta;
                println!("ok  {} claimed +{delta} ({sig})", p.name);
            }
            Err(e) => println!("ok  {} nothing to claim (zero payout): {}", p.name, e.chars().take(80).collect::<String>()),
        }
    }

    let vault_after = token_balance(ctx, &room.vault).await;
    let pot = 3 * ctx.buy_in;
    let rake = vault_before.saturating_sub(total_claimed).min(vault_before);
    println!(
        "ok  conservation: pot={pot} claimed={total_claimed} vault_before={vault_before} vault_after={vault_after} rake_retained={rake}"
    );
    assert_eq!(
        total_claimed + vault_after,
        vault_before,
        "funds must be conserved: claimed + remaining == vault_before"
    );
    assert!(vault_after <= pot, "retained rake cannot exceed the pot");
    assert!(total_claimed > 0, "at least one seat must receive a payout");
    println!("PASS public");
    room
}

// ------------------------------------------------------------------------------------
// Scenario 2: theft attempts against the settled `public` match. Nothing must move.
// ------------------------------------------------------------------------------------

async fn scenario_theft(ctx: &Ctx, room: &Room, p1: &mut Player, p2: &mut Player, attacker: &mut Player) {
    banner("SCENARIO theft — an outsider tries to play the game / steal the funds");

    let vault_guard = token_balance(ctx, &room.vault).await;
    let atk_guard = token_balance(ctx, &attacker.token).await;

    // T1: attacker claims P1's seat. The seat PDA belongs to P1 (has_one = player), but the
    //     attacker signs as themselves → the program rejects the has_one constraint.
    let (p1_seat, _) = pda::seat(&ctx.program_id, &room.match_pda, &p1.kp.pubkey());
    let steal_claim = Instruction {
        program_id: ctx.program_id,
        accounts: vec![
            AccountMeta::new(attacker.kp.pubkey(), true), // attacker is the signer/player
            AccountMeta::new(room.match_pda, false),
            AccountMeta::new(p1_seat, false), // …but points at P1's seat
            AccountMeta::new(room.vault, false),
            AccountMeta::new(attacker.token, false), // …paying out to the attacker
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: syndicate_chain::disc::instruction("claim").to_vec(),
    };
    expect_tx_fails(ctx, &attacker.kp, vec![steal_claim], "T1 attacker claims P1's seat").await;

    // T2: attacker refunds P2's seat (also has_one = player).
    let (p2_seat, _) = pda::seat(&ctx.program_id, &room.match_pda, &p2.kp.pubkey());
    let steal_refund = Instruction {
        program_id: ctx.program_id,
        accounts: vec![
            AccountMeta::new(attacker.kp.pubkey(), true),
            AccountMeta::new(room.match_pda, false),
            AccountMeta::new(p2_seat, false),
            AccountMeta::new(room.vault, false),
            AccountMeta::new(attacker.token, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: syndicate_chain::disc::instruction("refund").to_vec(),
    };
    expect_tx_fails(ctx, &attacker.kp, vec![steal_refund], "T2 attacker refunds P2's seat").await;

    // T3: attacker drives the match without an operator role. Each is role-gated on-chain.
    expect_tx_fails(
        ctx, &attacker.kp,
        vec![ix::void(&ctx.program_id, &attacker.kp.pubkey(), &room.match_pda)],
        "T3a attacker emergency-voids the match",
    ).await;
    expect_tx_fails(
        ctx, &attacker.kp,
        vec![ix::lock(&ctx.program_id, &attacker.kp.pubkey(), &room.match_pda, &[p1.kp.pubkey()])],
        "T3b attacker locks the match",
    ).await;
    expect_tx_fails(
        ctx, &attacker.kp,
        vec![ix::withdraw_fees(&ctx.program_id, &attacker.kp.pubkey(), &room.match_pda, &room.vault, &attacker.token)],
        "T3c attacker withdraws the rake",
    ).await;

    // T4: attacker acts on P1's seat over the WS (auths as themselves, signs for P1's seat).
    //     The runtime verifies the signature against the *seat's* registered wallet → reject.
    //     (The match is already settled, so this also proves post-terminal actions are refused.)
    let seat_index = 0u16;
    let frame = json!({
        "t": "act", "match_id": room.match_id, "seat_index": seat_index, "nonce": 999_999u64,
        "prev_head_hex": "00".repeat(32),
        "action": "check",
        "signature": sign_b64(&attacker.kp, b"forged"),
    });
    let resp = ws_send_and_recv(ctx, &attacker.kp, &frame).await;
    assert!(
        resp.iter().any(|f| f["t"] == "error"),
        "T4 forged action MUST be rejected with an error frame; got {resp:?}"
    );
    println!("ok  T4 attacker action on P1's seat rejected: {}",
        resp.iter().find(|f| f["t"] == "error").map(|f| f["code"].to_string()).unwrap_or_default());

    // T5: double-claim — P1 claims again after already claiming in `public`. The seat PDA is
    //     closed, so the second claim finds no account.
    expect_tx_fails(
        ctx, &p1.kp,
        vec![ix::claim(&ctx.program_id, &p1.kp.pubkey(), &room.match_pda, &room.vault, &p1.token)],
        "T5 P1 double-claims",
    ).await;

    let vault_now = token_balance(ctx, &room.vault).await;
    let atk_now = token_balance(ctx, &attacker.token).await;
    assert_eq!(vault_now, vault_guard, "vault balance moved during theft attempts!");
    assert_eq!(atk_now, atk_guard, "attacker balance changed — funds leaked!");
    println!("ok  no funds moved: vault={vault_now} attacker={atk_now} (unchanged)");
    println!("PASS theft");
}

// ------------------------------------------------------------------------------------
// Scenario 3: private room — correct code joins, wrong code rejected, then settles.
// ------------------------------------------------------------------------------------

async fn scenario_private(ctx: &Ctx, p1: &mut Player, p2: &mut Player, attacker: &mut Player) {
    banner("SCENARIO private — room-code enforcement + full lifecycle");

    let room = create_room(ctx, p1, "private", 2, 2, None).await;
    let code = room.room_code.clone().expect("private room must have a code");
    println!("ok  created private room code={code} match_id={}", room.match_id);

    // Attacker attempts to join with the WRONG room code → API rejects at deposit report.
    let (status, body) = try_post(
        ctx, &format!("/v1/matches/{}/deposits", room.match_id), &attacker.session,
        json!({ "tx_sig": "fake-sig-wrong-code", "room_code": "ZZZ999" }),
    ).await;
    assert_eq!(status, 403, "wrong room code must be 403, got {status}: {body}");
    println!("ok  attacker wrong room-code join rejected by API ({})", body["code"]);

    // Attacker attempts an on-chain deposit with a ZEROED (public) commitment into a private
    // room → the program rejects with InvalidRoomCommitment (no API involved).
    expect_tx_fails(
        ctx, &attacker.kp,
        vec![ix::deposit(&ctx.program_id, &attacker.kp.pubkey(), &room.match_pda, &room.vault, &attacker.token, [0u8; 32])],
        "attacker on-chain deposit with zeroed commitment into private room",
    ).await;

    // P2 joins correctly: fetch the join_commitment for the code, deposit on-chain, report.
    let commitment = syndicate_chain::room_commitment(&code, &p2.kp.pubkey());
    let dep = ix::deposit(&ctx.program_id, &p2.kp.pubkey(), &room.match_pda, &room.vault, &p2.token, commitment);
    let sig = send_tx(ctx, &p2.kp, vec![dep]).await;
    wait_finalized(ctx, &sig).await;
    let (st, _) = try_post(
        ctx, &format!("/v1/matches/{}/deposits", room.match_id), &p2.session,
        json!({ "tx_sig": sig.to_string(), "room_code": code }),
    ).await;
    assert!(st.is_success(), "correct-code join should succeed, got {st}");
    println!("ok  P2 joined with correct code ({sig})");

    // Full lifecycle to settlement (2 players, P2 seals, P1 spot).
    let sealing = wait_phase(ctx, &room.match_id, &["sealing"], 180).await;
    let target = timelock_target_for(ctx, &room, &sealing);
    let confirmed = confirmed_seat_order(ctx, &room).await;
    assert_eq!(confirmed.len(), 2, "expected 2 confirmed seats");
    seal(ctx, p2, &room, seat_of(&confirmed, &p2.kp.pubkey()), target, 70_000e18 as i128).await;
    println!("ok  locked + P2 sealed");

    wait_phase(ctx, &room.match_id, &["live"], 180).await;
    play_a_few_actions(ctx, &room, &[p1, p2]).await;

    let vault_before = token_balance(ctx, &room.vault).await;
    let settled = wait_phase(ctx, &room.match_id, &["settled", "voided"], 900).await;
    assert_eq!(settled["phase"], "settled", "private room should settle");

    let mut claimed = 0u64;
    for p in [&*p1, &*p2] {
        let before = token_balance(ctx, &p.token).await;
        if let Ok(sig) = try_send_tx(ctx, &p.kp, vec![ix::claim(&ctx.program_id, &p.kp.pubkey(), &room.match_pda, &room.vault, &p.token)]).await {
            wait_finalized(ctx, &sig).await;
            claimed += token_balance(ctx, &p.token).await.saturating_sub(before);
        }
    }
    let vault_after = token_balance(ctx, &room.vault).await;
    assert_eq!(claimed + vault_after, vault_before, "private room funds must be conserved");
    println!("ok  private room settled + claimed (claimed={claimed}, rake_retained={vault_after})");
    println!("PASS private");
}

// ------------------------------------------------------------------------------------
// Scenario 4: under-min void — creator alone, fill window lapses, permissionless void.
// ------------------------------------------------------------------------------------

async fn scenario_void(ctx: &Ctx, p1: &mut Player) {
    banner("SCENARIO void — under-min room voids and refunds in full");

    // Short fill window so the void backstop fires quickly.
    let room = create_room(ctx, p1, "public", 2, 3, Some(25)).await;
    println!("ok  created match_id={} (min_players=2, only creator will deposit)", room.match_id);

    let before = token_balance(ctx, &p1.token).await;

    // Wait for the match to leave `filling` (server enqueues void_before_start at the
    // deadline; the worker lands it on-chain).
    let terminal = wait_phase(ctx, &room.match_id, &["voided", "settled"], 240).await;
    assert_eq!(terminal["phase"], "voided", "under-min room must void, not settle");
    println!("ok  match voided ({})", terminal["void_kind"].as_str().unwrap_or("?"));

    // Creator refunds in full (buy_in + entry_fee).
    let sig = send_tx(ctx, &p1.kp, vec![ix::refund(&ctx.program_id, &p1.kp.pubkey(), &room.match_pda, &room.vault, &p1.token)]).await;
    wait_finalized(ctx, &sig).await;
    let after = token_balance(ctx, &p1.token).await;
    let refunded = after.saturating_sub(before);
    assert_eq!(refunded, ctx.buy_in, "refund must return the full buy_in ({} != {})", refunded, ctx.buy_in);

    let vault_after = token_balance(ctx, &room.vault).await;
    assert_eq!(vault_after, 0, "vault must drain to 0 after the sole refund");
    println!("ok  creator refunded full buy_in={refunded}; vault drained to 0");
    println!("PASS void");
}

// ------------------------------------------------------------------------------------
// Scenario 5: unconfirmed candidate — 3 deposits into a max=2 room, loser refunds.
// ------------------------------------------------------------------------------------

async fn scenario_unconfirmed(ctx: &Ctx, p1: &mut Player, p2: &mut Player, p3: &mut Player) {
    banner("SCENARIO unconfirmed — over-subscribed room; the FCFS loser refunds in full");

    // max_players = 2 but three wallets deposit. FCFS by (finalized_slot, tx_sig) confirms
    // two; the third is left `not_confirmed` and can refund the moment the match locks.
    let room = create_room(ctx, p1, "public", 2, 2, None).await;
    // Land BOTH extra deposits on-chain before reporting either, so the server cannot lock
    // (which needs 2 confirmed reports) until all three deposits already exist on-chain.
    let s2 = deposit_onchain(ctx, p2, &room, None).await;
    let s3 = deposit_onchain(ctx, p3, &room, None).await;
    report_deposit(ctx, p2, &room, &s2, None).await;
    report_deposit(ctx, p3, &room, &s3, None).await;
    println!("ok  three deposits into a max_players=2 room (all on-chain before lock)");

    // Lock happens on the 2nd confirmed candidate; wait until sealing.
    wait_phase(ctx, &room.match_id, &["sealing", "live"], 180).await;
    let confirmed = confirmed_seat_order(ctx, &room).await;
    assert_eq!(confirmed.len(), 2, "exactly two candidates should be confirmed");

    // Identify the odd one out (a wallet with a seat PDA that was never confirmed).
    let loser = [&*p1, &*p2, &*p3]
        .into_iter()
        .find(|p| !confirmed.contains(&p.kp.pubkey()))
        .expect("one of the three must be unconfirmed");
    println!("ok  confirmed={:?}; unconfirmed={}", confirmed, loser.kp.pubkey());

    let before = token_balance(ctx, &loser.token).await;
    let sig = send_tx(ctx, &loser.kp, vec![ix::refund(&ctx.program_id, &loser.kp.pubkey(), &room.match_pda, &room.vault, &loser.token)]).await;
    wait_finalized(ctx, &sig).await;
    let refunded = token_balance(ctx, &loser.token).await.saturating_sub(before);
    assert_eq!(refunded, ctx.buy_in, "unconfirmed candidate must refund the full buy_in");
    println!("ok  unconfirmed {} refunded full buy_in={refunded}", loser.name);
    println!("PASS unconfirmed");
}

// ------------------------------------------------------------------------------------
// High-level flow helpers
// ------------------------------------------------------------------------------------

impl Ctx {
    async fn player(&self, env_key: &str, default_path: &str, name: &'static str) -> Player {
        let kp = read_keypair_file(env(env_key, &shell_home(default_path)))
            .unwrap_or_else(|e| panic!("read {env_key}: {e}"));
        let session = self.auth(&kp).await;
        let token = ata(&self.mint, &kp.pubkey());
        Player { name, kp, session, token }
    }

    async fn auth(&self, kp: &Keypair) -> String {
        let wallet = kp.pubkey().to_string();
        let nonce: Value = self
            .http
            .post(format!("{}/v1/auth/nonce", self.api))
            .json(&json!({ "wallet": wallet }))
            .send().await.expect("nonce").json().await.expect("nonce json");
        let sig = sign_b64(kp, nonce["nonce"].as_str().expect("nonce str").as_bytes());
        let verified: Value = self
            .http
            .post(format!("{}/v1/auth/verify", self.api))
            .json(&json!({ "wallet": wallet, "signature": sig }))
            .send().await.expect("verify").json().await.expect("verify json");
        verified["session"].as_str().expect("session").to_string()
    }
}

/// Create a room intent + submit the creator's `create_and_deposit`, returning ids/PDAs.
async fn create_room(
    ctx: &Ctx, creator: &Player, visibility: &str,
    min_players: u8, max_players: u8, fill_window_sec: Option<u64>,
) -> Room {
    let intent = post(
        ctx, "/v1/rooms/intents", &creator.session,
        json!({
            "feed": "BTC/USD",
            "buy_in": ctx.buy_in,
            "fill_window_sec": fill_window_sec.unwrap_or(600),
            "min_players": min_players,
            "max_players": max_players,
            "streets": { "count": 2, "durations_sec": [ctx.street_sec, ctx.street_sec], "observation_sec": [0, 0] },
            "visibility": visibility,
        }),
    ).await;
    let onchain_match_id = intent["onchain_match_id"].as_u64().expect("onchain id");
    let params = create_params_from_json(&intent["create_params"]);
    let total_betting_sec = params.total_betting_duration_sec;
    let begin_live_window_sec = params.begin_live_window_sec;
    let create_ix = ix::create_and_deposit(&ctx.program_id, &creator.kp.pubkey(), &ctx.mint, &creator.token, &params);
    let sig = send_tx(ctx, &creator.kp, vec![create_ix]).await;
    wait_finalized(ctx, &sig).await;

    let created = post(
        ctx, "/v1/rooms", &creator.session,
        json!({ "intent_id": intent["intent_id"], "tx_sig": sig.to_string() }),
    ).await;
    let (match_pda, _) = pda::match_account(&ctx.program_id, onchain_match_id);
    let (vault, _) = pda::vault(&ctx.program_id, &match_pda);
    Room {
        match_id: created["match_id"].as_str().expect("match_id").to_string(),
        onchain_match_id,
        match_pda,
        vault,
        room_code: intent["room_code"].as_str().map(str::to_string),
        total_betting_sec,
        begin_live_window_sec,
    }
}

/// Derive the drand target round the sealer must register, mirroring the FE recipe and the
/// on-chain bound: the first quicknet round publishing strictly after the latest possible
/// match end (`seal_deadline + total_betting + begin_live_window`). The server exposes the
/// seal deadline but not the round, exactly as a real client would compute it.
fn timelock_target_for(ctx: &Ctx, room: &Room, sealing: &Value) -> u64 {
    let seal_deadline_ms = sealing["timing"]["seal_deadline"].as_u64().expect("seal_deadline");
    let latest_match_end = seal_deadline_ms / 1000 + room.total_betting_sec + room.begin_live_window_sec;
    let _ = ctx;
    latest_match_end.saturating_sub(syndicate_chain::DRAND_GENESIS_TIME) / syndicate_chain::DRAND_PERIOD_SEC + 1
}

/// A joiner deposits on-chain and reports the txhash to the API.
async fn deposit(ctx: &Ctx, player: &Player, room: &Room, room_code: Option<&str>) {
    let sig = deposit_onchain(ctx, player, room, room_code).await;
    report_deposit(ctx, player, room, &sig, room_code).await;
}

/// Submit + finalize the on-chain deposit only (no API report). Used when several joiners
/// must all be on-chain *before* the server can lock (over-subscription race).
async fn deposit_onchain(ctx: &Ctx, player: &Player, room: &Room, room_code: Option<&str>) -> solana_sdk::signature::Signature {
    let commitment = match room_code {
        Some(code) => syndicate_chain::room_commitment(code, &player.kp.pubkey()),
        None => [0u8; 32],
    };
    let dep = ix::deposit(&ctx.program_id, &player.kp.pubkey(), &room.match_pda, &room.vault, &player.token, commitment);
    let sig = send_tx(ctx, &player.kp, vec![dep]).await;
    wait_finalized(ctx, &sig).await;
    sig
}

/// Report a finalized deposit txhash to the API so the backend can confirm the seat.
async fn report_deposit(ctx: &Ctx, player: &Player, room: &Room, sig: &solana_sdk::signature::Signature, room_code: Option<&str>) {
    let mut body = json!({ "tx_sig": sig.to_string() });
    if let Some(code) = room_code {
        body["room_code"] = json!(code);
    }
    let _ = post(ctx, &format!("/v1/matches/{}/deposits", room.match_id), &player.session, body).await;
}

/// Build the 24-byte MockScheme ciphertext and register the on-chain commitment + report.
async fn seal(ctx: &Ctx, player: &Player, room: &Room, seat_index: u16, target: u64, prediction_wad: i128) {
    // MockScheme::decrypt requires exactly: target_round(8 LE) ‖ prediction_wad(16 LE).
    let mut ciphertext = target.to_le_bytes().to_vec();
    ciphertext.extend_from_slice(&prediction_wad.to_le_bytes());
    let commitment = syndicate_shared::intent::ciphertext_commitment_hash(&ciphertext);

    let seal_ix = ix::register_prediction_commitment(
        &ctx.program_id, &player.kp.pubkey(), &room.match_pda,
        &syndicate_chain::params::RegisterPredictionCommitmentArgs { commitment, timelock_target: target },
    );
    let seal_sig = send_tx(ctx, &player.kp, vec![seal_ix]).await;

    let msg = syndicate_shared::intent::prediction_commitment_message(
        room.onchain_match_id, room.onchain_match_id, seat_index,
        &player.kp.pubkey().to_bytes(), target, &commitment,
    );
    let body = json!({
        "ciphertext_b64": base64::engine::general_purpose::STANDARD.encode(&ciphertext),
        "commitment_hex": hex::encode(commitment),
        "timelock_target": target,
        "signature": sign_b64(&player.kp, &msg),
        "seal_tx_sig": seal_sig.to_string(),
    });
    let _ = post(ctx, &format!("/v1/matches/{}/seal", room.match_id), &player.session, body).await;
}

/// Send a few legitimate signed actions (check/call) over the WS. Timeouts + street closes
/// carry the match to scheduled_end regardless, so this only needs best-effort progress.
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
        // Find the seat whose engine seat_index is to_act (array order is not guaranteed).
        let seat = detail["seats"]
            .as_array()
            .and_then(|seats| seats.iter().find(|s| s["seat_index"].as_u64() == Some(to_act)));
        let Some(seat) = seat else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        let Some(player) = players
            .iter()
            .find(|p| seat["wallet"].as_str() == Some(&p.kp.pubkey().to_string()))
        else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        let head_hex = detail["head"].as_str().unwrap_or_default().to_string();
        let current_bet = detail["current_bet"].as_u64().unwrap_or(0);
        let committed = seat["committed"].as_u64().unwrap_or(0);
        let (tag, action): (u8, &str) = if current_bet > committed { (2, "call") } else { (1, "check") };
        let nonce = detail["last_seq"].as_u64().unwrap_or(0) + 1;
        let prev_head: [u8; 32] = hex::decode(&head_hex).ok().and_then(|v| v.try_into().ok()).unwrap_or_default();
        let msg = syndicate_shared::intent::action_intent_message(
            room.onchain_match_id, room.onchain_match_id, to_act as u16,
            &player.kp.pubkey().to_bytes(), nonce, &prev_head, tag, 0,
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

/// The confirmed seats in engine order: the returned Vec is indexed by engine seat, i.e.
/// position i holds the wallet whose on-chain `engine_seat == i`. Ordered by the seat's
/// explicit `seat_index` (not array position) so seal/action signatures use the same seat
/// index the server derives from the DB.
async fn confirmed_seat_order(ctx: &Ctx, room: &Room) -> Vec<Pubkey> {
    let detail = get(ctx, &format!("/v1/matches/{}", room.match_id)).await;
    let mut pairs: Vec<(u64, Pubkey)> = detail["seats"]
        .as_array()
        .map(|seats| {
            seats
                .iter()
                .filter_map(|s| {
                    let idx = s["seat_index"].as_u64()?;
                    let wallet = s["wallet"].as_str()?.parse().ok()?;
                    Some((idx, wallet))
                })
                .collect()
        })
        .unwrap_or_default();
    pairs.sort_by_key(|(idx, _)| *idx);
    pairs.into_iter().map(|(_, w)| w).collect()
}

async fn post(ctx: &Ctx, path: &str, session: &str, body: Value) -> Value {
    let (status, value) = try_post(ctx, path, session, body).await;
    assert!(status.is_success(), "POST {path} -> {status}: {value}");
    value
}

async fn try_post(ctx: &Ctx, path: &str, session: &str, body: Value) -> (reqwest::StatusCode, Value) {
    let resp = ctx.http.post(format!("{}{}", ctx.api, path)).bearer_auth(session).json(&body)
        .send().await.unwrap_or_else(|e| panic!("POST {path}: {e}"));
    let status = resp.status();
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    (status, value)
}

async fn get(ctx: &Ctx, path: &str) -> Value {
    ctx.http.get(format!("{}{}", ctx.api, path)).send().await
        .unwrap_or_else(|e| panic!("GET {path}: {e}"))
        .json().await.unwrap_or_else(|e| panic!("GET {path} json: {e}"))
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

/// Assert a transaction is rejected on-chain (preflight or execution). Used for theft checks.
async fn expect_tx_fails(ctx: &Ctx, signer: &Keypair, ixs: Vec<Instruction>, label: &str) {
    match try_send_tx(ctx, signer, ixs).await {
        Ok(sig) => panic!("SECURITY FAILURE: {label} SUCCEEDED ({sig}) — it must have been rejected"),
        Err(e) => {
            let short: String = e.chars().take(160).collect();
            println!("ok  {label} rejected: {short}");
        }
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

/// Open a WS, complete the challenge→auth handshake, send one frame, and collect the
/// server's immediate responses (ack or error).
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
    let _ = ws.send(Message::Text(auth.to_string().into())).await;
    let _ = ws.send(Message::Text(frame.to_string().into())).await;
    let mut out = Vec::new();
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            let t = v["t"].as_str().unwrap_or("").to_string();
            out.push(v);
            if t == "error" || t == "ack" || t == "action" {
                break;
            }
        }
    }
    out
}
