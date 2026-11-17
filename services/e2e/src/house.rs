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
//!   PRICE_URL                   signed-price-server base URL; without it bots ride spot

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;

const NAMES: [&str; 5] = ["BOT1", "BOT2", "BOT3", "BOT4", "BOT5"];

struct House {
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
    let house = House {
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

/// Play a table to its end in the background, then collect.
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
        // A deposit needs ~20s to finalize; past that point sitting down would only strand it.
        if !all_in(seated) && (person_here || showcase) && left_ms > 20_000 {
            let why = if person_here {
                "a player sat down"
            } else {
                "showcase hand"
            };
            println!("house: {why} — seating the rest of the bots");
            for bot in &bots[1..] {
                let handle = discover_public(ctx, room.onchain_match_id).await;
                deposit_and_confirm(ctx, bot, &handle).await;
            }
            seated = bots.len();
        }
        if opened.elapsed() > Duration::from_secs(house.fill_sec + 180) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Drive the table from wherever it is to a terminal phase.
async fn play(ctx: &Ctx, room: &Room, bots: &[Player], house: &House) -> String {
    let mut rng = Rng::new();
    let mut seal_tried: HashSet<String> = HashSet::new();
    let mut nonces: HashMap<u16, u64> = HashMap::new();
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
                    // Each bot has its own spread: the lead calls tight, the rest wider.
                    let spread_bps = 8.0 + 14.0 * i as f64;
                    let drift = (rng.unit() * 2.0 - 1.0) * spread_bps / 10_000.0;
                    let call = (spot as f64 * (1.0 + drift)) as i128;
                    let target = timelock_target(room, &detail);
                    seal(ctx, bot, room, seat_index as u16, target, call).await;
                    println!("house: {} sealed", bot.name);
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            "live" => {
                act_if_ours(ctx, room, bots, &detail, &mut nonces, &mut rng).await;
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
async fn act_if_ours(
    ctx: &Ctx,
    room: &Room,
    bots: &[Player],
    detail: &Value,
    nonces: &mut HashMap<u16, u64>,
    rng: &mut Rng,
) {
    let idle = Duration::from_millis(1_500);
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

    // A beat before acting, so the table reads as play rather than a script.
    tokio::time::sleep(Duration::from_millis(rng.range(1_500, 4_000))).await;

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

    use syndicate_shared::intent::{
        ACTION_TAG_BET_TO, ACTION_TAG_CALL, ACTION_TAG_CHECK, ACTION_TAG_FOLD, ACTION_TAG_RAISE_TO,
    };
    let fold = (ACTION_TAG_FOLD, 0, json!("fold"));
    let call = (ACTION_TAG_CALL, 0, json!("call"));
    let check = (ACTION_TAG_CHECK, 0, json!("check"));
    let raise = if current_bet > 0 {
        (
            ACTION_TAG_RAISE_TO,
            min_raise_to,
            json!({"kind": "raise_to", "amount": min_raise_to}),
        )
    } else {
        (
            ACTION_TAG_BET_TO,
            min_raise_to,
            json!({"kind": "bet_to", "amount": min_raise_to}),
        )
    };
    let (tag, amount, action) = if to_call == 0 {
        if can_raise && roll < 0.30 {
            raise
        } else {
            check
        }
    } else if to_call.saturating_mul(5) > stack.saturating_mul(2) {
        // Facing more than 40% of the stack: a coin flip between standing and folding.
        if roll < 0.5 {
            call
        } else {
            fold
        }
    } else if can_raise && roll < 0.10 {
        raise
    } else if roll < 0.95 {
        call
    } else {
        fold
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
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
}
