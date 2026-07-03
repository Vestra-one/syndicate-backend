//! Protocol admin CLI: initialize_protocol / set_price_signer / set_match_bounds.
//!
//!   cargo run -p syndicate-chain --features rpc --bin init-protocol -- \
//!     init --rpc-url https://api.devnet.solana.com --program-id <id> \
//!     --price-signer 0x<eth-addr> [--keypair ~/.config/solana/id.json] \
//!     [--buy-in-min 1000000 --buy-in-max 1000000000 ...]
//!
//!   ... -- set-price-signer 0x<eth-addr>
//!   ... -- set-match-bounds --buy-in-min ... (all six bounds)
//!
//! The signing keypair (default: solana CLI wallet) becomes every protocol role on `init`.

use std::collections::HashMap;
use std::str::FromStr;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Signer};
use solana_sdk::transaction::Transaction;

use syndicate_chain::params::{MatchBounds, ProtocolRoles};
use syndicate_chain::{ix, PROGRAM_ID_STR};

fn parse_flags(args: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            if i + 1 < args.len() && !args[i + 1].starts_with("--") {
                out.insert(key.to_string(), args[i + 1].clone());
                i += 2;
                continue;
            }
            out.insert(key.to_string(), String::new());
        }
        i += 1;
    }
    out
}

fn eth_address(hex: &str) -> [u8; 20] {
    let h = hex.trim().trim_start_matches("0x");
    let bytes = (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).expect("hex"))
        .collect::<Vec<_>>();
    bytes.try_into().expect("20-byte eth address")
}

fn bounds_from(flags: &HashMap<String, String>) -> MatchBounds {
    let get = |k: &str, default: u64| -> u64 {
        flags
            .get(k)
            .map(|v| v.parse().unwrap_or_else(|_| panic!("bad --{k}")))
            .unwrap_or(default)
    };
    MatchBounds {
        buy_in_min: get("buy-in-min", 1_000_000),
        buy_in_max: get("buy-in-max", 1_000_000_000),
        fill_window_min_sec: get("fill-window-min-sec", 20),
        fill_window_max_sec: get("fill-window-max-sec", 86_400),
        total_betting_duration_min_sec: get("betting-duration-min-sec", 60),
        total_betting_duration_max_sec: get("betting-duration-max-sec", 7_200),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let flags = parse_flags(&args[1.min(args.len())..]);

    let rpc_url = flags
        .get("rpc-url")
        .cloned()
        .or_else(|| std::env::var("SOLANA_RPC_URL").ok())
        .unwrap_or_else(|| "https://api.devnet.solana.com".into());
    let program_id = Pubkey::from_str(
        flags
            .get("program-id")
            .map(String::as_str)
            .unwrap_or(PROGRAM_ID_STR),
    )
    .expect("valid program id");
    let keypair_path = flags
        .get("keypair")
        .cloned()
        .unwrap_or_else(|| shellexpand_home("~/.config/solana/id.json"));
    let payer = read_keypair_file(&keypair_path).expect("read keypair");

    let rpc = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    let instruction = match cmd {
        "init" => {
            let price_signer = eth_address(flags.get("price-signer").expect("--price-signer"));
            let roles = ProtocolRoles {
                protocol_admin: payer.pubkey(),
                settlement_admin: payer.pubkey(),
                emergency_void_admin: payer.pubkey(),
                pause_admin: payer.pubkey(),
                config_admin: payer.pubkey(),
                fee_admin: payer.pubkey(),
                treasury_admin: payer.pubkey(),
                upgrade_authority: payer.pubkey(),
                price_signer,
            };
            ix::initialize_protocol(&program_id, &payer.pubkey(), roles, bounds_from(&flags))
        }
        "set-price-signer" => {
            let price_signer = eth_address(
                flags
                    .get("price-signer")
                    .map(String::as_str)
                    .unwrap_or_else(|| args.get(1).expect("eth address arg")),
            );
            ix::set_price_signer(&program_id, &payer.pubkey(), price_signer)
        }
        "set-match-bounds" => {
            ix::set_match_bounds(&program_id, &payer.pubkey(), bounds_from(&flags))
        }
        other => {
            eprintln!("usage: init-protocol <init|set-price-signer|set-match-bounds> [flags]");
            eprintln!("unknown command: {other:?}");
            std::process::exit(2);
        }
    };

    let blockhash = rpc.get_latest_blockhash().await.expect("blockhash");
    let tx = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[&payer],
        blockhash,
    );
    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .expect("send tx");
    println!("{cmd} ok: {sig}");
}

fn shellexpand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}
