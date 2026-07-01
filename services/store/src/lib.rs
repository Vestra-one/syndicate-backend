//! # syndicate-store — append-only, hash-chained event store
//!
//! Real persistence for the authoritative match log (`ARCHITECTURE.md §4`,
//! `06 §4`). The match engine is event-sourced: every signed action/intent is
//! appended here, and recovery = replay. The store is **tamper-evident** — each record
//! is chained `hash_i = sha256(hash_{i-1} || payload_i)` (genesis = 32 zero bytes), and
//! loading re-derives the chain and rejects any modification.
//!
//! Production persistence is Postgres-first and defined by [`POSTGRES_SCHEMA_V1`].
//! The two Rust backends here remain useful for unit tests and single-process local
//! fixtures: [`InMemoryStore`] (ephemeral) and [`FileStore`] (fsync'd local file).
//! Records are opaque bytes — serialization of the action is the caller's concern,
//! keeping this layer reusable and dependency-light.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub mod postgres;
pub mod registry;
pub mod schema;

pub use postgres::{
    ACQUIRE_MATCH_LEASE_SQL, ADVANCE_READ_MODEL_CHECKPOINT_SQL, APPEND_MATCH_EVENT_WITH_OUTBOX_SQL,
    ATTACH_CONFIG_HASH_BY_FEED_SQL, CLAIM_SETTLEMENT_OUTBOX_SQL, ENQUEUE_SETTLEMENT_REQUEST_SQL,
    INSERT_MATCH_CONFIG_SQL, INSERT_MATCH_SEAT_SQL,
    INSERT_MATCH_SNAPSHOT_SQL, INSERT_MATCH_SQL, INSERT_REPLAY_BUNDLE_SQL,
    SELECT_CONFIG_ID_BY_HASH_SQL,
    UPSERT_MATCH_CONFIG_BY_HASH_SQL,
    INSERT_SETTLEMENT_DEAD_LETTER_SQL, INSERT_VAULT_RECONCILIATION_SQL,
    LIST_DUE_SETTLEMENT_ATTEMPTS_SQL, LOAD_ALL_MATCH_EVENTS_SQL, LOAD_LATEST_MATCH_SNAPSHOT_SQL,
    LOAD_MATCH_EVENTS_AFTER_SQL, LOAD_MATCH_SEATS_SQL, LOAD_MATCH_SETTLEMENT_CONTEXT_SQL,
    LOAD_SETTLEMENT_ATTEMPT_SQL, LOCK_SETTLEMENT_ATTEMPT_SQL, MARK_MATCH_TERMINAL_SQL,
    MARK_OUTBOX_DEAD_LETTER_SQL, MARK_OUTBOX_PUBLISHED_SQL, MARK_OUTBOX_RETRY_SQL,
    MARK_SETTLEMENT_CONFIRMED_SQL, MARK_SETTLEMENT_DEAD_LETTER_SQL, MARK_SETTLEMENT_RETRY_SQL,
    MARK_SETTLEMENT_SUBMITTED_SQL, MARK_SETTLEMENT_VOIDED_SQL, PersistedMatchRow,
    PersistedMatchSeat, RENEW_MATCH_LEASE_SQL, UPDATE_MATCH_ON_BEGIN_LIVE_SQL, UPSERT_LIVE_GAME_SQL,
    UPSERT_MATCH_HISTORY_SQL, UPSERT_PROFILE_STATS_SQL, UPSERT_SETTLEMENT_ATTEMPT_SQL,
};
pub use registry::{
    unix_to_datetime, BeginLiveParams, InsertMatchParams, MatchRegistryStore, RegistryError,
};
pub use schema::POSTGRES_SCHEMA_V1;

pub const GENESIS: [u8; 32] = [0u8; 32];

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    /// The persisted chain does not validate — data was modified/corrupted.
    ChainBroken {
        seq: u64,
    },
    /// A persisted line was malformed.
    Corrupt(String),
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

/// Metadata returned when a record is appended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordMeta {
    pub seq: u64,
    pub hash: [u8; 32],
}

/// Compute the next chain hash from the previous head and a payload.
pub fn chain(prev: &[u8; 32], payload: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(prev);
    h.update(payload);
    let out = h.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

/// Append-only, tamper-evident log.
pub trait Store {
    fn append(&mut self, payload: &[u8]) -> Result<RecordMeta, StoreError>;
    /// All payloads in order (after verifying the chain).
    fn load(&self) -> Result<Vec<Vec<u8>>, StoreError>;
    /// Current head hash (root of the chain so far).
    fn head(&self) -> [u8; 32];
    fn len(&self) -> u64;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Re-derive and validate the whole chain.
    fn verify(&self) -> Result<(), StoreError>;
}

// ---------------- In-memory ----------------

#[derive(Default)]
pub struct InMemoryStore {
    payloads: Vec<Vec<u8>>,
    hashes: Vec<[u8; 32]>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Store for InMemoryStore {
    fn append(&mut self, payload: &[u8]) -> Result<RecordMeta, StoreError> {
        let prev = self.head();
        let hash = chain(&prev, payload);
        self.payloads.push(payload.to_vec());
        self.hashes.push(hash);
        Ok(RecordMeta {
            seq: (self.payloads.len() - 1) as u64,
            hash,
        })
    }
    fn load(&self) -> Result<Vec<Vec<u8>>, StoreError> {
        self.verify()?;
        Ok(self.payloads.clone())
    }
    fn head(&self) -> [u8; 32] {
        *self.hashes.last().unwrap_or(&GENESIS)
    }
    fn len(&self) -> u64 {
        self.payloads.len() as u64
    }
    fn verify(&self) -> Result<(), StoreError> {
        let mut prev = GENESIS;
        for (i, p) in self.payloads.iter().enumerate() {
            let expect = chain(&prev, p);
            if expect != self.hashes[i] {
                return Err(StoreError::ChainBroken { seq: i as u64 });
            }
            prev = expect;
        }
        Ok(())
    }
}

// ---------------- File-backed ----------------

/// Durable append-only store. On-disk format is one record per line:
/// `seq \t hex(payload) \t hex(hash)`. On open, the chain is re-derived and validated.
#[derive(Debug)]
pub struct FileStore {
    path: PathBuf,
    head: [u8; 32],
    count: u64,
}

impl FileStore {
    /// Open (or create) a store at `path`, verifying any existing chain.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let mut store = FileStore {
            path: path.clone(),
            head: GENESIS,
            count: 0,
        };
        if path.exists() {
            let (payloads, head) = read_and_verify(&path)?;
            store.head = head;
            store.count = payloads.len() as u64;
        } else {
            File::create(&path)?;
        }
        Ok(store)
    }
}

