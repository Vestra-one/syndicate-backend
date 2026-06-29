package bbo

import (
	"sync"
	"time"
)

// Key identifies a top-of-book snapshot (provider + USD-facing symbol e.g. BTCUSD).
type Key struct {
	Provider string
	Symbol   string
}

func (k Key) String() string {
	return k.Provider + "|" + k.Symbol
}

type entry struct {
	bid           string
	ask           string
	bookUpdatedAt time.Time
	ready         bool
}

// SnapshotStore holds latest best bid/ask per symbol for book_mid mode.
type SnapshotStore struct {
	mu      sync.RWMutex
	entries map[string]*entry

	// changeCh, if set, receives the Key on every Update where bid or ask
	// changed. Sends are non-blocking: a full channel drops the notification
	// (the heartbeat still re-signs), so a slow consumer never stalls ingest.
	changeCh chan<- Key
}

// NewSnapshotStore creates an empty BBO store.
func NewSnapshotStore() *SnapshotStore {
	return &SnapshotStore{
		entries: make(map[string]*entry),
	}
}

// SetChangeListener registers a channel that receives a Key whenever that key's
// bid or ask changes. Used by the book_mid emitter for event-driven emits in
// addition to the heartbeat. Pass nil to disable.
func (s *SnapshotStore) SetChangeListener(ch chan<- Key) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.changeCh = ch
}

func (s *SnapshotStore) key(k Key) string {
	return k.String()
}

// Update stores bid/ask and refreshes bookUpdatedAt to now.
func (s *SnapshotStore) Update(k Key, bid, ask string) {
	s.mu.Lock()
	key := s.key(k)
	e, ok := s.entries[key]
	if !ok {
		e = &entry{}
		s.entries[key] = e
	}
	changed := !e.ready || e.bid != bid || e.ask != ask
	e.bid = bid
	e.ask = ask
	e.bookUpdatedAt = time.Now()
	e.ready = true
	ch := s.changeCh
	s.mu.Unlock()

	if changed && ch != nil {
		select {
		case ch <- k:
		default:
		}
	}
}

// Snapshot returns the latest BBO for key.
func (s *SnapshotStore) Snapshot(k Key) (bid, ask string, bookUpdatedAt time.Time, ready bool, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, found := s.entries[s.key(k)]
	if !found || !e.ready {
		return "", "", time.Time{}, false, false
	}
	return e.bid, e.ask, e.bookUpdatedAt, true, true
}

// IsFresh reports whether the book was updated within maxAge.
func (s *SnapshotStore) IsFresh(k Key, maxAge time.Duration) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, found := s.entries[s.key(k)]
	if !found || !e.ready {
		return false
	}
	return time.Since(e.bookUpdatedAt) <= maxAge
}

// HealthStatus is exposed via /health for one book_mid symbol.
type HealthStatus struct {
	Ready          bool   `json:"ready"`
	Paused         bool   `json:"paused"`
	BookAgeMs      int64  `json:"book_age_ms"`
	LastBookUpdate string `json:"last_book_update,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

// HealthReport returns per-symbol status for the given keys and max book age.
// startedAt enables startup grace: symbols without a first BBO update within maxBookAge
// of process start are reported as starting_up (not paused).
func (s *SnapshotStore) HealthReport(keys []Key, maxBookAge time.Duration, startedAt time.Time) map[string]HealthStatus {
	out := make(map[string]HealthStatus, len(keys))
	now := time.Now()
	uptime := now.Sub(startedAt)
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, k := range keys {
		sym := k.Symbol
		e, found := s.entries[s.key(k)]
		out[sym] = healthStatusForEntry(e, found, now, uptime, maxBookAge)
	}
	return out
}

func healthStatusForEntry(e *entry, found bool, now time.Time, uptime, maxBookAge time.Duration) HealthStatus {
	st := HealthStatus{}
	if !found || !e.ready {
		st.Ready = false
		if uptime < maxBookAge {
			st.Paused = false
			st.Reason = "starting_up"
			return st
		}
		st.Paused = true
		st.Reason = "not_ready"
		return st
	}
	age := now.Sub(e.bookUpdatedAt)
	st.Ready = true
	st.BookAgeMs = age.Milliseconds()
	st.LastBookUpdate = e.bookUpdatedAt.UTC().Format(time.RFC3339Nano)
	if age > maxBookAge {
		st.Paused = true
		st.Reason = "book_stale"
	}
	return st
}

// AnyPaused returns true if any key in keys should block book_mid emission health.
func (s *SnapshotStore) AnyPaused(keys []Key, maxBookAge time.Duration, startedAt time.Time) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now()
	uptime := now.Sub(startedAt)
	for _, k := range keys {
		e, found := s.entries[s.key(k)]
		if !found || !e.ready {
			if uptime < maxBookAge {
				continue
			}
			return true
		}
		if now.Sub(e.bookUpdatedAt) > maxBookAge {
			return true
		}
	}
	return false
}
