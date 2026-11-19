//! House table — bots that keep one public table open around the clock.
//!
//! `E2E_MODE=house` turns the driver into a long-running service. The lead bot opens a
//! public table; the other bots sit down the moment a person does. When the table locks,
//! the hand is played in the background exactly as a real client would play it (same REST
//! + WS + on-chain path the suite exercises) and the next table opens straight away. A
//! visitor therefore always finds an open table to sit at, hand in progress or not.
//!
//! The bots hold no privileged access: they are ordinary wallets with ordinary sessions,
//! they seal before the lock like everyone else, and they never see another seat's call.
//! Their wallets are published in `/v1/config.house_bot_wallets` so the UI can label them.
//!
//! Env (on top of the suite's GAME_SERVER_URL / SOLANA_RPC_URL / CHIPS_TOKEN_MINT /
//! BUY_IN / STREET_SEC / ROUND_COUNT / OBSERVATION_SEC / E2E_SEAL_MODE):
//!   HOUSE_BOT_KEYPAIRS          CSV of keypair files, 2–5 bots (required)
//!   HOUSE_BOT_HANDLES           CSV of profile handles (default House_Bot_1, …)
//!   HOUSE_FILL_SEC              how long an empty table stays open before it is replaced
//!                               (default 600)
//!   HOUSE_HUMAN_SEATS           seats left for people (default 1). The table locks the
//!                               moment it is full, so with one seat a visitor who sits
//!                               down is playing within seconds instead of waiting out
//!                               the fill window
//!   HOUSE_PLAY_WITHOUT_HUMANS   true (default): when nobody sits, the bots play a showcase
//!                               hand against each other — one at a time — so there is
//!                               live action to watch; false: an empty table just voids
//!                               and refunds, so the house pays no rake to stay open
//!   HOUSE_PAUSE_SEC             gap between tables (default 5)
//!   HOUSE_EVENT_EVERY_SEC       a scheduled table deals on every such wall-clock mark
//!                               (default 600 = :00, :10, :20…; 0 = none)
//!   HOUSE_EVENT_HANDLE          handle of the bot hosting them (default Main_Event)
//!   PRICE_URL                   signed-price-server base URL; without it bots ride spot

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;

const NAMES: [&str; 5] = ["BOT1", "BOT2", "BOT3", "BOT4", "BOT5"];

struct House {
    /// Seconds between scheduled tables (0 = none).
    event_every_sec: u64,
    fill_sec: u64,
    max_players: u8,
    play_without_humans: bool,
    pause_sec: u64,
    price_url: Option<String>,
    handles: Vec<String>,
}

