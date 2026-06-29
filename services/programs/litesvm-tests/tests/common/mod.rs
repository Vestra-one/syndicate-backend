//! Standalone litesvm harness (no Anchor host dependency — loads the built `.so` directly).

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
use syndicate_shared::intent::{action_intent_message, default_policy_message};
use types::{
    BeginLiveArgs, CreateParams, ProtocolRoles, RegisterPredictionCommitmentArgs, SettleArgs,
    SignedPriceDto,
};
// Re-exported for use by the test modules.
pub use types::{MatchAccountData, SeatAccountData, SeatPayout};

#[allow(unused_imports)]
pub use types::DEFAULT_TAG_CHECK_FOLD;
#[allow(unused_imports)]
pub use syndicate_engine_core::GENESIS_HEAD;

pub const PROGRAM_ID: Pubkey = pubkey!("8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX");
pub const TOKEN_PROGRAM_ID: Pubkey = spl_token::ID;
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

pub const MATCH_ID: u64 = 1;
pub const BUY_IN: u64 = 100;
pub const ENTRY_FEE: u64 = 0;
pub const SB: u64 = 1;
pub const BB: u64 = 2;

/// 20-byte token/feed id used by the harness (matches `price_token` in `create_match`).
pub const PRICE_TOKEN: [u8; 20] = [7u8; 20];

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
/// protocol `price_signer`, so the test holds the private half and can produce a real
/// recoverable EIP-191 signature for the settlement signed-price path (full fidelity —
/// no stub at the `verify_signed_price` boundary). Non-zero, valid scalar < curve order.
pub const PRICE_SIGNER_SECRET: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01,
    0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x20,
];

/// 20-byte Ethereum address = last 20 bytes of keccak256(uncompressed-pubkey[1..]).
pub fn eth_address_of_secret(secret: &[u8; 32]) -> [u8; 20] {
    let sk = libsecp256k1::SecretKey::parse(secret).expect("valid secp256k1 secret");
    let pk = libsecp256k1::PublicKey::from_secret_key(&sk);
    // serialize() = 0x04 || X(32) || Y(32); Ethereum hashes the 64-byte X||Y.
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
    let sig_bytes = sig.serialize(); // 64 bytes r||s
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&sig_bytes[..32]);
    s.copy_from_slice(&sig_bytes[32..]);
    SignedPriceDto {
        token,
        price_in_wad,
        timestamp_ms,
        v: rec.serialize() + 27, // EIP-191 v in {27, 28}
        r,
        s,
    }
}

/// Per-match economics knobs for building harnesses in arbitrary terminal states.
#[derive(Clone, Copy)]
pub struct MatchConfig {
    pub match_id: u64,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub nonseal_penalty_bps: u32,
    pub min_players: u8,
    pub max_players: u8,
    pub num_players: usize,
    pub fill_deadline_ts: u64,
}

impl Default for MatchConfig {
    fn default() -> Self {
        Self {
            match_id: MATCH_ID,
            buy_in: BUY_IN,
            entry_fee: ENTRY_FEE,
            rake_bps: 0,
            rake_cap: 0,
            nonseal_penalty_bps: 0,
            min_players: 2,
            max_players: 5,
            num_players: 3,
            fill_deadline_ts: 9_999_999_999,
        }
    }
}

pub struct MatchHarness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub players: [Keypair; 3],
    pub mint: Keypair,
    pub match_key: Pubkey,
    pub player_tokens: [Pubkey; 3],
    pub cfg: MatchConfig,
}

impl MatchHarness {
    pub fn new() -> Self {
        let mut h = Self::bare(MatchConfig::default());
        h.create_match();
        h.deposit_all();
        h.lock_match();
        h
    }

