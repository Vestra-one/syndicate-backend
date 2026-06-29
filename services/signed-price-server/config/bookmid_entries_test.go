package config

import (
	"testing"

	"github.com/syndicate/backend/services/signed-price-server/provider"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

func TestBookMidEntries(t *testing.T) {
	t.Parallel()
	c := Config{
		CurrencyPairs: []CurrencyPair{{
			Base:      "BTC",
			Quote:     "USDT",
			Token:     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
			Providers: []types.ProviderName{provider.ProviderBinance},
			ProviderPriceModes: map[string]string{
				"binance": "book_mid",
			},
		}},
	}
	modes := c.ProviderPriceModesMap()
	entries := c.BookMidEntries(modes)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].UsdSymbol != "BTCUSD" || !entries[0].NeedsUSDT {
		t.Fatalf("unexpected entry: %+v", entries[0])
	}
}

func TestValidateBookMid(t *testing.T) {
	t.Parallel()
	c := Config{BookMid: BookMidConfig{EmitIntervalMs: 50, MaxBookAgeMs: 5}}
	if err := c.validateBookMid(); err == nil {
		t.Fatal("expected max_book_age < 2*emit error")
	}
}