fn read_and_verify(path: &Path) -> Result<(Vec<Vec<u8>>, [u8; 32]), StoreError> {
    let f = File::open(path)?;
    let reader = BufReader::new(f);
    let mut payloads = Vec::new();
    let mut prev = GENESIS;
    for (i, line) in reader.lines().enumerate() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let _seq = parts
            .next()
            .ok_or_else(|| StoreError::Corrupt("missing seq".into()))?;
        let payload_hex = parts
            .next()
            .ok_or_else(|| StoreError::Corrupt("missing payload".into()))?;
        let hash_hex = parts
            .next()
            .ok_or_else(|| StoreError::Corrupt("missing hash".into()))?;
        let payload =
            from_hex(payload_hex).ok_or_else(|| StoreError::Corrupt("bad payload hex".into()))?;
        let stored_hash =
            from_hex(hash_hex).ok_or_else(|| StoreError::Corrupt("bad hash hex".into()))?;
        let expect = chain(&prev, &payload);
        if stored_hash.as_slice() != expect.as_slice() {
            return Err(StoreError::ChainBroken { seq: i as u64 });
        }
        prev = expect;
        payloads.push(payload);
    }
    Ok((payloads, prev))
}

impl Store for FileStore {
    fn append(&mut self, payload: &[u8]) -> Result<RecordMeta, StoreError> {
        let hash = chain(&self.head, payload);
        let seq = self.count;
        let line = format!("{}\t{}\t{}\n", seq, to_hex(payload), to_hex(&hash));
        let mut f = OpenOptions::new().append(true).open(&self.path)?;
        f.write_all(line.as_bytes())?;
        f.sync_all()?; // durability: fsync each record
        self.head = hash;
        self.count += 1;
        Ok(RecordMeta { seq, hash })
    }
    fn load(&self) -> Result<Vec<Vec<u8>>, StoreError> {
        let (payloads, _head) = read_and_verify(&self.path)?;
        Ok(payloads)
    }
    fn head(&self) -> [u8; 32] {
        self.head
    }
    fn len(&self) -> u64 {
        self.count
    }
    fn verify(&self) -> Result<(), StoreError> {
        read_and_verify(&self.path).map(|_| ())
    }
}

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_append_load_and_head_chain() {
        let mut s = InMemoryStore::new();
        let m0 = s.append(b"action-0").unwrap();
        let m1 = s.append(b"action-1").unwrap();
        assert_eq!(m0.seq, 0);
        assert_eq!(m1.seq, 1);
        assert_eq!(s.head(), m1.hash);
        assert_eq!(m1.hash, chain(&m0.hash, b"action-1"));
        assert_eq!(
            s.load().unwrap(),
            vec![b"action-0".to_vec(), b"action-1".to_vec()]
        );
        s.verify().unwrap();
    }

    #[test]
    fn in_memory_detects_tamper() {
        let mut s = InMemoryStore::new();
        s.append(b"a").unwrap();
        s.append(b"b").unwrap();
        s.payloads[0] = b"tampered".to_vec(); // mutate a recorded payload
        assert!(matches!(
            s.verify(),
            Err(StoreError::ChainBroken { seq: 0 })
        ));
    }

    #[test]
    fn file_store_persists_and_replays_across_reopen() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("synd-store-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);

        {
            let mut s = FileStore::open(&path).unwrap();
            s.append(b"deposit").unwrap();
            s.append(b"bet:50").unwrap();
            s.append(b"fold").unwrap();
            assert_eq!(s.len(), 3);
        }
        // Reopen: chain re-verified, payloads replayable.
        let s2 = FileStore::open(&path).unwrap();
        assert_eq!(s2.len(), 3);
        assert_eq!(
            s2.load().unwrap(),
            vec![b"deposit".to_vec(), b"bet:50".to_vec(), b"fold".to_vec()]
        );
        let head_before = s2.head();
        // Continue appending after reopen; chain extends from the persisted head.
        let mut s3 = FileStore::open(&path).unwrap();
        let m = s3.append(b"all-in").unwrap();
        assert_eq!(m.hash, chain(&head_before, b"all-in"));

        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn file_store_detects_on_disk_tamper() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("synd-store-tamper-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut s = FileStore::open(&path).unwrap();
            s.append(b"honest-0").unwrap();
            s.append(b"honest-1").unwrap();
        }
        // Corrupt the first record's payload hex in place (keep structure).
        let content = std::fs::read_to_string(&path).unwrap();
        let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
        let parts: Vec<&str> = lines[0].split('\t').collect();
        lines[0] = format!("{}\t{}\t{}", parts[0], to_hex(b"evil"), parts[2]);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        let err = FileStore::open(&path).unwrap_err();
        assert!(matches!(err, StoreError::ChainBroken { .. }));
        std::fs::remove_file(&path).unwrap();
    }
}