/// Small xorshift — bot behaviour only needs to look varied, not be unpredictable.
struct Rng(u64);
impl Rng {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15);
        Rng(seed | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

pub async fn run(ctx: Ctx) {
    let paths: Vec<String> = env("HOUSE_BOT_KEYPAIRS", "")
        .split(',')
        .map(|s| shell_home(s.trim()))
        .filter(|s| !s.is_empty())
        .collect();
    assert!(
        (2..=NAMES.len()).contains(&paths.len()),
        "HOUSE_BOT_KEYPAIRS must list 2–{} keypair files",
        NAMES.len()
    );
    let keys: Vec<Keypair> = paths
        .iter()
        .map(|p| read_keypair_file(p).unwrap_or_else(|e| panic!("read bot keypair {p}: {e}")))
        .collect();
    let handles: Vec<String> = {
        let given: Vec<String> = env("HOUSE_BOT_HANDLES", "")
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        (0..keys.len())
            .map(|i| {
                given
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| format!("House_Bot_{}", i + 1))
            })
            .collect()
    };
    let event_every_sec: u64 = env("HOUSE_EVENT_EVERY_SEC", "600")
        .parse()
        .expect("HOUSE_EVENT_EVERY_SEC");
    let event_handle = env("HOUSE_EVENT_HANDLE", "Main_Event");
    // The last bot hosts the scheduled tables; its handle is how the lobby tells them apart.
    let mut handles = handles;
    if event_every_sec > 0 {
        if let Some(last) = handles.last_mut() {
            *last = event_handle.clone();
        }
    }
    let house = House {
        event_every_sec,
        fill_sec: env("HOUSE_FILL_SEC", "600")
            .parse()
            .expect("HOUSE_FILL_SEC"),
        max_players: keys.len() as u8
            + env("HOUSE_HUMAN_SEATS", "1")
                .parse::<u8>()
                .expect("HOUSE_HUMAN_SEATS")
                .max(1),
        play_without_humans: env("HOUSE_PLAY_WITHOUT_HUMANS", "true") != "false",
        pause_sec: env("HOUSE_PAUSE_SEC", "5")
            .parse()
            .expect("HOUSE_PAUSE_SEC"),
        price_url: std::env::var("PRICE_URL").ok().filter(|s| !s.is_empty()),
        handles,
    };
    println!("== house table ==");
    println!(
        "   api={}  mint={}  buy_in={}",
        ctx.api, ctx.mint, ctx.buy_in
    );
    for (i, k) in keys.iter().enumerate() {
        println!("   {} = {} ({})", NAMES[i], k.pubkey(), house.handles[i]);
    }
    println!(
        "   HOUSE_BOT_WALLETS={}",
        keys.iter()
            .map(|k| k.pubkey().to_string())
            .collect::<Vec<_>>()
            .join(",")
    );

    let ctx = Arc::new(ctx);
    let keys = Arc::new(keys);
    let house = Arc::new(house);
    let running = Arc::new(AtomicUsize::new(0));

    // After a restart: collect what earlier tables owe the bots, and pick up any table
    // that has not ended yet.
    loop {
        let boot = tokio::spawn(recover(
            ctx.clone(),
            keys.clone(),
            house.clone(),
            running.clone(),
        ));
        match boot.await {
            Ok(()) => break,
            Err(e) => {
                println!("house: recovery failed ({e}); retrying in 15s");
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        }
    }

    // Scheduled tables run beside the always-open one: same bots, their own loop.
    if house.event_every_sec > 0 {
        let (ctx, keys, house, running) =
            (ctx.clone(), keys.clone(), house.clone(), running.clone());
        tokio::spawn(async move {
            loop {
                let task = tokio::spawn(event_table(
                    ctx.clone(),
                    keys.clone(),
                    house.clone(),
                    running.clone(),
                ));
                if let Err(e) = task.await {
                    println!("house: scheduled table failed ({e}); retrying in 30s");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        });
    }

    // Tables people deal themselves never sit empty: a bot or two takes the open seats.
    {
        let (ctx, keys, house, running) =
            (ctx.clone(), keys.clone(), house.clone(), running.clone());
        tokio::spawn(async move {
            loop {
                let task = tokio::spawn(guest_tables(
                    ctx.clone(),
                    keys.clone(),
                    house.clone(),
                    running.clone(),
                ));
                if let Err(e) = task.await {
                    println!("house: filling a player's table failed ({e}); retrying in 20s");
                }
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
        });
    }

    let mut failures: u32 = 0;
    loop {
        // One table per task: every helper below panics on an unexpected response, and a
        // panic must cost one table, never the service.
        let task = tokio::spawn(table(
            ctx.clone(),
            keys.clone(),
            house.clone(),
            running.clone(),
        ));
        match task.await {
            Ok(()) => {
                failures = 0;
                tokio::time::sleep(Duration::from_secs(house.pause_sec)).await;
            }
            Err(e) => {
                failures += 1;
                let backoff = (10 * failures as u64).min(120);
                println!("house: table failed ({e}); retrying in {backoff}s");
                tokio::time::sleep(Duration::from_secs(backoff)).await;
            }
        }
    }
}

/// Sessions last 24h on the server; the bots share one per wallet for an hour and sign
/// in again after that. Sign-ins are serialized because the server keeps a single pending
/// nonce per wallet — two tables signing the same bot in at once would cancel each other.
static SESSIONS: tokio::sync::Mutex<Vec<(Pubkey, String, std::time::Instant)>> =
    tokio::sync::Mutex::const_new(Vec::new());
const SESSION_REUSE: Duration = Duration::from_secs(3600);

async fn login(ctx: &Ctx, keys: &[Keypair]) -> Vec<Player> {
    let mut cache = SESSIONS.lock().await;
    cache.retain(|(_, _, at)| at.elapsed() < SESSION_REUSE);
    let mut bots = Vec::with_capacity(keys.len());
    for (i, k) in keys.iter().enumerate() {
        let kp = k.insecure_clone();
        let session = match cache.iter().find(|(w, _, _)| *w == kp.pubkey()) {
            Some((_, session, _)) => session.clone(),
            None => {
                let session = ctx.auth(&kp).await;
                cache.push((kp.pubkey(), session.clone(), std::time::Instant::now()));
                session
            }
        };
        bots.push(Player {
            name: NAMES[i],
            kp,
            session,
        });
    }
    bots
}

async fn recover(
    ctx: Arc<Ctx>,
    keys: Arc<Vec<Keypair>>,
    house: Arc<House>,
    running: Arc<AtomicUsize>,
) {
    let bots = login(&ctx, &keys).await;
    for (bot, handle) in bots.iter().zip(&house.handles) {
        set_handle(&ctx, bot, handle).await;
    }
    for bot in &bots {
        sweep(&ctx, bot).await;
    }
    let active = get(&ctx, &format!("/v1/wallets/{}/active", bots[0].pubkey())).await;
    for row in active["active"].as_array().cloned().unwrap_or_default() {
        if matches!(row["phase"].as_str(), Some("settled" | "voided") | None) {
            continue;
        }
        let Some(match_id) = row["match_id"].as_str() else {
            continue;
        };
        let Some(room) = room_by_id(&ctx, match_id).await else {
            continue;
        };
        println!("house: resuming table {}", room.match_id);
        spawn_play(
            ctx.clone(),
            keys.clone(),
            house.clone(),
            running.clone(),
            room,
        );
    }
}

/// Open one table and stay with it while it fills; once it locks, the hand is played in
/// the background and the caller opens the next table. So the lobby always has a table to
/// sit at, even while a hand is in progress.
async fn table(
    ctx: Arc<Ctx>,
    keys: Arc<Vec<Keypair>>,
    house: Arc<House>,
    running: Arc<AtomicUsize>,
) {
    let bots = login(&ctx, &keys).await;
    if !funded(&ctx, &bots).await {
        tokio::time::sleep(Duration::from_secs(30)).await;
        return;
    }
    let room = open(&ctx, &bots, &house).await;
    fill(&ctx, &room, &bots, &house, &running).await;
    spawn_play(
        ctx.clone(),
        keys.clone(),
        house.clone(),
        running.clone(),
        room,
    );
}

/// A scheduled table: opens now, deals on the next round wall-clock mark (:00, :10, :20…
/// for the default ten minutes), so everyone who wants a game with other people knows when
/// to be there. The host bot holds a seat from the start; near the deal the other bots
/// fill in around whoever came, so the table is never short-handed. If nobody came, the
/// bots play it as a showcase only when no other house hand is running.
async fn event_table(
    ctx: Arc<Ctx>,
    keys: Arc<Vec<Keypair>>,
    house: Arc<House>,
    running: Arc<AtomicUsize>,
) {
    let bots = login(&ctx, &keys).await;
    let host = bots.last().expect("at least two bots");
    if !funded(&ctx, &bots).await {
        tokio::time::sleep(Duration::from_secs(60)).await;
        return;
    }
    let every = house.event_every_sec;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut deal_at = (now / every + 1) * every;
    if deal_at - now < 150 {
        deal_at += every; // too close to gather anyone: aim for the mark after
    }
    let cap = get(&ctx, "/v1/config").await["bounds"]["players"]["max"]
        .as_u64()
        .unwrap_or(5) as u8;
    let room = create_room(&ctx, host, "public", 2, cap, Some(deal_at - now)).await;
    println!(
        "house: scheduled table {} (#{}) deals in {}s",
        room.match_id,
        room.onchain_match_id,
        deal_at - now
    );

    let mut filled = false;
    loop {
        let lobby = get(&ctx, "/v1/lobby").await;
        let Some(row) = lobby["rooms"].as_array().and_then(|rooms| {
            rooms
                .iter()
                .find(|r| r["match_id"].as_str() == Some(&room.match_id))
                .cloned()
        }) else {
            break; // left the lobby: dealt or voided
        };
        let present = (row["confirmed"].as_u64().unwrap_or(0)
            + row["candidates"].as_u64().unwrap_or(0)) as usize;
        let left_ms = row["fill_deadline"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(lobby["server_time_ms"].as_u64().unwrap_or(0));
        if !filled && left_ms < 45_000 && left_ms > 20_000 {
            filled = true;
            let people = present.saturating_sub(1);
            let free = (cap as usize).saturating_sub(present);
            let others = &bots[..bots.len() - 1];
            let seat = if people >= 1 {
                others.len().min(free)
            } else if house.play_without_humans && running.load(Ordering::SeqCst) == 0 {
                1
            } else {
                0
            };
            println!("house: scheduled table — {people} player(s) came, seating {seat} bot(s)");
            let ctx = &*ctx;
            let room = &room;
            futures_util::future::join_all(others[..seat].iter().map(|bot| async move {
                let handle = discover_public(ctx, room.onchain_match_id).await;
                deposit_and_confirm(ctx, bot, &handle).await;
            }))
            .await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    spawn_play(
        ctx.clone(),
        keys.clone(),
        house.clone(),
        running.clone(),
        room,
    );
}

/// Play a table to its end in the background, then collect.
/// Watch the lobby for tables dealt by people. One that is about to close short of
/// players — or whose host has sat alone for a minute — gets up to two bots, so "deal a
/// table" always turns into a hand. Bots never crowd out people: they take only seats
/// still empty at that point, and only at stakes the house is funded for.
async fn guest_tables(
    ctx: Arc<Ctx>,
    keys: Arc<Vec<Keypair>>,
    house: Arc<House>,
    running: Arc<AtomicUsize>,
) {
    let bots = login(&ctx, &keys).await;
    let ours: Vec<String> = bots.iter().map(|b| b.pubkey().to_string()).collect();
    let mut joined: HashSet<String> = HashSet::new();
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let lobby = get(&ctx, "/v1/lobby").await;
        let now = lobby["server_time_ms"].as_u64().unwrap_or(0);
        let Some(rooms) = lobby["rooms"].as_array() else {
            continue;
        };
        for row in rooms {
            let Some(match_id) = row["match_id"].as_str() else {
                continue;
            };
            let creator = row["creator_wallet"].as_str().unwrap_or("");
            if joined.contains(match_id) || ours.iter().any(|w| w == creator) {
                continue;
            }
            let present = (row["confirmed"].as_u64().unwrap_or(0)
                + row["candidates"].as_u64().unwrap_or(0)) as usize;
            let max = row["max_players"].as_u64().unwrap_or(0) as usize;
            let left_ms = row["fill_deadline"].as_u64().unwrap_or(0).saturating_sub(now);
            let age_ms = now.saturating_sub(row["created_at"].as_u64().unwrap_or(now));
            let closing = left_ms < 15_000;
            let lonely = present <= 1 && age_ms > 60_000;
            let affordable = row["buy_in"].as_u64().unwrap_or(u64::MAX) <= ctx.buy_in * 10;
            if present == 0 || present >= max || left_ms < 5_000 || !(closing || lonely) || !affordable {
                continue;
            }
            joined.insert(match_id.to_string());
            let Some(onchain) = row["onchain_match_id"].as_u64() else {
                continue;
            };
            let seats = (max - present).min(2).min(bots.len().saturating_sub(1));
            println!("house: a player's table {match_id} is short — seating {seats} bot(s)");
            let room = discover_public(&ctx, onchain).await;
            futures_util::future::join_all(bots[1..=seats].iter().map(|bot| {
                let (ctx, room) = (ctx.clone(), room.clone());
                async move { deposit_and_confirm(&ctx, bot, &room).await }
            }))
            .await;
            spawn_play(ctx.clone(), keys.clone(), house.clone(), running.clone(), room);
        }
    }
}

fn spawn_play(
    ctx: Arc<Ctx>,
    keys: Arc<Vec<Keypair>>,
    house: Arc<House>,
    running: Arc<AtomicUsize>,
    room: Room,
) {
    tokio::spawn(async move {
        running.fetch_add(1, Ordering::SeqCst);
        // A table the bots are seated at is never abandoned on one bad response: pick it
        // back up from the server's state, a few times, before giving up on it.
        for attempt in 1..=5u64 {
            let (ctx, keys, house, seat) = (ctx.clone(), keys.clone(), house.clone(), room.clone());
            let inner = tokio::spawn(async move {
                let bots = login(&ctx, &keys).await;
                let phase = play(&ctx, &seat, &bots, &house).await;
                for bot in &bots {
                    collect_room(&ctx, bot, &seat, &phase).await;
                }
                // The bots are on the daily board like anyone else (20 Fibs a hand).
                if phase == "settled" {
                    for bot in &bots {
                        let _ = ctx
                            .http
                            .post(format!("{}/v1/fibs", ctx.api))
                            .bearer_auth(&bot.session)
                            .json(&json!({ "amount": 20 }))
                            .send()
                            .await;
                    }
                }
            });
            match inner.await {
                Ok(()) => break,
                Err(e) => {
                    println!(
                        "house: table {} interrupted ({e}); attempt {attempt}/5",
                        room.match_id
                    );
                    tokio::time::sleep(Duration::from_secs(5 * attempt)).await;
                }
            }
        }
        running.fetch_sub(1, Ordering::SeqCst);
    });
}

/// Bots carry a handle so the lobby reads "dealt by House_Bot_1". Best effort: a taken
/// handle or a rate limit must not stop the table.
async fn set_handle(ctx: &Ctx, bot: &Player, handle: &str) {
    let current = get_status(ctx, &format!("/v1/profiles/{}", bot.pubkey()))
        .await
        .1;
    if current["handle"].as_str() == Some(handle) {
        return;
    }
    let res = ctx
        .http
        .put(format!("{}/v1/profiles/me", ctx.api))
        .bearer_auth(&bot.session)
        .json(&json!({ "handle": handle }))
        .send()
        .await;
    if let Ok(r) = res {
        if !r.status().is_success() {
            println!(
                "house: handle {handle} not set for {} ({})",
                bot.name,
                r.status()
            );
        }
    }
}

/// One-off at startup: claim every payout and refund the server lists for this bot. The
/// list includes payouts that were already claimed, so it is not polled per table.
async fn sweep(ctx: &Ctx, bot: &Player) {
    let cl = get(ctx, &format!("/v1/wallets/{}/claimables", bot.pubkey())).await;
    for c in cl["claimables"].as_array().cloned().unwrap_or_default() {
        let Some(onchain) = c["onchain_match_id"].as_u64() else {
            continue;
        };
        take(ctx, bot, onchain, c["kind"] == json!("refund")).await;
    }
}

/// Collect this bot's payout (settled) or refund (voided) from the table it just played.
async fn collect_room(ctx: &Ctx, bot: &Player, room: &Room, phase: &str) {
    take(ctx, bot, room.onchain_match_id, phase == "voided").await;
}

async fn take(ctx: &Ctx, bot: &Player, onchain: u64, refund: bool) {
    let token = bot.ata(&ctx.mint);
    let (match_pda, _) = pda::match_account(&ctx.program_id, onchain);
    let (vault, _) = pda::vault(&ctx.program_id, &match_pda);
    let before = token_balance(ctx, &token).await;
    let ix = if refund {
        ix::refund(&ctx.program_id, &bot.pubkey(), &match_pda, &vault, &token)
    } else {
        ix::claim(&ctx.program_id, &bot.pubkey(), &match_pda, &vault, &token)
    };
    match try_send_tx(ctx, &bot.kp, vec![ix]).await {
        Ok(_) => {
            let delta = token_balance(ctx, &token).await.saturating_sub(before);
            println!(
                "house: {} collected {delta} ({} #{onchain})",
                bot.name,
                if refund { "refund" } else { "payout" }
            );
        }
        Err(e) => {
            // 0xbc4 = the seat account is already closed (collected earlier) or the bot
            // never sat at this table; a zero payout also has nothing to claim.
            let expected =
                e.contains("0xbc4") || e.contains("AlreadyClaimed") || e.contains("NothingToClaim");
            if !expected {
                println!(
                    "house: {} collect #{onchain} skipped: {}",
                    bot.name,
                    e.chars().take(120).collect::<String>()
                );
            }
        }
    }
}

/// Every bot needs a buy-in of chips and SOL for fees before a table opens.
async fn funded(ctx: &Ctx, bots: &[Player]) -> bool {
    let mut ok = true;
    for bot in bots {
        let chips = token_balance(ctx, &bot.ata(&ctx.mint)).await;
        let lamports = ctx.rpc.get_balance(&bot.pubkey()).await.unwrap_or(0);
        if chips < ctx.buy_in {
            println!(
                "house: {} ({}) is short of chips: has {chips}, buy-in {} — top it up",
                bot.name,
                bot.pubkey(),
                ctx.buy_in
            );
            ok = false;
        }
        if lamports < 20_000_000 {
            println!(
                "house: {} ({}) is short of SOL: {lamports} lamports — top it up",
                bot.name,
                bot.pubkey()
            );
            ok = false;
        }
    }
    ok
}

async fn room_by_id(ctx: &Ctx, match_id: &str) -> Option<Room> {
    let detail = get(ctx, &format!("/v1/matches/{match_id}")).await;
    let onchain = detail["onchain_match_id"].as_u64()?;
    let buy_in = detail["params"]["buy_in"].as_u64().unwrap_or(ctx.buy_in);
    let mint: Pubkey = detail["params"]["chips_token_mint"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(ctx.mint);
    Some(room_from_detail(
        ctx, match_id, onchain, buy_in, mint, None, [0u8; 32], &detail,
    ))
}

/// The lead bot opens a public table and the others sit down.
async fn open(ctx: &Ctx, bots: &[Player], house: &House) -> Room {
    // Quorum is two: the lead bot plus anyone — a person or, for a showcase, another bot.
    let min_players = 2;
    // Never ask for more seats than the server allows.
    let cap = get(ctx, "/v1/config").await["bounds"]["players"]["max"]
        .as_u64()
        .unwrap_or(house.max_players as u64) as u8;
    let max_players = house.max_players.min(cap);
    assert!(
        min_players <= max_players,
        "the server caps tables at {cap} seats — too few for the bots plus a person"
    );
    let room = create_room(
        ctx,
        &bots[0],
        "public",
        min_players,
        max_players,
        Some(house.fill_sec),
    )
    .await;
    println!(
        "house: opened table {} (#{}) — fills for {}s",
        room.match_id, room.onchain_match_id, house.fill_sec
    );
    room
}

/// Stay with a filling table. The lead bot is already seated; the others sit down as soon
/// as a person does, so nobody waits alone. If nobody comes, the others still sit near the
/// deadline to play a showcase hand — but only when no other house hand is running and
/// `HOUSE_PLAY_WITHOUT_HUMANS` allows it. Otherwise the table voids, the lead is refunded,
/// and the next one opens.
async fn fill(ctx: &Ctx, room: &Room, bots: &[Player], house: &House, running: &AtomicUsize) {
    let opened = std::time::Instant::now();
    let mut seated = 1usize;
    let all_in = |seated: usize| seated >= bots.len();
    loop {
        let lobby = get(ctx, "/v1/lobby").await;
        let Some(row) = lobby["rooms"].as_array().and_then(|rooms| {
            rooms
                .iter()
                .find(|r| r["match_id"].as_str() == Some(&room.match_id))
                .cloned()
        }) else {
            return; // left the lobby: locked or voided
        };
        let present = (row["confirmed"].as_u64().unwrap_or(0)
            + row["candidates"].as_u64().unwrap_or(0)) as usize;
        let now = lobby["server_time_ms"].as_u64().unwrap_or(0);
        let left_ms = row["fill_deadline"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(now);
        let person_here = present > seated;
        let showcase =
            house.play_without_humans && running.load(Ordering::SeqCst) == 0 && left_ms < 45_000;
        // Leave a deposit time to land; past that point sitting down would only strand it.
        if !all_in(seated) && (person_here || showcase) && left_ms > 20_000 {
            let why = if person_here {
                "a player sat down"
            } else {
                "showcase hand"
            };
            println!("house: {why} — seating the rest of the bots");
            // All at once: the person who just sat down should not wait on a queue of bots.
            futures_util::future::join_all(bots[1..].iter().map(|bot| async move {
                let handle = discover_public(ctx, room.onchain_match_id).await;
                deposit_and_confirm(ctx, bot, &handle).await;
            }))
            .await;
            seated = bots.len();
        }
        if opened.elapsed() > Duration::from_secs(house.fill_sec + 180) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Drive the table from wherever it is to a terminal phase.
async fn play(ctx: &Ctx, room: &Room, bots: &[Player], house: &House) -> String {
    let mut rng = Rng::new();
    let mut seal_tried: HashSet<String> = HashSet::new();
    let mut nonces: HashMap<u16, u64> = HashMap::new();
    // What each bot sealed this hand (by seat) — its own call is all a bot knows.
    let mut calls: HashMap<u16, i128> = HashMap::new();
    let deadline = std::time::Instant::now()
        + Duration::from_secs(
            house.fill_sec + room.total_betting_sec + room.begin_live_window_sec + 900,
        );
    let mut last_phase = String::new();

    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "table {} never reached a terminal phase",
            room.match_id
        );
        let detail = get(ctx, &format!("/v1/matches/{}", room.match_id)).await;
        let phase = detail["phase"].as_str().unwrap_or_default().to_string();
        if phase != last_phase {
            let humans = detail["seats"]
                .as_array()
                .map(|seats| {
                    seats
                        .iter()
                        .filter(|s| {
                            !bots
                                .iter()
                                .any(|b| s["wallet"].as_str() == Some(&b.pubkey().to_string()))
                        })
                        .count()
                })
                .unwrap_or(0);
            println!(
                "house: table {} → {phase} ({humans} human seat(s))",
                room.match_id
            );
            last_phase = phase.clone();
        }
        match phase.as_str() {
            "settled" | "voided" => return phase,
            "sealing" => {
                for (i, bot) in bots.iter().enumerate() {
                    let wallet = bot.pubkey().to_string();
                    if seal_tried.contains(&wallet) {
                        continue;
                    }
                    seal_tried.insert(wallet.clone());
                    let Some(seat) = detail["seats"]
                        .as_array()
                        .and_then(|s| s.iter().find(|s| s["wallet"].as_str() == Some(&wallet)))
                    else {
                        continue;
                    };
                    if seat["sealed"].as_bool() == Some(true) {
                        continue;
                    }
                    let Some(seat_index) = seat["seat_index"].as_u64() else {
                        continue;
                    };
                    let Some(spot) = spot_wad(ctx, house, &detail).await else {
                        continue; // no price source: this bot rides spot
                    };
                    // Each bot has its own spread: the lead calls tight, the rest wider — all
                    // within what the market can plausibly cover in one hand, so they hold
                    // live calls worth defending instead of long shots they fold.
                    // …and each seals its own way, so they do not huddle on the market price
                    // where one outside call beats all three: the first stays tight, the
                    // second takes a side by a real margin, the third goes wide.
                    // Which bot plays which style rotates by table, so no one bot is always
                    // the one sitting on the market (and winning every showdown).
                    let turn = room.match_id.bytes().fold(0usize, |a, b| a + b as usize);
                    let (lo, hi) = [(0.0, 3.0), (4.0, 9.0), (8.0, 15.0)][(i + turn) % 3];
                    let side = if rng.unit() < 0.5 { -1.0 } else { 1.0 };
                    let drift = side * (lo + rng.unit() * (hi - lo)) / 10_000.0;
                    let call = (spot as f64 * (1.0 + drift)) as i128;
                    let target = timelock_target(room, &detail);
                    seal(ctx, bot, room, seat_index as u16, target, call).await;
                    calls.insert(seat_index as u16, call);
                    println!("house: {} sealed", bot.name);
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            "live" => {
                act_if_ours(
                    ctx,
                    room,
                    bots,
                    house,
                    &detail,
                    &calls,
                    &mut nonces,
                    &mut rng,
                )
                .await;
            }
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
}

/// Current price of the table's feed as an 18-decimal wad, from the signed price server.
async fn spot_wad(ctx: &Ctx, house: &House, detail: &Value) -> Option<i128> {
    let base = house.price_url.as_ref()?;
    let symbol = detail["feed"].as_str()?.replace('/', "");
    let body: Value = ctx
        .http
        .get(format!("{}/prices", base.trim_end_matches('/')))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let tick = body["prices"].as_array()?.iter().find(|p| {
        p["symbol"]
            .as_str()
            .map(|s| s.replace('/', "") == symbol)
            .unwrap_or(false)
    })?;
    if let Some(wad) = tick["price_in_wad"]
        .as_str()
        .and_then(|s| s.parse::<i128>().ok())
    {
        return Some(wad);
    }
    let price: f64 = tick["price"].as_str()?.parse().ok()?;
    Some((price * 1e18) as i128)
}

/// If the open turn belongs to a bot, take it. Humans' turns are left alone.
/// How a bot rates its own call: the gap to the market in typical moves (how far the price
/// usually travels in the time left). The same public arithmetic the UI shows a player.
#[derive(Clone, Copy, PartialEq)]
enum Read {
    InRange,
    NeedsMove,
    LongShot,
    /// No price source or no sealed call on record (e.g. after a restart).
    Blind,
}

#[allow(clippy::too_many_arguments)]
async fn act_if_ours(
    ctx: &Ctx,
    room: &Room,
    bots: &[Player],
    house: &House,
    detail: &Value,
    calls: &HashMap<u16, i128>,
    nonces: &mut HashMap<u16, u64>,
    rng: &mut Rng,
) {
    let idle = Duration::from_millis(600);
    let turn = detail
        .get("turn")
        .filter(|v| !v.is_null())
        .or_else(|| detail.get("open_turn").filter(|v| !v.is_null()));
    let Some(turn) = turn else {
        return tokio::time::sleep(idle).await;
    };
    let Some(to_act) = turn["seat"].as_u64() else {
        return tokio::time::sleep(idle).await;
    };
    let round = turn["round"]
        .as_u64()
        .unwrap_or_else(|| detail["round"].as_u64().unwrap_or(1));
    if let Some(wait_ms) = wait_until_betting_open_ms(detail, round) {
        return tokio::time::sleep(Duration::from_millis(wait_ms.clamp(250, 2_000))).await;
    }
    let Some(seat) = detail["seats"].as_array().and_then(|seats| {
        seats
            .iter()
            .find(|s| s["seat_index"].as_u64() == Some(to_act))
    }) else {
        return tokio::time::sleep(idle).await;
    };
    let Some(bot) = bots
        .iter()
        .find(|b| seat["wallet"].as_str() == Some(&b.pubkey().to_string()))
    else {
        return tokio::time::sleep(idle).await; // a person is thinking
    };

    // A beat before acting, so the table reads as play rather than a script — but a short
    // one: every second a bot thinks comes out of the round the person is waiting in.
    tokio::time::sleep(Duration::from_millis(rng.range(500, 1_600))).await;

    let head_hex = turn["head_hex"]
        .as_str()
        .or_else(|| detail["head"].as_str())
        .unwrap_or_default()
        .to_string();
    let to_call = turn["to_call"].as_u64().unwrap_or(0);
    let min_raise_to = turn["min_raise_to"].as_u64().unwrap_or(0);
    let current_bet = detail["current_bet"].as_u64().unwrap_or(0);
    let stack = seat["stack"].as_u64().unwrap_or(0);
    let max_total = seat["committed"].as_u64().unwrap_or(0) + stack;
    let can_raise = min_raise_to > 0 && min_raise_to <= max_total;
    let roll = rng.unit();
    let pot = detail["pot"].as_u64().unwrap_or(0);
    // Each bot has a temperament — (how often it bets, how often it calls) relative to the
    // baseline — so the table is not three copies of one player: steady, wild, careful.
    const STYLES: [(f64, f64); 3] = [(1.0, 1.0), (1.4, 1.15), (0.6, 0.8)];
    let who = bots
        .iter()
        .position(|b| b.pubkey() == bot.pubkey())
        .unwrap_or(0);
    let style = STYLES[who % STYLES.len()];
    // A mood for this hand only (fixed by table + seat), so the same bot is not the same
    // player every deal: some hands it sits back, some hands it comes out firing.
    let mood = [0.55, 1.0, 1.6][(room
        .match_id
        .bytes()
        .fold(who as u32 * 7, |a, b| a.wrapping_mul(31).wrapping_add(b as u32))
        % 3) as usize];
    let style = (style.0 * mood, style.1);

    // Read the bot's own hand: where is the market relative to what it sealed?
    let mut closeness = 0.4_f64; // how near the bot's own number is to the price (1 = on it)
    let read = match (
        calls.get(&(to_act as u16)),
        spot_wad(ctx, house, detail).await,
    ) {
        (Some(&call), Some(spot)) if spot > 0 => {
            let rounds = detail["params"]["round_count"].as_u64().unwrap_or(1).max(1);
            let left = rounds.saturating_sub(round).saturating_add(1) as f64 / rounds as f64;
            let sec_left = (room.total_betting_sec as f64 * left).max(5.0);
            // ~0.009% of price per √second — BTC-like volatility.
            let typical = spot as f64 * 0.00009 * sec_left.sqrt();
            let moves = (spot - call).abs() as f64 / typical;
            closeness = (1.0 - moves / 2.0).clamp(0.0, 1.0);
            if moves <= 0.75 {
                Read::InRange
            } else if moves <= 2.0 {
                Read::NeedsMove
            } else {
                Read::LongShot
            }
        }
        _ => Read::Blind,
    };

    use syndicate_shared::intent::{
        ACTION_TAG_BET_TO, ACTION_TAG_CALL, ACTION_TAG_CHECK, ACTION_TAG_FOLD, ACTION_TAG_RAISE_TO,
    };
    let fold = (ACTION_TAG_FOLD, 0, json!("fold"));
    let call = (ACTION_TAG_CALL, 0, json!("call"));
    let check = (ACTION_TAG_CHECK, 0, json!("check"));
    // Bets are about half the pot, never below the minimum and never beyond the stack.
    // …sized like a person would: a probe, half the pot, most of it, or all of it.
    let frac = [0.33, 0.5, 0.5, 0.75, 1.0][(rng.unit() * 5.0) as usize % 5];
    let raise_to = min_raise_to
        .max(current_bet + (pot as f64 * frac) as u64)
        .min(max_total);
    // Whole cents (chips have six decimals): no half-cent bets on the table.
    let raise_to = if raise_to < max_total { (raise_to / 10_000 * 10_000).max(min_raise_to) } else { raise_to };
    let raise = if current_bet > 0 {
        (
            ACTION_TAG_RAISE_TO,
            raise_to,
            json!({"kind": "raise_to", "amount": raise_to}),
        )
    } else {
        (
            ACTION_TAG_BET_TO,
            raise_to,
            json!({"kind": "bet_to", "amount": raise_to}),
        )
    };
    // Value-bet a live call, bluff a dead one now and then, and respect the price of a call.
    let cheap = to_call.saturating_mul(4) <= pot; // getting 4:1 or better
    let fair = to_call.saturating_mul(2) <= pot; // getting 2:1 or better
    let big = to_call > pot.saturating_sub(to_call); // more than the pot that was there
    let (tag, amount, action) = if to_call == 0 {
        let bet_freq = style.0
            * match read {
                Read::InRange => 0.80,
                Read::NeedsMove => 0.50,
                Read::LongShot => 0.22,
                Read::Blind => 0.40,
            };
        if can_raise && roll < bet_freq {
            raise
        } else {
            check
        }
    } else {
        let (raise_freq, call_freq) = match read {
            // A shove or an overbet is a different question: only a call the market is
            // close to pays it off, and even then not every time. Calling every all-in is
            // what turns each big hand into the same four-way showdown.
            // …so the answer scales with how close the bot's own number is: on the price
            // it nearly always pays the bet off, a move away it sometimes does, far away
            // almost never. A bluffer has to wonder; a caller has to have something.
            Read::InRange if big => (0.06, 0.55 + 0.4 * closeness),
            Read::NeedsMove if big => (0.0, 0.10 + 0.5 * closeness),
            Read::LongShot if big => (0.0, 0.04),
            Read::Blind if big => (0.0, 0.25),
            Read::InRange => (0.25, 1.0),
            Read::NeedsMove if fair => (0.05, 0.75),
            Read::NeedsMove => (0.04, 0.45),
            Read::LongShot if cheap => (0.03, 0.45),
            Read::LongShot => (0.05, 0.20),
            Read::Blind if fair => (0.05, 0.80),
            Read::Blind => (0.0, 0.40),
        };
        let (raise_freq, call_freq) = (raise_freq * style.0, (call_freq * style.1).min(1.0));
        // Nobody folds for pennies: at 10:1 or better even a long shot is a call. Folding
        // the blind into a pot of antes is what makes a table feel asleep.
        let call_freq = if to_call.saturating_mul(10) <= pot { 1.0 } else { call_freq };
        if can_raise && roll < raise_freq {
            raise
        } else if roll < call_freq {
            call
        } else {
            fold
        }
    };

    // Nonces only have to be unused for the seat; starting from the clock keeps them fresh
    // across a restart in the middle of a hand.
    let start = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(1);
    let nonce = nonces
        .entry(to_act as u16)
        .and_modify(|n| *n += 1)
        .or_insert(start);
    let prev_head: [u8; 32] = hex::decode(&head_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_default();
    let msg = syndicate_shared::intent::action_intent_message(
        room.onchain_match_id,
        room.onchain_match_id,
        to_act as u16,
        &bot.pubkey().to_bytes(),
        *nonce,
        &prev_head,
        tag,
        amount,
    );
    let frame = json!({
        "t": "act", "match_id": room.match_id, "seat_index": to_act,
        "nonce": *nonce, "prev_head_hex": head_hex, "action": action,
        "signature": sign_wallet_safe_b64(&bot.kp, &msg),
    });
    let resp = ws_send_and_recv(ctx, &bot.kp, &frame).await;
    if let Some(err) = resp.iter().find(|f| f["t"] == "error") {
        // A stale head or a street that just closed: re-read the table and try again. The
        // server's own timeout default covers the seat if the bot keeps missing.
        println!(
            "house: {} action rejected ({}); re-reading",
            bot.name,
            err["code"].as_str().unwrap_or("?")
        );
    } else {
        // A little table talk, so a hand against the house does not play out in silence.
        let say = if tag == ACTION_TAG_FOLD && rng.unit() < 0.5 {
            Some("nice")
        } else if (tag == ACTION_TAG_BET_TO || tag == ACTION_TAG_RAISE_TO) && rng.unit() < 0.3 {
            Some(if read == Read::InRange {
                "sweat"
            } else {
                "bluff"
            })
        } else if tag == ACTION_TAG_CALL && rng.unit() < 0.12 {
            Some("wow")
        } else {
            None
        };
        if let Some(emote) = say {
            let talk = json!({ "t": "emote", "match_id": room.match_id, "emote": emote });
            let _ = ws_send_and_recv(ctx, &bot.kp, &talk).await;
        }
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
}
