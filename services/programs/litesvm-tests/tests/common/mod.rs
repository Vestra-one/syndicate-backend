//! Standalone litesvm harness (no Anchor host dependency — loads the built `.so` directly).
//!
//! v2 model: deposits create seat CANDIDATES; `lock_match(confirmed)` passes the confirmed
//! seat PDAs as writable remaining accounts in engine order; `begin_live()` takes no args
//! (button derives on-chain from seal commitments); non-sealers keep playing.

mod types;

use borsh::{BorshDeserialize, BorshSerialize};
use ed25519_dalek::{Signer, SigningKey};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolSigner},
    sysvar,
    transaction::Transaction,
};
use spl_token::instruction as token_ix;
use std::path::PathBuf;
use types::{ProtocolRoles, RegisterPredictionCommitmentArgs};
// Re-exported for use by the test modules.
pub use types::{
    CreateParams, MatchAccountData, MatchBounds, SeatAccountData, SeatPayout, SettleArgs,
    SignedPriceDto,
};

/// A deterministic SettleArgs fixture for byte-parity tests.
#[allow(dead_code)]
pub fn build_settle_args_fixture() -> SettleArgs {
    SettleArgs {
        signed_price: SignedPriceDto {
            token: [3u8; 20],
            price_in_wad: [5u8; 32],
            timestamp_ms: 1_700_000_600_000,
            v: 27,
            r: [11u8; 32],
            s: [13u8; 32],
        },
        rake_collected: 9,
        payouts: vec![
            SeatPayout { engine_seat: 0, amount: 150 },
            SeatPayout { engine_seat: 1, amount: 141 },
        ],
    }
}

#[allow(unused_imports)]
pub use types::DEFAULT_TAG_CHECK_FOLD;
#[allow(unused_imports)]
pub use syndicate_engine_core::GENESIS_HEAD;

// Must match `declare_id!` in the program source (the `.so` is built from it); Anchor rejects a
// load address that differs (error 4100, DeclaredProgramIdMismatch).
pub const PROGRAM_ID: Pubkey = pubkey!("EQsNZV4bBqaXFSSDkYKxuu57eBB9s83ouTjC4imDNvTv");
pub const TOKEN_PROGRAM_ID: Pubkey = spl_token::ID;
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

pub const NO_ENGINE_SEAT: u8 = u8::MAX;

/// Base wall-clock the harness seeds the litesvm `Clock` to before any instruction runs.
/// Must be well after `DRAND_GENESIS_TIME` so valid timelock target rounds exist.
pub const BASE_TS: u64 = 1_700_000_000;

pub const MATCH_ID: u64 = 1;
pub const BUY_IN: u64 = 100;
pub const ENTRY_FEE: u64 = 0;
pub const SB: u64 = 1;
pub const BB: u64 = 2;

pub const NUM_KEYPAIRS: usize = 6;

/// 20-byte token/feed id used by the harness (matches `price_token` in `create_match`).
pub const PRICE_TOKEN: [u8; 20] = [7u8; 20];

/// Room code used by private-room fixtures (normalized: uppercase A-Z2-9).
pub const ROOM_CODE: &str = "KX7Q2M";

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

/// Normative room commitment: `sha256(roomcode_utf8 ‖ wallet_pubkey_bytes)`.
pub fn room_commitment(room_code: &str, wallet: &Pubkey) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(room_code.as_bytes());
    hasher.update(wallet.as_ref());
    hasher.finalize().into()
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

/// Fixed 32-byte secp256k1 test secret key whose public address is seeded as the
/// protocol `price_signer` (full-fidelity signed-price path).
pub const PRICE_SIGNER_SECRET: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01,
    0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x20,
];

/// 20-byte Ethereum address = last 20 bytes of keccak256(uncompressed-pubkey[1..]).
pub fn eth_address_of_secret(secret: &[u8; 32]) -> [u8; 20] {
    let sk = libsecp256k1::SecretKey::parse(secret).expect("valid secp256k1 secret");
    let pk = libsecp256k1::PublicKey::from_secret_key(&sk);
    let full = pk.serialize();
    let hash = solana_keccak_hasher::hash(&full[1..]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash.to_bytes()[12..]);
    addr
}

