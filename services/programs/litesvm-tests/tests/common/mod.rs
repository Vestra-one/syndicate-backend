//! Standalone litesvm harness (no Anchor host dependency — loads the built `.so` directly).

mod types;

use borsh::{BorshDeserialize, BorshSerialize};
use ed25519_dalek::{Signer, SigningKey};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolSigner},
    sysvar,
    transaction::Transaction,
};
use spl_token::instruction as token_ix;
use std::path::PathBuf;
use syndicate_shared::intent::{action_intent_message, default_policy_message};
use types::{
    ActionLogAccount, AppendPlayerActionArgs, AppendTimeoutActionArgs, CreateParams,
    InitActionLogParams, ProtocolRoles, RegisterDefaultPolicyArgs, SeatMeta, SetButtonSeedArgs,
};

pub use types::DEFAULT_TAG_CHECK_FOLD;
pub use syndicate_engine_core::GENESIS_HEAD;

pub const PROGRAM_ID: Pubkey = pubkey!("FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS");
pub const TOKEN_PROGRAM_ID: Pubkey = spl_token::ID;
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

pub const MATCH_ID: u64 = 1;
pub const BUY_IN: u64 = 100;
pub const ENTRY_FEE: u64 = 0;
pub const SB: u64 = 1;
pub const BB: u64 = 2;

pub fn program_so_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/syndicate_program.so")
}

pub fn account_discriminator(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("account:{name}"));
    hash[0..8].try_into().unwrap()
}

pub fn anchor_discriminator(name: &str) -> [u8; 8] {
    let hash = Sha256::digest(format!("global:{name}"));
    hash[0..8].try_into().unwrap()
}

fn ix_data<T: BorshSerialize>(disc: &str, args: &T) -> Vec<u8> {
    let mut data = anchor_discriminator(disc).to_vec();
    args.serialize(&mut data).expect("serialize ix args");
    data
}

pub fn protocol_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"protocol"], &PROGRAM_ID)
}

pub fn match_pda(match_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"match", &match_id.to_le_bytes()], &PROGRAM_ID)
}

pub fn vault_pda(match_key: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", match_key.as_ref()], &PROGRAM_ID)
}

pub fn seat_pda(match_key: &Pubkey, player: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"seat", match_key.as_ref(), player.as_ref()], &PROGRAM_ID)
}

pub fn seat_index_pda(match_key: &Pubkey, seat_index: u16) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"seat-index", match_key.as_ref(), &seat_index.to_le_bytes()],
        &PROGRAM_ID,
    )
}

pub fn action_log_pda(match_key: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"actionlog", match_key.as_ref()], &PROGRAM_ID)
}

pub fn signing_key_from_keypair(kp: &Keypair) -> SigningKey {
    SigningKey::from_bytes(&kp.to_bytes()[..32].try_into().unwrap())
}

