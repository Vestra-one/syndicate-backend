package config

import (
	"sort"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/provider"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

// TestLoggingConfig_BuildLogger_Level locks the level-parsing contract: known
// levels are honored and empty/unknown values fall back to info.
func TestLoggingConfig_BuildLogger_Level(t *testing.T) {
	cases := map[string]zerolog.Level{
		"debug": zerolog.DebugLevel,
		"warn":  zerolog.WarnLevel,
		"ERROR": zerolog.ErrorLevel, // case-insensitive
		"":      zerolog.InfoLevel,  // empty falls back
		"bogus": zerolog.InfoLevel,  // unknown falls back
	}
	for in, want := range cases {
		lg := LoggingConfig{Level: in, Format: "json"}.BuildLogger()
		if got := lg.GetLevel(); got != want {
			t.Errorf("level %q: got %v, want %v", in, got, want)
		}
	}
}

func TestDevnetConfigOnlySyndicateSymbols(t *testing.T) {
	cfg, err := LoadConfig("devnet.toml")
	if err != nil {
		t.Fatalf("load devnet config: %v", err)
	}

	var pairSymbols []string
	for _, pair := range cfg.CurrencyPairs {
		pairSymbols = append(pairSymbols, pair.Base+pair.Quote)
		if len(pair.Providers) != 1 || pair.Providers[0] != provider.ProviderCoinbase {
			t.Fatalf("pair %s%s providers = %v, want coinbase only", pair.Base, pair.Quote, pair.Providers)
		}
		if got := pair.ProviderPriceModes["coinbase"]; got != string(types.PriceFeedBookMid) {
			t.Fatalf("pair %s%s coinbase mode = %q, want book_mid", pair.Base, pair.Quote, got)
		}
	}
	sort.Strings(pairSymbols)
	wantSymbols := []string{"BTCUSD", "ETHUSD", "SOLUSD"}
	if !equalStrings(pairSymbols, wantSymbols) {
		t.Fatalf("currency pairs = %v, want %v", pairSymbols, wantSymbols)
	}

	var mappingSymbols []string
	for _, mapping := range cfg.TokenMappings {
		mappingSymbols = append(mappingSymbols, mapping.Symbol)
	}
	sort.Strings(mappingSymbols)
	if !equalStrings(mappingSymbols, wantSymbols) {
		t.Fatalf("token mappings = %v, want %v", mappingSymbols, wantSymbols)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestValidateCurrencyPairs_providerPriceModes(t *testing.T) {
	t.Parallel()
	base := Config{
		CurrencyPairs: []CurrencyPair{{
			Base:      "BTC",
			Quote:     "USDT",
			Token:     "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
			Providers: []types.ProviderName{provider.ProviderBinance},
			ProviderPriceModes: map[string]string{
				"binance": "book_mid",
			},
		}},
		TokenMappings: []TokenMapping{
			{Symbol: "BTCUSD", Address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"},
		},
	}
	base.SetDefaults()
	if err := base.Validate(); err != nil {
		t.Fatalf("expected valid config: %v", err)
	}

	badMode := base
	badMode.CurrencyPairs = []CurrencyPair{{
		Base:               "BTC",
		Quote:              "USDT",
		Token:              "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
		Providers:          []types.ProviderName{provider.ProviderBinance},
		ProviderPriceModes: map[string]string{"binance": "nope"},
	}}
	if err := badMode.Validate(); err == nil {
		t.Fatal("expected error for unknown mode")
	}

	unknownProv := base
	unknownProv.CurrencyPairs = []CurrencyPair{{
		Base:               "BTC",
		Quote:              "USDT",
		Token:              "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
		Providers:          []types.ProviderName{provider.ProviderBinance},
		ProviderPriceModes: map[string]string{"coinbase": "book_mid"},
	}}
	if err := unknownProv.Validate(); err == nil {
		t.Fatal("expected error for provider not in row")
	}
}

func TestBookMidStaleWatchdog_defaultsAndAccessors(t *testing.T) {
	t.Parallel()
	c := Config{}
	c.SetDefaults()
	if got := c.StaleWatchdogInterval(); got != time.Second {
		t.Fatalf("StaleWatchdogInterval default = %v, want 1s", got)
	}
	if got := c.StaleThreshold(); got != 5*time.Second {
		t.Fatalf("StaleThreshold default = %v, want 5s", got)
	}
	if got := c.StaleReconnectCooldown(); got != 30*time.Second {
		t.Fatalf("StaleReconnectCooldown default = %v, want 30s", got)
	}
}

func TestValidateBookMid_staleWatchdog(t *testing.T) {
	t.Parallel()
	// Threshold below max_book_age_ms is rejected (would reconnect before the
	// emitter even pauses).
	tooLow := Config{BookMid: BookMidConfig{
		EmitIntervalMs:          45,
		MaxBookAgeMs:            1500,
		StaleWatchdogIntervalMs: 1000,
		StaleThresholdMs:        1000,
	}}
	if err := tooLow.validateBookMid(); err == nil {
		t.Fatal("expected error: stale_threshold_ms < max_book_age_ms")
	}

	// Threshold below the check interval is rejected.
	thresholdBelowInterval := Config{BookMid: BookMidConfig{
		StaleWatchdogIntervalMs: 2000,
		StaleThresholdMs:        1000,
	}}
	if err := thresholdBelowInterval.validateBookMid(); err == nil {
		t.Fatal("expected error: stale_threshold_ms < stale_watchdog_interval_ms")
	}

	// Negative values are rejected.
	negative := Config{BookMid: BookMidConfig{StaleThresholdMs: -1}}
	if err := negative.validateBookMid(); err == nil {
		t.Fatal("expected error: negative watchdog param")
	}

	// Disabled watchdog (interval 0) skips relationship checks.
	disabled := Config{BookMid: BookMidConfig{
		EmitIntervalMs: 45,
		MaxBookAgeMs:   1500,
	}}
	if err := disabled.validateBookMid(); err != nil {
		t.Fatalf("expected valid disabled-watchdog config: %v", err)
	}

	// A well-formed enabled watchdog validates.
	ok := Config{BookMid: BookMidConfig{
		EmitIntervalMs:           45,
		MaxBookAgeMs:             1500,
		StaleWatchdogIntervalMs:  1000,
		StaleThresholdMs:         5000,
		StaleReconnectCooldownMs: 30000,
	}}
	if err := ok.validateBookMid(); err != nil {
		t.Fatalf("expected valid config: %v", err)
	}
}

func TestProviderPriceModesMap_defaultsLastTrade(t *testing.T) {
	t.Parallel()
	c := Config{
		CurrencyPairs: []CurrencyPair{{
			Base:      "ETH",
			Quote:     "USDT",
			Token:     "0x4200000000000000000000000000000000000006",
			Providers: []types.ProviderName{provider.ProviderBinance},
		}},
	}
	m := c.ProviderPriceModesMap()
	bin := m[provider.ProviderBinance]["ETHUSDT"]
	if bin != types.PriceFeedLastTrade {
		t.Fatalf("got %v want last_trade", bin)
	}
}
