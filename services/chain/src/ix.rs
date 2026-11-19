//! Instruction builders. Account orders mirror the Anchor `#[derive(Accounts)]` contexts
//! in the v2 program exactly.

use borsh::BorshSerialize;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    sysvar,
};

/// System program id (the `solana_sdk::system_program` re-export is deprecated).
pub const SYSTEM_PROGRAM_ID: Pubkey = solana_sdk::pubkey!("11111111111111111111111111111111");

use crate::{
    disc,
    params::{CreateParams, MatchBounds, ProtocolRoles, RegisterPredictionCommitmentArgs},
    pda,
    settle_args::SettleArgs,
};

/// SPL Token program id (avoids a spl-token dependency for one constant).
pub const TOKEN_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

fn data<T: BorshSerialize>(name: &str, args: &T) -> Vec<u8> {
    let mut out = disc::instruction(name).to_vec();
    args.serialize(&mut out).expect("serialize ix args");
    out
}

fn data_empty(name: &str) -> Vec<u8> {
    disc::instruction(name).to_vec()
}

pub fn initialize_protocol(
    program_id: &Pubkey,
    authority: &Pubkey,
    roles: ProtocolRoles,
    bounds: MatchBounds,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(protocol, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: data("initialize_protocol", &(roles, bounds)),
    }
}

pub fn set_price_signer(
    program_id: &Pubkey,
    authority: &Pubkey,
    price_signer: [u8; 20],
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(protocol, false),
        ],
        data: data("set_price_signer", &price_signer),
    }
}

pub fn set_match_bounds(
    program_id: &Pubkey,
    authority: &Pubkey,
    bounds: MatchBounds,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(protocol, false),
        ],
        data: data("set_match_bounds", &bounds),
    }
}

pub fn set_pauses(
    program_id: &Pubkey,
    authority: &Pubkey,
    pause_new_matches: bool,
    pause_settlement: bool,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(protocol, false),
        ],
        data: data("set_pauses", &(pause_new_matches, pause_settlement)),
    }
}

pub fn create_match(
    program_id: &Pubkey,
    authority: &Pubkey,
    mint: &Pubkey,
    params: &CreateParams,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let (match_key, _) = pda::match_account(program_id, params.match_id);
    let (vault, _) = pda::vault(program_id, &match_key);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(match_key, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(sysvar::rent::ID, false),
        ],
        data: data("create_match", params),
    }
}

pub fn create_and_deposit(
    program_id: &Pubkey,
    authority: &Pubkey,
    mint: &Pubkey,
    player_token: &Pubkey,
    params: &CreateParams,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let (match_key, _) = pda::match_account(program_id, params.match_id);
    let (vault, _) = pda::vault(program_id, &match_key);
    let (seat, _) = pda::seat(program_id, &match_key, authority);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(match_key, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(seat, false),
            AccountMeta::new(*player_token, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(sysvar::rent::ID, false),
        ],
        data: data("create_and_deposit", params),
    }
}

pub fn deposit(
    program_id: &Pubkey,
    player: &Pubkey,
    match_key: &Pubkey,
    vault: &Pubkey,
    player_token: &Pubkey,
    join_commitment: [u8; 32],
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let (seat, _) = pda::seat(program_id, match_key, player);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*player, true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(*match_key, false),
            AccountMeta::new(seat, false),
            AccountMeta::new(*player_token, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: data("deposit", &join_commitment),
    }
}

