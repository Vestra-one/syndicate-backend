package config

import (
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"github.com/syndicate/backend/services/signed-price-server/provider"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

// BookMidEntryConfig describes one book_mid pair for the emitter and health endpoints.
type BookMidEntryConfig struct {
	Provider   types.ProviderName
	Exchange   string
	PairKey    string
	UsdSymbol  string
	BboProvider string
	BboSymbol  string
	Token      common.Address
	NeedsUSDT  bool
}

// BookMidEntries returns configured book_mid rows across all providers.
func (c Config) BookMidEntries(modes map[types.ProviderName]map[string]types.PriceFeedMode) []BookMidEntryConfig {
	var entries []BookMidEntryConfig
	for _, row := range c.CurrencyPairs {
		pairKey := row.Base + row.Quote
		token := common.HexToAddress(row.Token)
		for _, prov := range row.Providers {
			mode := types.PriceFeedLastTrade
			if m, ok := modes[prov][pairKey]; ok {
				mode = m
			}
			if mode != types.PriceFeedBookMid {
				continue
			}
			usdSymbol := pairKey
			needsUSDT := false
			if prov == provider.ProviderBinance || prov == provider.ProviderBinanceUS {
				if strings.HasSuffix(pairKey, "USDT") {
					usdSymbol = strings.TrimSuffix(pairKey, "USDT") + "USD"
					needsUSDT = true
				}
			}
			entries = append(entries, BookMidEntryConfig{
				Provider:    prov,
				Exchange:    string(prov),
				PairKey:     pairKey,
				UsdSymbol:   usdSymbol,
				BboProvider: string(prov),
				BboSymbol:   usdSymbol,
				Token:       token,
				NeedsUSDT:   needsUSDT,
			})
		}
	}
	return entries
}

// BookMidHealthSymbols returns USD symbols for health reporting.
func BookMidHealthSymbols(entries []BookMidEntryConfig) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.UsdSymbol
	}
	return out
}