/// Build a fully-signed `SignedPriceDto` recoverable to `price_signer`, mirroring the
/// signed-price-server: keccak256(token || price_in_wad(32 BE) || timestamp_ms(32 BE))
/// then the EIP-191 `"\x19Ethereum Signed Message:\n32"` prefix, signed with secp256k1.
pub fn signed_price_dto(
    secret: &[u8; 32],
    token: [u8; 20],
    price: u128,
    timestamp_ms: u64,
) -> SignedPriceDto {
    let mut price_in_wad = [0u8; 32];
    price_in_wad[16..].copy_from_slice(&price.to_be_bytes());

    let mut timestamp_bytes = [0u8; 32];
    timestamp_bytes[24..].copy_from_slice(&timestamp_ms.to_be_bytes());

    let inner = solana_keccak_hasher::hashv(&[&token, &price_in_wad, &timestamp_bytes]);
    let eth_hash = solana_keccak_hasher::hashv(&[
        b"\x19Ethereum Signed Message:\n32",
        inner.as_ref(),
    ]);

    let sk = libsecp256k1::SecretKey::parse(secret).expect("valid secret");
    let msg = libsecp256k1::Message::parse(&eth_hash.to_bytes());
    let (sig, rec) = libsecp256k1::sign(&msg, &sk);
    let sig_bytes = sig.serialize();
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&sig_bytes[..32]);
    s.copy_from_slice(&sig_bytes[32..]);
    SignedPriceDto {
        token,
        price_in_wad,
        timestamp_ms,
        v: rec.serialize() + 27,
        r,
        s,
    }
}

/// Per-match knobs for building harnesses in arbitrary terminal states.
#[derive(Clone, Copy)]
pub struct MatchConfig {
    pub match_id: u64,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    /// How many of the harness keypairs deposit (become candidates).
    pub num_players: usize,
    pub fill_deadline_ts: u64,
    pub is_private: bool,
    pub total_betting_duration_sec: u64,
}

impl Default for MatchConfig {
    fn default() -> Self {
        Self {
            match_id: MATCH_ID,
            buy_in: BUY_IN,
            entry_fee: ENTRY_FEE,
            rake_bps: 0,
            rake_cap: 0,
            min_players: 2,
            max_players: 5,
            num_players: 3,
            fill_deadline_ts: 9_999_999_999,
            is_private: false,
            total_betting_duration_sec: 600,
        }
    }
}

pub struct MatchHarness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub players: [Keypair; NUM_KEYPAIRS],
    pub mint: Keypair,
    pub match_key: Pubkey,
    pub player_tokens: [Pubkey; NUM_KEYPAIRS],
    pub cfg: MatchConfig,
    /// The confirmed set passed to `lock_match`, in engine order (player indices).
    pub confirmed: Vec<usize>,
}

impl MatchHarness {
    /// Default fixture: 3 candidates, all confirmed at lock in deposit order.
    pub fn new() -> Self {
        let mut h = Self::bare(MatchConfig::default());
        h.create_match();
        h.deposit_all();
        h.lock_match(&[0, 1, 2]);
        h
    }

    /// Build a harness up to (but not including) `create_match`.
    pub fn bare(cfg: MatchConfig) -> Self {
        assert!(
            cfg.num_players <= NUM_KEYPAIRS,
            "harness has {NUM_KEYPAIRS} player keypairs"
        );
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM_ID, program_so_path())
            .expect("load syndicate_program.so — run `cargo build-sbf` first");

        // Seed a realistic wall-clock (litesvm defaults to unix 0, before drand genesis).
        {
            let mut clock = svm.get_sysvar::<Clock>();
            clock.unix_timestamp = BASE_TS as i64;
            svm.set_sysvar::<Clock>(&clock);
        }