/// `lock`: confirmed seat PDAs (writable) as remaining accounts, in engine order.
pub fn lock(
    program_id: &Pubkey,
    authority: &Pubkey,
    match_key: &Pubkey,
    confirmed_players: &[Pubkey],
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let mut accounts = vec![
        AccountMeta::new_readonly(*authority, true),
        AccountMeta::new_readonly(protocol, false),
        AccountMeta::new(*match_key, false),
    ];
    for player in confirmed_players {
        let (seat, _) = pda::seat(program_id, match_key, player);
        accounts.push(AccountMeta::new(seat, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: data_empty("lock"),
    }
}

/// `begin_live`: confirmed seat PDAs (read-only) in engine order; no args.
pub fn begin_live(
    program_id: &Pubkey,
    authority: &Pubkey,
    match_key: &Pubkey,
    confirmed_players: &[Pubkey],
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let mut accounts = vec![
        AccountMeta::new_readonly(*authority, true),
        AccountMeta::new_readonly(protocol, false),
        AccountMeta::new(*match_key, false),
    ];
    for player in confirmed_players {
        let (seat, _) = pda::seat(program_id, match_key, player);
        accounts.push(AccountMeta::new_readonly(seat, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: data_empty("begin_live"),
    }
}

pub fn register_prediction_commitment(
    program_id: &Pubkey,
    player: &Pubkey,
    match_key: &Pubkey,
    args: &RegisterPredictionCommitmentArgs,
) -> Instruction {
    let (seat, _) = pda::seat(program_id, match_key, player);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*player, true),
            AccountMeta::new(*match_key, false),
            AccountMeta::new(seat, false),
        ],
        data: data("register_prediction_commitment", args),
    }
}

/// `submit_settlement`: confirmed seat PDAs (writable) in engine order.
pub fn submit_settlement(
    program_id: &Pubkey,
    authority: &Pubkey,
    match_key: &Pubkey,
    confirmed_players: &[Pubkey],
    args: &SettleArgs,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let mut accounts = vec![
        AccountMeta::new_readonly(*authority, true),
        AccountMeta::new_readonly(protocol, false),
        AccountMeta::new(*match_key, false),
    ];
    for player in confirmed_players {
        let (seat, _) = pda::seat(program_id, match_key, player);
        accounts.push(AccountMeta::new(seat, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: data("submit_settlement", args),
    }
}

/// `submit_uncontested`: same accounts and args as `submit_settlement` (the price is ignored).
pub fn submit_uncontested(
    program_id: &Pubkey,
    authority: &Pubkey,
    match_key: &Pubkey,
    confirmed_players: &[Pubkey],
    args: &SettleArgs,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    let mut accounts = vec![
        AccountMeta::new_readonly(*authority, true),
        AccountMeta::new_readonly(protocol, false),
        AccountMeta::new(*match_key, false),
    ];
    for player in confirmed_players {
        let (seat, _) = pda::seat(program_id, match_key, player);
        accounts.push(AccountMeta::new(seat, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: data("submit_uncontested", args),
    }
}

fn claim_like(
    name: &str,
    program_id: &Pubkey,
    player: &Pubkey,
    match_key: &Pubkey,
    vault: &Pubkey,
    player_token: &Pubkey,
) -> Instruction {
    let (seat, _) = pda::seat(program_id, match_key, player);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*player, true),
            AccountMeta::new(*match_key, false),
            AccountMeta::new(seat, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*player_token, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: data_empty(name),
    }
}

pub fn claim(
    program_id: &Pubkey,
    player: &Pubkey,
    match_key: &Pubkey,
    vault: &Pubkey,
    player_token: &Pubkey,
) -> Instruction {
    claim_like("claim", program_id, player, match_key, vault, player_token)
}

pub fn refund(
    program_id: &Pubkey,
    player: &Pubkey,
    match_key: &Pubkey,
    vault: &Pubkey,
    player_token: &Pubkey,
) -> Instruction {
    claim_like("refund", program_id, player, match_key, vault, player_token)
}

pub fn void(program_id: &Pubkey, authority: &Pubkey, match_key: &Pubkey) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(*match_key, false),
        ],
        data: data_empty("void"),
    }
}

pub fn void_before_start(program_id: &Pubkey, match_key: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*match_key, false)],
        data: data_empty("void_before_start"),
    }
}

pub fn void_live_after_deadline(program_id: &Pubkey, match_key: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*match_key, false)],
        data: data_empty("void_live_after_deadline"),
    }
}

pub fn withdraw_fees(
    program_id: &Pubkey,
    authority: &Pubkey,
    match_key: &Pubkey,
    vault: &Pubkey,
    treasury_token: &Pubkey,
) -> Instruction {
    let (protocol, _) = pda::protocol(program_id);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(*match_key, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*treasury_token, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: data_empty("withdraw_fees"),
    }
}