    /// Build a harness up to (but not including) `create_match`, leaving lifecycle steps
    /// to the caller so terminal-state matrix rows can drive any path.
    pub fn bare(cfg: MatchConfig) -> Self {
        assert!(cfg.num_players <= 3, "harness has 3 player keypairs");
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
            cfg,
        };
        h.init_mint();
        h.init_protocol();
        h
    }

    /// Players actually seated in this match.
    pub fn seated(&self) -> &[Keypair] {
        &self.players[..self.cfg.num_players]
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
        // SPL token account: amount is u64 LE at offset 64.
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
            price_signer: eth_address_of_secret(&PRICE_SIGNER_SECRET),
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

    pub fn create_match(&mut self) {
        let (protocol, _) = protocol_pda();
        let (match_key, _) = match_pda(self.cfg.match_id);
        let (vault, _) = vault_pda(&match_key);
        self.match_key = match_key;
        let params = CreateParams {
            match_id: self.cfg.match_id,
            buy_in: self.cfg.buy_in,
            entry_fee: self.cfg.entry_fee,
            rake_bps: self.cfg.rake_bps,
            rake_cap: self.cfg.rake_cap,
            nonseal_penalty_bps: self.cfg.nonseal_penalty_bps,
            min_players: self.cfg.min_players,
            max_players: self.cfg.max_players,
            config_hash: [1u8; 32],
            price_token: PRICE_TOKEN,
            total_betting_duration_sec: 600,
            seal_window_sec: 20,
            begin_live_window_sec: 5,
            fill_deadline_ts: self.cfg.fill_deadline_ts,
            max_oracle_confidence: 100,
            oracle_exponent: -18,
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

    pub fn deposit_all(&mut self) {
        let buy_in = self.cfg.buy_in;
        let entry_fee = self.cfg.entry_fee;
        let num = self.cfg.num_players;
        for seat in 0..num {
            let player = self.players[seat].insecure_clone();
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
            send(&mut self.svm, &player, vec![create, init], &[&token]).expect("init player token");
            let mint_to = token_ix::mint_to(
                &TOKEN_PROGRAM_ID,
                &self.mint.pubkey(),
                &token.pubkey(),
                &self.admin.pubkey(),
                &[],
                buy_in + entry_fee + 1_000,
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
            send(&mut self.svm, &player, vec![ix], &[]).expect("deposit");
        }
    }

    pub fn lock_match(&mut self) {
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
    }

    // ---- Lifecycle helpers (matrix-driving) ----------------------------------------

    /// Seal a seated player's prediction commitment during Sealing.
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
    /// `(latest_match_end, latest_match_end + MAX_TIMELOCK_SKEW_SEC]`. Uses the live
    /// match account's timing so it is always valid at call time.
    pub fn valid_timelock_target(&self) -> u64 {
        let m = self.match_account();
        let latest_match_end =
            m.seal_deadline_ts + m.total_betting_duration_sec + m.begin_live_window_sec;
        // round * 3 + GENESIS > latest_match_end  =>  round > (latest - GENESIS)/3
        const GENESIS: u64 = 1_692_803_367;
        const PERIOD: u64 = 3;
        let mut round = (latest_match_end.saturating_sub(GENESIS)) / PERIOD + 1;
        // bump until strictly after latest_match_end
        while GENESIS + round * PERIOD <= latest_match_end {
            round += 1;
        }
        round
    }

    /// Seat PDAs of seated players (the `remaining_accounts` set for begin_live).
    pub fn seated_seat_pdas(&self) -> Vec<Pubkey> {
        (0..self.cfg.num_players)
            .map(|i| seat_pda(&self.match_key, &self.players[i].pubkey()).0)
            .collect()
    }

    /// Advance Sealing → Live (or UnderMinSealed VOID). Passes every seated seat as a
    /// writable `remaining_account`.
    pub fn begin_live(&mut self, button_randomness: [u8; 32]) -> Result<(), String> {
        let (protocol, _) = protocol_pda();
        let mut accounts = vec![
            AccountMeta::new_readonly(self.admin.pubkey(), true),
            AccountMeta::new_readonly(protocol, false),
            AccountMeta::new(self.match_key, false),
        ];
        for s in self.seated_seat_pdas() {
            accounts.push(AccountMeta::new(s, false));
        }
        let args = BeginLiveArgs { button_randomness };
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts,
            data: ix_data("begin_live", &args),
        };
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &admin, vec![ix], &[])
    }

    /// Submit settlement with a real signed price recoverable to `price_signer`. The
    /// price timestamp_ms is `scheduled_end_ts * 1000` so `publish_time == scheduled_end_ts`.
    /// `sealed_seats` are the seat indices (deposit-time) of sealers passed as
    /// `remaining_accounts`; `payouts` are indexed by engine_seat.
    pub fn submit_settlement(
        &mut self,
        sealed_seats: &[usize],
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
        for &s in sealed_seats {
            let pk = seat_pda(&self.match_key, &self.players[s].pubkey()).0;
            accounts.push(AccountMeta::new(pk, false));
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
        let seat_index = self.seat_account(seat).seat_index;
        let (seat_index_key, _) = seat_index_pda(&self.match_key, seat_index);
        let (vault, _) = vault_pda(&self.match_key);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(player.pubkey(), true),
                AccountMeta::new(self.match_key, false),
                AccountMeta::new(seat_key, false),
                AccountMeta::new(seat_index_key, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(self.player_tokens[seat], false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
            data: anchor_discriminator(disc).to_vec(),
        };
        send(&mut self.svm, &player, vec![ix], &[])
    }

    /// Claim a settled seat's payout (closes seat + seat-index PDAs).
    pub fn claim(&mut self, seat: usize) -> Result<(), String> {
        self.claim_like(seat, "claim")
    }

    /// Refund a voided seat (closes seat + seat-index PDAs). Same account layout as claim.
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

    /// Withdraw fees (rake + forfeited entry fees) to the treasury token account.
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
