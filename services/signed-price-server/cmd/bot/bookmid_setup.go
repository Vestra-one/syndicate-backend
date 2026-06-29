package main

import (
	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/config"
	"github.com/syndicate/backend/services/signed-price-server/provider"
)

func bookMidEntriesFromConfig(cfgs []config.BookMidEntryConfig) []provider.BookMidEntry {
	out := make([]provider.BookMidEntry, len(cfgs))
	for i, c := range cfgs {
		out[i] = provider.BookMidEntry{
			Provider:  c.Provider,
			Exchange:  c.Exchange,
			PairKey:   c.PairKey,
			UsdSymbol: c.UsdSymbol,
			BboKey: bbo.Key{
				Provider: c.BboProvider,
				Symbol:   c.BboSymbol,
			},
			Token:     c.Token,
			NeedsUSDT: c.NeedsUSDT,
		}
	}
	return out
}

func bboKeysFromConfig(cfgs []config.BookMidEntryConfig) []bbo.Key {
	keys := make([]bbo.Key, len(cfgs))
	for i, c := range cfgs {
		keys[i] = bbo.Key{Provider: c.BboProvider, Symbol: c.BboSymbol}
	}
	return keys
}
