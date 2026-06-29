package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/syndicate/backend/services/signed-price-server/signing"
	_ "modernc.org/sqlite"
)

// SignedPriceStore stores signed prices with O(1) lookups and timestamp ordering
type SignedPriceStore struct {
	latest  sync.Map // map[string]*priceEntry - latest price per symbol with timestamp
	history *RingBuffer
	archive *sql.DB

	// Metrics
	staleRejected atomic.Uint64 // Count of rejected stale prices
	accepted      atomic.Uint64 // Count of accepted prices
}

// priceEntry holds a price with its timestamp for ordering validation
type priceEntry struct {
	price     signing.SignedPrice
	timestamp int64 // Cache timestamp for fast comparison
}

// NewSignedPriceStore creates a new store
func NewSignedPriceStore(historySize int) *SignedPriceStore {
	return &SignedPriceStore{
		history: NewRingBuffer(historySize),
	}
}

// NewSignedPriceStoreWithArchive creates a store with durable per-second lookup.
func NewSignedPriceStoreWithArchive(historySize int, sqlitePath string) (*SignedPriceStore, error) {
	store := NewSignedPriceStore(historySize)
	if sqlitePath == "" {
		return store, nil
	}
	db, err := openArchive(sqlitePath)
	if err != nil {
		return nil, err
	}
	store.archive = db
	return store, nil
}

// Store stores a signed price ONLY if it's newer than existing price
// Returns true if stored, false if rejected as stale
func (s *SignedPriceStore) Store(price signing.SignedPrice) bool {
	_ = s.storeSecondBucket(price)

	symbol := price.Symbol
	newTimestamp := price.Timestamp

	// Try to load existing price
	entry := &priceEntry{
		price:     price,
		timestamp: newTimestamp,
	}

	for {
		existing, loaded := s.latest.Load(symbol)

		if !loaded {
			// No existing price - try to store
			if _, loaded := s.latest.LoadOrStore(symbol, entry); !loaded {
				// Successfully stored
				s.history.Add(price)
				s.accepted.Add(1)
				return true
			}
			// Someone else stored first, retry
			continue
		}

		// Compare timestamps
		oldEntry := existing.(*priceEntry)
		oldTimestamp := oldEntry.timestamp

		if newTimestamp <= oldTimestamp {
			// Stale or duplicate - reject
			s.staleRejected.Add(1)
			return false
		}

		// New price is newer - try to swap
		if s.latest.CompareAndSwap(symbol, existing, entry) {
			// Successfully updated
			s.history.Add(price)
			s.accepted.Add(1)
			return true
		}
		// CAS failed, someone else updated, retry
	}
}

// GetLatest gets the latest price for a symbol
func (s *SignedPriceStore) GetLatest(symbol string) (signing.SignedPrice, bool) {
	val, ok := s.latest.Load(symbol)
	if !ok {
		return signing.SignedPrice{}, false
	}
	entry := val.(*priceEntry)
	return entry.price, true
}

// GetAll gets all latest prices
func (s *SignedPriceStore) GetAll() []signing.SignedPrice {
	prices := []signing.SignedPrice{}
	s.latest.Range(func(key, value interface{}) bool {
		entry := value.(*priceEntry)
		prices = append(prices, entry.price)
		return true
	})
	return prices
}

// GetHistory gets recent price history
func (s *SignedPriceStore) GetHistory(limit int) []signing.SignedPrice {
	return s.history.GetRecent(limit)
}

// GetMetrics returns store metrics
func (s *SignedPriceStore) GetMetrics() (accepted, staleRejected uint64) {
	return s.accepted.Load(), s.staleRejected.Load()
}

// GetLatestTimestamp returns the latest timestamp for a symbol (for debugging/testing)
func (s *SignedPriceStore) GetLatestTimestamp(symbol string) (int64, bool) {
	val, ok := s.latest.Load(symbol)
	if !ok {
		return 0, false
	}
	entry := val.(*priceEntry)
	return entry.timestamp, true
}

// GetAt returns the durable signed price for an exact Unix second.
func (s *SignedPriceStore) GetAt(symbol string, timestampSec int64) (signing.SignedPrice, bool, error) {
	if s.archive == nil {
		return signing.SignedPrice{}, false, nil
	}
	var payload string
	err := s.archive.QueryRow(
		`SELECT price_json FROM signed_price_seconds WHERE symbol = ? AND timestamp_sec = ?`,
		symbol,
		timestampSec,
	).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return signing.SignedPrice{}, false, nil
	}
	if err != nil {
		return signing.SignedPrice{}, false, err
	}
	var price signing.SignedPrice
	if err := json.Unmarshal([]byte(payload), &price); err != nil {
		return signing.SignedPrice{}, false, err
	}
	return price, true, nil
}

func (s *SignedPriceStore) Close() error {
	if s.archive == nil {
		return nil
	}
	return s.archive.Close()
}

func (s *SignedPriceStore) storeSecondBucket(price signing.SignedPrice) error {
	if s.archive == nil || price.Symbol == "" || price.Timestamp <= 0 {
		return nil
	}
	payload, err := json.Marshal(price)
	if err != nil {
		return err
	}
	_, err = s.archive.Exec(
		`INSERT INTO signed_price_seconds (
			symbol, timestamp_sec, payload_timestamp_ms, signed_at_ms, price_json
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(symbol, timestamp_sec) DO UPDATE SET
			payload_timestamp_ms = excluded.payload_timestamp_ms,
			signed_at_ms = excluded.signed_at_ms,
			price_json = excluded.price_json
		WHERE excluded.payload_timestamp_ms > signed_price_seconds.payload_timestamp_ms
			OR (
				excluded.payload_timestamp_ms = signed_price_seconds.payload_timestamp_ms
				AND excluded.signed_at_ms > signed_price_seconds.signed_at_ms
			)`,
		price.Symbol,
		price.Timestamp/1000,
		price.Timestamp,
		price.SignedAt,
		string(payload),
	)
	return err
}

func openArchive(sqlitePath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(sqlitePath), 0o755); err != nil {
		return nil, fmt.Errorf("create signed price archive dir: %w", err)
	}
	db, err := sql.Open("sqlite", sqlitePath)
	if err != nil {
		return nil, fmt.Errorf("open signed price archive: %w", err)
	}
	if _, err := db.Exec(`PRAGMA journal_mode = WAL`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("set busy timeout: %w", err)
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS signed_price_seconds (
		symbol TEXT NOT NULL,
		timestamp_sec INTEGER NOT NULL,
		payload_timestamp_ms INTEGER NOT NULL,
		signed_at_ms INTEGER NOT NULL,
		price_json TEXT NOT NULL,
		PRIMARY KEY(symbol, timestamp_sec)
	)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create signed price archive schema: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_signed_price_seconds_symbol_time
		ON signed_price_seconds(symbol, timestamp_sec)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create signed price archive index: %w", err)
	}
	return db, nil
}