        let admin = Keypair::new();
        let players: [Keypair; NUM_KEYPAIRS] = std::array::from_fn(|_| Keypair::new());
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
            player_tokens: [Pubkey::default(); NUM_KEYPAIRS],
            cfg,
            confirmed: Vec::new(),
        };
        h.init_mint();
        h.init_protocol();
        h
    }

    /// Players who deposited into this match (candidates).
    pub fn seated(&self) -> &[Keypair] {
        &self.players[..self.cfg.num_players]
    }

    /// The room commitment recorded on the match (creator binding) for private fixtures.
    pub fn creator_room_commitment(&self) -> [u8; 32] {
        if self.cfg.is_private {
            room_commitment(ROOM_CODE, &self.admin.pubkey())
        } else {
            [0u8; 32]
        }
    }

    /// The join commitment a given player passes to `deposit`.
    pub fn join_commitment(&self, seat: usize) -> [u8; 32] {
        if self.cfg.is_private {
            room_commitment(ROOM_CODE, &self.players[seat].pubkey())
        } else {
            [0u8; 32]
        }
    }

    // ---- Clock control -------------------------------------------------------------

    pub fn now(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp as u64
    }

    /// Force the on-chain clock to `ts` (advance past deadlines). Also expires the
    /// blockhash so the next tx is accepted as distinct.
    pub fn set_clock(&mut self, ts: u64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = ts as i64;
        self.svm.set_sysvar::<Clock>(&clock);
        self.svm.expire_blockhash();
    }

    pub fn match_account(&self) -> MatchAccountData {
        let acc = self.svm.get_account(&self.match_key).expect("match account");
        MatchAccountData::try_from_slice(&acc.data[8..]).expect("decode match account")
    }

    pub fn seat_account(&self, seat: usize) -> SeatAccountData {
        let (seat_key, _) = seat_pda(&self.match_key, &self.players[seat].pubkey());
        let acc = self.svm.get_account(&seat_key).expect("seat account");
        SeatAccountData::try_from_slice(&acc.data[8..]).expect("decode seat account")
    }

    pub fn vault_balance(&self) -> u64 {
        let (vault, _) = vault_pda(&self.match_key);
        let acc = self.svm.get_account(&vault).expect("vault account");
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
    }

    pub fn token_balance(&self, token: &Pubkey) -> u64 {
        let acc = self.svm.get_account(token).expect("token account");
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
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
        send(&mut self.svm, &self.admin, vec![ix1, ix2], &[&self.mint]).expect("init mint");
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
            price_signer: eth_address_of_secret(&PRICE_SIGNER_SECRET),
        };
        // Wide-open bounds so existing harness fixtures pass the on-chain range checks;
        // bound-specific tests override these via `set_match_bounds`.
        let bounds = MatchBounds {
            buy_in_min: 1,
            buy_in_max: u64::MAX,
            fill_window_min_sec: 1,
            fill_window_max_sec: u64::MAX,
            total_betting_duration_min_sec: 1,
            total_betting_duration_max_sec: u64::MAX,
        };
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(protocol, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("initialize_protocol", &(roles, bounds)),
        };
        send(&mut self.svm, &self.admin, vec![ix], &[]).expect("initialize_protocol");
    }

    pub fn create_match(&mut self) {
        self.try_create_match().expect("create_match");
    }

    /// Update the operator-governed match bounds as `config_admin`.
    pub fn set_match_bounds(&mut self, bounds: MatchBounds) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new(protocol, false),
            ],
            data: ix_data("set_match_bounds", &bounds),
        };
        send(&mut self.svm, &self.admin, vec![ix], &[])
    }

    fn create_params(&self) -> CreateParams {
        // The on-chain deadline is derived as `now + fill_window_sec`; express the harness's
        // desired absolute `fill_deadline_ts` as a window relative to the current clock.
        let fill_window_sec = self.cfg.fill_deadline_ts.saturating_sub(self.now());
        CreateParams {
            match_id: self.cfg.match_id,
            buy_in: self.cfg.buy_in,
            entry_fee: self.cfg.entry_fee,
            rake_bps: self.cfg.rake_bps,
            rake_cap: self.cfg.rake_cap,
            min_players: self.cfg.min_players,
            max_players: self.cfg.max_players,
            is_private: self.cfg.is_private,
            room_commitment: self.creator_room_commitment(),
            config_hash: [1u8; 32],
            price_token: PRICE_TOKEN,
            total_betting_duration_sec: self.cfg.total_betting_duration_sec,
            seal_window_sec: 20,
            begin_live_window_sec: 5,
            fill_window_sec,
            max_oracle_confidence: 100,
            oracle_exponent: -18,
        }
    }

    /// `create_match` returning the send result (for asserting rejections).
    pub fn try_create_match(&mut self) -> Result<(), String> {
        let params = self.create_params();
        self.try_create_match_with(params)
    }

    /// Expose the fixture-derived params so tests can mutate them before creating.
    pub fn build_create_params(&self) -> CreateParams {
        self.create_params()
    }

    /// `create_match` with explicit params (private-room / bound rejection cases).
    pub fn try_create_match_with(&mut self, params: CreateParams) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let (match_key, _) = match_pda(params.match_id);
        let (vault, _) = vault_pda(&match_key);
        self.match_key = match_key;
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
        send(&mut self.svm, &self.admin, vec![ix], &[])
    }

    /// Ensure a funded SPL token account exists for `seat`.
    fn ensure_player_token(&mut self, seat: usize) {
        if self.player_tokens[seat] != Pubkey::default() {
            return;
        }
        let player = self.players[seat].insecure_clone();
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
        send(&mut self.svm, &player, vec![create, init], &[&token]).expect("init player token");
        let mint_to = token_ix::mint_to(
            &TOKEN_PROGRAM_ID,
            &self.mint.pubkey(),
            &token.pubkey(),
            &self.admin.pubkey(),
            &[],
            self.cfg.buy_in + self.cfg.entry_fee + 1_000,
        )
        .unwrap();
        send(&mut self.svm, &self.admin, vec![mint_to], &[]).expect("mint_to");
    }

    /// Deposit for one player with an explicit join commitment. Returns the send result.
    pub fn deposit_with_commitment(
        &mut self,
        seat: usize,
        join_commitment: [u8; 32],
    ) -> Result<(), String> {
        self.ensure_player_token(seat);
        let player = self.players[seat].insecure_clone();
        let (seat_key, _) = seat_pda(&self.match_key, &player.pubkey());
        let (protocol, _) = protocol_pda();
        let (vault, _) = vault_pda(&self.match_key);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(player.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
                AccountMeta::new(seat_key, false),
                AccountMeta::new(self.player_tokens[seat], false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("deposit", &join_commitment),
        };
        send(&mut self.svm, &player, vec![ix], &[])
    }

    /// Deposit for one player with the fixture-appropriate commitment.
    pub fn deposit(&mut self, seat: usize) -> Result<(), String> {
        let jc = self.join_commitment(seat);
        self.deposit_with_commitment(seat, jc)
    }

    /// Deposit from a brand-new funded keypair (candidate-cap tests beyond the fixed
    /// keypair set). Returns the send result.
    pub fn deposit_new_player(&mut self) -> Result<(), String> {
        let player = Keypair::new();
        self.svm.airdrop(&player.pubkey(), 10_000_000_000).unwrap();
        let token = Keypair::new();
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
        send(&mut self.svm, &player, vec![create, init], &[&token])?;
        let mint_to = token_ix::mint_to(
            &TOKEN_PROGRAM_ID,
            &self.mint.pubkey(),
            &token.pubkey(),
            &self.admin.pubkey(),
            &[],
            self.cfg.buy_in + self.cfg.entry_fee + 1_000,
        )
        .unwrap();
        send(&mut self.svm, &self.admin, vec![mint_to], &[])?;

        let jc = if self.cfg.is_private {
            room_commitment(ROOM_CODE, &player.pubkey())
        } else {
            [0u8; 32]
        };
        let (seat_key, _) = seat_pda(&self.match_key, &player.pubkey());
        let (protocol, _) = protocol_pda();
        let (vault, _) = vault_pda(&self.match_key);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(player.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
                AccountMeta::new(seat_key, false),
                AccountMeta::new(token.pubkey(), false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data: ix_data("deposit", &jc),
        };
        send(&mut self.svm, &player, vec![ix], &[])
    }

    /// Deposit all `num_players` candidates.
    pub fn deposit_all(&mut self) {
        for seat in 0..self.cfg.num_players {
            self.deposit(seat).expect("deposit");
        }
    }

    /// Seat PDAs of a set of player indices, in the given order.
    pub fn seat_pdas_of(&self, players: &[usize]) -> Vec<Pubkey> {
        players
            .iter()
            .map(|&i| seat_pda(&self.match_key, &self.players[i].pubkey()).0)
            .collect()
    }

    /// Lock with an explicit confirmed set (player indices, in engine order). Records the
    /// order so `begin_live`/`submit_settlement` pass seats identically.
    pub fn lock_match(&mut self, confirmed: &[usize]) {
        self.try_lock_match(confirmed).expect("lock");
    }

    /// `lock` returning the send result. `remaining_accounts` = confirmed seat PDAs
    /// (writable), engine order = slice order.
    pub fn try_lock_match(&mut self, confirmed: &[usize]) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let mut accounts = vec![
            AccountMeta::new_readonly(self.admin.pubkey(), true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(self.match_key, false),
        ];
        for s in self.seat_pdas_of(confirmed) {
            accounts.push(AccountMeta::new(s, false));
        }
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: anchor_discriminator("lock").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        let res = send(&mut self.svm, &admin, vec![ix], &[]);
        if res.is_ok() {
            self.confirmed = confirmed.to_vec();
        }
        res
    }

    /// Raw lock with arbitrary seat account keys (validation-failure tests).
    pub fn try_lock_match_raw(&mut self, seat_accounts: &[Pubkey]) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let mut accounts = vec![
            AccountMeta::new_readonly(self.admin.pubkey(), true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(self.match_key, false),
        ];
        for s in seat_accounts {
            accounts.push(AccountMeta::new(*s, false));
        }
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: anchor_discriminator("lock").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    // ---- Lifecycle helpers (matrix-driving) ----------------------------------------

    /// Seal a confirmed player's prediction commitment during Sealing.
    pub fn register_prediction_commitment(
        &mut self,
        seat: usize,
        commitment: [u8; 32],
        timelock_target: u64,
    ) -> Result<(), String> {
        let player = self.players[seat].insecure_clone();
        let (seat_key, _) = seat_pda(&self.match_key, &player.pubkey());
        let args = RegisterPredictionCommitmentArgs {
            commitment,
            timelock_target,
        };
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(player.pubkey(), true),
                AccountMeta::new(self.match_key, false),
                AccountMeta::new(seat_key, false),
            ],
            data: ix_data("register_prediction_commitment", &args),
        };
        send(&mut self.svm, &player, vec![ix], &[])
    }

    /// drand round whose published time falls just inside the valid seal window
    /// `(latest_match_end, latest_match_end + MAX_TIMELOCK_SKEW_SEC]`.
    pub fn valid_timelock_target(&self) -> u64 {
        let m = self.match_account();
        let latest_match_end =
            m.seal_deadline_ts + m.total_betting_duration_sec + m.begin_live_window_sec;
        const GENESIS: u64 = 1_692_803_367;
        const PERIOD: u64 = 3;
        let mut round = (latest_match_end.saturating_sub(GENESIS)) / PERIOD + 1;
        while GENESIS + round * PERIOD <= latest_match_end {
            round += 1;
        }
        round
    }

    /// Advance Sealing → Live. `remaining_accounts` = the confirmed seats in the engine
    /// order recorded at lock. No args (button derives on-chain).
    pub fn begin_live(&mut self) -> Result<(), String> {
        let confirmed = self.confirmed.clone();
        self.begin_live_with(&confirmed)
    }

    /// begin_live with an explicit seat order (order-validation tests).
    pub fn begin_live_with(&mut self, order: &[usize]) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let mut accounts = vec![
            AccountMeta::new_readonly(self.admin.pubkey(), true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(self.match_key, false),
        ];
        for s in self.seat_pdas_of(order) {
            accounts.push(AccountMeta::new_readonly(s, false));
        }
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: anchor_discriminator("begin_live").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    /// Recompute the normative button seed off-chain (parity assertions).
    pub fn expected_button_seed(&self) -> ([u8; 32], u8) {
        let m = self.match_account();
        let mut preimage: Vec<u8> = Vec::new();
        preimage.extend_from_slice(b"syndicate:button:v2");
        preimage.extend_from_slice(self.match_key.as_ref());
        preimage.extend_from_slice(&m.lock_ts.to_le_bytes());
        for &i in &self.confirmed {
            let seat = self.seat_account(i);
            preimage.extend_from_slice(self.players[i].pubkey().as_ref());
            preimage.push(seat.commitment_set as u8);
            preimage.extend_from_slice(&seat.prediction_commitment);
            preimage.extend_from_slice(&seat.timelock_target.to_le_bytes());
        }
        let seed = solana_keccak_hasher::hash(&preimage).to_bytes();
        let rnd = u64::from_le_bytes(seed[0..8].try_into().unwrap());
        let button = (rnd % self.confirmed.len() as u64) as u8;
        (seed, button)
    }

    /// Submit settlement with a real signed price recoverable to `price_signer`.
    /// Seats are passed in the engine order recorded at lock; `payouts` indexed by
    /// engine_seat and must cover every confirmed seat.
    pub fn submit_settlement(
        &mut self,
        rake_collected: u64,
        payouts: Vec<SeatPayout>,
        price: u128,
    ) -> Result<(), String> {
        let m = self.match_account();
        let timestamp_ms = m.scheduled_end_ts * 1000;
        let signed_price = signed_price_dto(&PRICE_SIGNER_SECRET, PRICE_TOKEN, price, timestamp_ms);
        let args = SettleArgs {
            signed_price,
            rake_collected,
            payouts,
        };
        let (protocol, _) = protocol_pda();
        let mut accounts = vec![
            AccountMeta::new_readonly(self.admin.pubkey(), true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(self.match_key, false),
        ];
        let confirmed = self.confirmed.clone();
        for s in self.seat_pdas_of(&confirmed) {
            accounts.push(AccountMeta::new(s, false));
        }
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: ix_data("submit_settlement", &args),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    fn claim_like(&mut self, seat: usize, disc: &str) -> Result<(), String> {
        let player = self.players[seat].insecure_clone();
        let (seat_key, _) = seat_pda(&self.match_key, &player.pubkey());
        let (vault, _) = vault_pda(&self.match_key);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(player.pubkey(), true),
                AccountMeta::new(self.match_key, false),
                AccountMeta::new(seat_key, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(self.player_tokens[seat], false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
            data: anchor_discriminator(disc).to_vec(),
        };
        send(&mut self.svm, &player, vec![ix], &[])
    }

    /// Claim a settled seat's payout (closes the seat PDA).
    pub fn claim(&mut self, seat: usize) -> Result<(), String> {
        self.claim_like(seat, "claim")
    }

    /// Refund (voided confirmed seat, or unconfirmed candidate after lock).
    pub fn refund(&mut self, seat: usize) -> Result<(), String> {
        self.claim_like(seat, "refund")
    }

    /// Operator emergency void.
    pub fn void(&mut self) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
            ],
            data: anchor_discriminator("void").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    /// Permissionless pre-start void (Filling past fill_deadline, or Sealing past grace).
    pub fn void_before_start(&mut self) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(self.match_key, false)],
            data: anchor_discriminator("void_before_start").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    /// Permissionless LIVE void backstop (past scheduled_end + grace).
    pub fn void_live_after_deadline(&mut self) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![AccountMeta::new(self.match_key, false)],
            data: anchor_discriminator("void_live_after_deadline").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    /// Withdraw fees (confirmed entry fees + rake) to the treasury token account.
    pub fn withdraw_fees(&mut self, treasury_token: &Pubkey) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let (vault, _) = vault_pda(&self.match_key);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new_readonly(protocol, false),
                AccountMeta::new(self.match_key, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(*treasury_token, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
            data: anchor_discriminator("withdraw_fees").to_vec(),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    /// Create + fund a fresh treasury token account owned by `admin` (for withdraw_fees).
    pub fn new_treasury_token(&mut self) -> Pubkey {
        let token = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(165);
        let admin = self.admin.insecure_clone();
        let create = solana_sdk::system_instruction::create_account(
            &admin.pubkey(),
            &token.pubkey(),
            rent,
            165,
            &TOKEN_PROGRAM_ID,
        );
        let init = token_ix::initialize_account(
            &TOKEN_PROGRAM_ID,
            &token.pubkey(),
            &self.mint.pubkey(),
            &admin.pubkey(),
        )
        .unwrap();
        send(&mut self.svm, &admin, vec![create, init], &[&token]).expect("treasury token");
        token.pubkey()
    }
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