pub fn ed25519_verify_instruction(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Instruction {
    let public_key_offset: u16 = 16;
    let signature_offset: u16 = public_key_offset + 32;
    let message_data_offset: u16 = signature_offset + 64;
    let mut data = vec![0u8; message_data_offset as usize + message.len()];
    data[0] = 1;
    data[2..4].copy_from_slice(&signature_offset.to_le_bytes());
    data[6..8].copy_from_slice(&public_key_offset.to_le_bytes());
    data[10..12].copy_from_slice(&message_data_offset.to_le_bytes());
    data[12..14].copy_from_slice(&(message.len() as u16).to_le_bytes());
    data[public_key_offset as usize..public_key_offset as usize + 32]
        .copy_from_slice(public_key);
    data[signature_offset as usize..signature_offset as usize + 64].copy_from_slice(signature);
    data[message_data_offset as usize..].copy_from_slice(message);
    Instruction {
        program_id: ED25519_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instructions: Vec<Instruction>,
    extra_signers: &[&Keypair],
) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let mut tx = Transaction::new_with_payer(&instructions, Some(&payer.pubkey()));
    let signers: Vec<&Keypair> = std::iter::once(payer)
        .chain(extra_signers.iter().copied())
        .collect();
    tx.sign(&signers, blockhash);
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

pub struct MatchHarness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub players: [Keypair; 3],
    pub mint: Keypair,
    pub match_key: Pubkey,
    pub player_tokens: [Pubkey; 3],
}

impl MatchHarness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_so_path())
            .expect("load syndicate_program.so — run `cargo build-sbf` first");

        let admin = Keypair::new();
        let players = [Keypair::new(), Keypair::new(), Keypair::new()];
        let mint = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        for p in &players {
            svm.airdrop(&p.pubkey(), 10_000_000_000).unwrap();
        }

        let mut h = Self {
            svm,
            admin,
            players,
            mint,
            match_key: Pubkey::default(),
            player_tokens: [Pubkey::default(); 3],
        };
        h.init_mint();
        h.init_protocol();
        h.create_match();
        h.deposit_all();
        h.lock_match();
        h
    }

    fn init_mint(&mut self) {
        let rent = self.svm.minimum_balance_for_rent_exemption(82);
        let ix1 = solana_sdk::system_instruction::create_account(
            &self.admin.pubkey(),
            &self.mint.pubkey(),
            rent,
            82,
            &TOKEN_PROGRAM_ID,
        );
        let ix2 = token_ix::initialize_mint(
            &TOKEN_PROGRAM_ID,
            &self.mint.pubkey(),
            &self.admin.pubkey(),
            None,
            6,
        )
        .unwrap();
        send(
            &mut self.svm,
            &self.admin,
            vec![ix1, ix2],
            &[&self.mint],
        )
        .expect("init mint");
    }

    fn init_protocol(&mut self) {
        let (protocol, _) = protocol_pda();
        let roles = ProtocolRoles {
            protocol_admin: self.admin.pubkey(),
            settlement_admin: self.admin.pubkey(),
            emergency_void_admin: self.admin.pubkey(),
            pause_admin: self.admin.pubkey(),
            config_admin: self.admin.pubkey(),
            fee_admin: self.admin.pubkey(),
            treasury_admin: self.admin.pubkey(),
            upgrade_authority: self.admin.pubkey(),
        };
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(protocol, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("initialize_protocol", &roles),
        };
        send(&mut self.svm, &self.admin, vec![ix], &[])
            .expect("initialize_protocol");
    }

    fn create_match(&mut self) {
        let (protocol, _) = protocol_pda();
        let (match_key, _) = match_pda(MATCH_ID);
        let (vault, _) = vault_pda(&match_key);
        self.match_key = match_key;
        let params = CreateParams {
            match_id: MATCH_ID,
            buy_in: BUY_IN,
            entry_fee: ENTRY_FEE,
            rake_bps: 0,
            rake_cap: 0,
            min_players: 2,
            max_players: 5,
            config_hash: [1u8; 32],
            price_feed_id: [7u8; 32],
            scheduled_end_ts: 1_000,
            oracle_delay_window_sec: 60,
            max_oracle_confidence: 100,
            oracle_exponent: -8,
        };
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new_readonly(self.mint.pubkey(), false),
                AccountMeta::new(match_key, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
                AccountMeta::new_readonly(sysvar::rent::ID, false),
            ],
            data: ix_data("create_match", &params),
        };
        send(&mut self.svm, &self.admin, vec![ix], &[]).expect("create_match");
    }

    fn deposit_all(&mut self) {
        for (seat, player) in self.players.iter().enumerate() {
            let (seat_key, _) = seat_pda(&self.match_key, &player.pubkey());
            let (seat_index_key, _) = seat_index_pda(&self.match_key, seat as u16);
            let (protocol, _) = protocol_pda();
            let (vault, _) = vault_pda(&self.match_key);
            let token = Keypair::new();
            self.player_tokens[seat] = token.pubkey();
            let rent = self.svm.minimum_balance_for_rent_exemption(165);
            let create = solana_sdk::system_instruction::create_account(
                &player.pubkey(),
                &token.pubkey(),
                rent,
                165,
                &TOKEN_PROGRAM_ID,
            );
            let init = token_ix::initialize_account(
                &TOKEN_PROGRAM_ID,
                &token.pubkey(),
                &self.mint.pubkey(),
                &player.pubkey(),
            )
            .unwrap();
            send(&mut self.svm, player, vec![create, init], &[&token]).expect("init player token");
            let mint_to = token_ix::mint_to(
                &TOKEN_PROGRAM_ID,
                &self.mint.pubkey(),
                &token.pubkey(),
                &self.admin.pubkey(),
                &[],
                BUY_IN + ENTRY_FEE + 1_000,
            )
            .unwrap();
            send(&mut self.svm, &self.admin, vec![mint_to], &[]).expect("mint_to");

            let seat_index = seat as u16;
            let ix = Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(player.pubkey(), true),
                    AccountMeta::new_readonly(protocol, false),
                    AccountMeta::new(self.match_key, false),
                    AccountMeta::new(seat_key, false),
                    AccountMeta::new(seat_index_key, false),
                    AccountMeta::new(token.pubkey(), false),
                    AccountMeta::new(vault, false),
                    AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                    AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
                ],
                data: ix_data("deposit", &seat_index),
            };
            send(&mut self.svm, player, vec![ix], &[]).expect("deposit");
        }
    }

    fn lock_match(&mut self) {
        let (protocol, _) = protocol_pda();
        let lock_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
            ],
            data: anchor_discriminator("lock").to_vec(),
        };
        send(&mut self.svm, &self.admin, vec![lock_ix], &[]).expect("lock");

        let vrf_seed = [0u8; 32];
        let args = SetButtonSeedArgs {
            vrf_seed,
            vrf_proof_hash: [8u8; 32],
        };
        let seed_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
            ],
            data: ix_data("set_button_seed", &args),
        };
        send(&mut self.svm, &self.admin, vec![seed_ix], &[]).expect("set_button_seed");

        let live_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
            ],
            data: anchor_discriminator("begin_live").to_vec(),
        };
        send(&mut self.svm, &self.admin, vec![live_ix], &[]).expect("begin_live");
    }

    pub fn inject_action_log(&mut self) {
        use syndicate_engine_core::Engine;
        use syndicate_shared::PlayerId;

        let (action_log_key, bump) = action_log_pda(&self.match_key);
        let players: Vec<_> = (0..3u16)
            .map(|i| (PlayerId(i), BUY_IN, i as u64))
            .collect();
        let engine = Engine::new(players, 0, SB, BB, 3);
        let engine_bytes = engine_borsh::to_vec(&engine).expect("engine bytes");

        let mut seats = std::array::from_fn(|_| SeatMeta::default());
        for (i, player) in self.players.iter().enumerate() {
            seats[i] = SeatMeta {
                player: player.pubkey(),
                seal_seq: i as u64,
                occupied: true,
                ..SeatMeta::default()
            };
        }

        let log = ActionLogAccount {
            match_key: self.match_key,
            head: GENESIS_HEAD,
            event_root: [0u8; 32],
            finalized: false,
            action_count: 0,
            player_count: 3,
            scheduled_end_ts: 1_000,
            settle_deadline_ts: 9_999_999_999,
            engine_bytes,
            seats,
            bump,
        };

        let mut data = account_discriminator("ActionLog").to_vec();
        log.serialize(&mut data).expect("serialize action log");

        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                action_log_key,
                solana_sdk::account::Account {
                    lamports,
                    data,
                    owner: PROGRAM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set action log account");
    }

    pub fn init_action_log(&mut self) {
        self.inject_action_log();
    }

    pub fn register_default_policy(&mut self, seat: usize, policy_tag: u8) {
        let player = &self.players[seat];
        let (action_log, _) = action_log_pda(&self.match_key);
        let msg = default_policy_message(
            MATCH_ID,
            MATCH_ID,
            seat as u16,
            &player.pubkey().to_bytes(),
            policy_tag,
        );
        let sig = signing_key_from_keypair(player).sign(&msg);
        let ed_ix = ed25519_verify_instruction(
            &player.pubkey().to_bytes(),
            &msg,
            &sig.to_bytes(),
        );
        let args = RegisterDefaultPolicyArgs {
            seat_index: seat as u16,
            policy_tag,
            ed25519_ix_index: 0,
        };
        let prog_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new(action_log, false),
                AccountMeta::new_readonly(self.match_key, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
            ],
            data: ix_data("register_default_policy", &args),
        };
        send(
            &mut self.svm,
            player,
            vec![ed_ix, prog_ix],
            &[],
        )
        .expect("register_default_policy");
    }

    pub fn append_player_action(
        &mut self,
        seat: usize,
        nonce: u64,
        action_tag: u8,
        amount: u64,
        prev_head: &[u8; 32],
    ) -> Result<(), String> {
        let player = &self.players[seat];
        let (protocol, _) = protocol_pda();
        let (action_log, _) = action_log_pda(&self.match_key);
        let msg = action_intent_message(
            MATCH_ID,
            MATCH_ID,
            seat as u16,
            &player.pubkey().to_bytes(),
            nonce,
            prev_head,
            action_tag,
            amount,
        );
        let sig = signing_key_from_keypair(player).sign(&msg);
        let ed_ix = ed25519_verify_instruction(
            &player.pubkey().to_bytes(),
            &msg,
            &sig.to_bytes(),
        );
        let args = AppendPlayerActionArgs {
            seat_index: seat as u16,
            nonce,
            action_tag,
            amount,
            ed25519_ix_index: 0,
        };
        let prog_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(action_log, false),
                AccountMeta::new_readonly(self.match_key, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
            ],
            data: ix_data("append_player_action", &args),
        };
        send(
            &mut self.svm,
            player,
            vec![ed_ix, prog_ix],
            &[],
        )
    }

    pub fn append_timeout(&mut self, seat: usize) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let (action_log, _) = action_log_pda(&self.match_key);
        let args = AppendTimeoutActionArgs {
            seat_index: seat as u16,
        };
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(action_log, false),
                AccountMeta::new_readonly(self.match_key, false),
            ],
            data: ix_data("append_timeout_action", &args),
        };
        send(&mut self.svm, &self.admin, vec![ix], &[])
    }

    pub fn finalize_action_log(&mut self, event_root: [u8; 32]) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let (action_log, _) = action_log_pda(&self.match_key);
        let mut data = anchor_discriminator("finalize_action_log").to_vec();
        data.extend_from_slice(&event_root);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(action_log, false),
                AccountMeta::new_readonly(self.match_key, false),
            ],
            data,
        };
        send(&mut self.svm, &self.admin, vec![ix], &[])
    }

    pub fn read_action_log_head(&self) -> [u8; 32] {
        let (action_log, _) = action_log_pda(&self.match_key);
        let acct = self.svm.get_account(&action_log).expect("action log account");
        let mut head = [0u8; 32];
        head.copy_from_slice(&acct.data[40..72]);
        head
    }
}

