package provider

import (
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/google/btree"
)

// bookBtreeDegree controls the B-tree branching factor. With degree 32 the
// branching factor is up to 64 children per node, which keeps a ~50k-level
// BTC-USD book at tree height ~3-4 and minimizes pointer chasing.
const bookBtreeDegree = 32

// priceLevel is one resting price level. priceF is the sort key; priceS is
// the original decimal string emitted by Coinbase and is preserved for BBO
// output so we don't lose precision through float64 round-tripping.
type priceLevel struct {
	priceF float64
	priceS string
	sizeS  string
}

// priceLess orders levels by numeric price, tie-breaking on the original decimal
// string. The tie-break prevents two genuinely distinct prices that round to the
// same float64 from colliding into a single btree key (which would silently drop a
// level); levels are equal only when both priceF and priceS match, matching the
// (priceF, priceS) key used by inserts and deletes.
func priceLess(a, b priceLevel) bool {
	if a.priceF != b.priceF {
		return a.priceF < b.priceF
	}
	return a.priceS < b.priceS
}

// L2Update is one row from a Coinbase Advanced Trade `l2_data` event.
type L2Update struct {
	Side        string
	PriceLevel  string
	NewQuantity string
}

// productBook holds the per-product bid and ask trees.
//
// Concurrency model: a single WS goroutine is the only writer. Readers do not
// touch these trees; they read the BBO via the lock-free atomic snapshot held
// by CoinbaseBookStore. The mutex exists so a concurrent Reset (rare, on
// reconnect) and Apply (steady state) cannot interleave.
type productBook struct {
	mu   sync.Mutex
	bids *btree.BTreeG[priceLevel]
	asks *btree.BTreeG[priceLevel]
}

func newProductBook() *productBook {
	return &productBook{
		bids: btree.NewG[priceLevel](bookBtreeDegree, priceLess),
		asks: btree.NewG[priceLevel](bookBtreeDegree, priceLess),
	}
}

// bboCache is the immutable top-of-book stored behind an atomic.Pointer so
// the 50 ms emitter tick reads without any synchronization.
type bboCache struct {
	bid string
	ask string
}

// CoinbaseBookStore maintains per-product order books for Coinbase Advanced
// Trade `level2` and exposes a lock-free BBO snapshot per product.
type CoinbaseBookStore struct {
	books sync.Map // product_id -> *productBook
	bbo   sync.Map // product_id -> *atomic.Pointer[bboCache]
}

// NewCoinbaseBookStore creates an empty store.
func NewCoinbaseBookStore() *CoinbaseBookStore {
	return &CoinbaseBookStore{}
}

// Reset installs a fresh book from a `snapshot` frame. Any previous book for
// this product is discarded atomically so readers never observe a half-built
// book.
func (s *CoinbaseBookStore) Reset(productID string, updates []L2Update) (bid, ask string, ok bool) {
	nb := newProductBook()
	for _, u := range updates {
		applyToBookLocked(nb, u)
	}
	s.books.Store(productID, nb)
	return s.publishBBO(productID, nb)
}

// Apply applies an `update` frame to the existing book. Frames received before
// the first snapshot are dropped (ok=false).
func (s *CoinbaseBookStore) Apply(productID string, updates []L2Update) (bid, ask string, ok bool) {
	v, found := s.books.Load(productID)
	if !found {
		return "", "", false
	}
	book := v.(*productBook)
	book.mu.Lock()
	for _, u := range updates {
		applyToBookLocked(book, u)
	}
	book.mu.Unlock()
	return s.publishBBO(productID, book)
}

// BestBidAsk returns the latest atomic BBO snapshot for a product.
func (s *CoinbaseBookStore) BestBidAsk(productID string) (bid, ask string, ok bool) {
	p := s.bboPointer(productID, false)
	if p == nil {
		return "", "", false
	}
	c := p.Load()
	if c == nil || c.bid == "" || c.ask == "" {
		return "", "", false
	}
	return c.bid, c.ask, true
}

// LevelCounts returns the current depth on each side. Intended for metrics.
func (s *CoinbaseBookStore) LevelCounts(productID string) (bids, asks int, ok bool) {
	v, found := s.books.Load(productID)
	if !found {
		return 0, 0, false
	}
	book := v.(*productBook)
	book.mu.Lock()
	bids = book.bids.Len()
	asks = book.asks.Len()
	book.mu.Unlock()
	return bids, asks, true
}

// applyToBookLocked mutates `book` in place. Callers must hold book.mu, except
// during Reset where the book is goroutine-local and not yet published.
func applyToBookLocked(book *productBook, u L2Update) {
	pf, err := strconv.ParseFloat(u.PriceLevel, 64)
	if err != nil || pf <= 0 {
		return
	}
	var tree *btree.BTreeG[priceLevel]
	switch u.Side {
	case "bid":
		tree = book.bids
	case "offer", "ask":
		tree = book.asks
	default:
		return
	}
	key := priceLevel{priceF: pf, priceS: u.PriceLevel}
	sz, err := strconv.ParseFloat(u.NewQuantity, 64)
	if err != nil || sz <= 0 {
		tree.Delete(key)
		return
	}
	key.sizeS = u.NewQuantity
	tree.ReplaceOrInsert(key)
}

// publishBBO computes the current top-of-book and stores it behind the atomic
// pointer for the product. Returns (bid, ask, ok) so callers can also push
// directly to bbo.SnapshotStore.
func (s *CoinbaseBookStore) publishBBO(productID string, book *productBook) (string, string, bool) {
	book.mu.Lock()
	bidTop, bidOK := book.bids.Max()
	askTop, askOK := book.asks.Min()
	book.mu.Unlock()
	if !bidOK || !askOK {
		return "", "", false
	}
	c := &bboCache{bid: bidTop.priceS, ask: askTop.priceS}
	s.bboPointer(productID, true).Store(c)
	return c.bid, c.ask, true
}

func (s *CoinbaseBookStore) bboPointer(productID string, create bool) *atomic.Pointer[bboCache] {
	if v, ok := s.bbo.Load(productID); ok {
		return v.(*atomic.Pointer[bboCache])
	}
	if !create {
		return nil
	}
	fresh := &atomic.Pointer[bboCache]{}
	actual, _ := s.bbo.LoadOrStore(productID, fresh)
	return actual.(*atomic.Pointer[bboCache])
}
