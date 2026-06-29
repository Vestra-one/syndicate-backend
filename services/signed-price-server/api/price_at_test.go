package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/signing"
	"github.com/syndicate/backend/services/signed-price-server/store"
)

func TestPriceAtReturnsExactArchivedPrice(t *testing.T) {
	priceStore, err := store.NewSignedPriceStoreWithArchive(16, filepath.Join(t.TempDir(), "prices.sqlite"))
	if err != nil {
		t.Fatalf("new archive store: %v", err)
	}
	defer priceStore.Close()

	priceStore.Store(signing.SignedPrice{
		Token:      "0xa7BaE7da3E4950700BE9f107EB186e89a474d180",
		Symbol:     "BTCUSD",
		Price:      "100000",
		PriceInWad: "100000000000000000000000",
		Timestamp:  1_715_000_000_123,
		V:          27,
		R:          "0x11",
		S:          "0x22",
		SignedAt:   1_715_000_000_124,
	})

	server := &Server{store: priceStore, logger: zerolog.Nop()}
	req := httptest.NewRequest(http.MethodGet, "/prices/at?symbol=BTCUSD&timestamp=1715000000", nil)
	rr := httptest.NewRecorder()
	server.handlePriceAt(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Price signing.SignedPrice `json:"price"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Price.Timestamp != 1_715_000_000_123 {
		t.Fatalf("unexpected price timestamp: %d", body.Price.Timestamp)
	}
}

func TestPriceAtMissingTimestampReturns404(t *testing.T) {
	priceStore, err := store.NewSignedPriceStoreWithArchive(16, filepath.Join(t.TempDir(), "prices.sqlite"))
	if err != nil {
		t.Fatalf("new archive store: %v", err)
	}
	defer priceStore.Close()

	server := &Server{store: priceStore, logger: zerolog.Nop()}
	req := httptest.NewRequest(http.MethodGet, "/prices/at?symbol=BTCUSD&timestamp=1715000000", nil)
	rr := httptest.NewRecorder()
	server.handlePriceAt(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestPriceAtInvalidQueryReturns400(t *testing.T) {
	server := &Server{store: store.NewSignedPriceStore(16), logger: zerolog.Nop()}
	req := httptest.NewRequest(http.MethodGet, "/prices/at?symbol=&timestamp=not-a-number", nil)
	rr := httptest.NewRecorder()
	server.handlePriceAt(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
}