pub fn wrong_signature_append(h: &mut MatchHarness, seat: usize) -> Result<(), String> {
    let wrong = &h.players[(seat + 1) % 3];
    let player = &h.players[seat];
    let (protocol, _) = protocol_pda();
    let (action_log, _) = action_log_pda(&h.match_key);
    let msg = action_intent_message(
        MATCH_ID,
        MATCH_ID,
        seat as u16,
        &player.pubkey().to_bytes(),
        1,
        &GENESIS_HEAD,
        2,
        0,
    );
    let sig = signing_key_from_keypair(wrong).sign(&msg);
    let ed_ix = ed25519_verify_instruction(
        &player.pubkey().to_bytes(),
        &msg,
        &sig.to_bytes(),
    );
    let args = AppendPlayerActionArgs {
        seat_index: seat as u16,
        nonce: 1,
        action_tag: 2,
        amount: 0,
        ed25519_ix_index: 0,
    };
    let prog_ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(player.pubkey(), true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(action_log, false),
            AccountMeta::new_readonly(h.match_key, false),
            AccountMeta::new_readonly(sysvar::instructions::ID, false),
        ],
        data: ix_data("append_player_action", &args),
    };
    send(
        &mut h.svm,
        player,
        vec![ed_ix, prog_ix],
        &[],
    )
}

pub fn canonical_action_step(
    seat_index: u16,
    nonce: u64,
    tag: u8,
    amount: u64,
    is_timeout: bool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    if is_timeout {
        out.extend_from_slice(b"timeout|");
    } else {
        out.extend_from_slice(b"action|");
    }
    out.extend_from_slice(&seat_index.to_le_bytes());
    out.extend_from_slice(&nonce.to_le_bytes());
    out.push(tag);
    out.extend_from_slice(&amount.to_le_bytes());
    out
}

pub fn advance_head(prev: &[u8; 32], step: &[u8]) -> [u8; 32] {
    syndicate_shared::action_head_step(prev, step)
}
