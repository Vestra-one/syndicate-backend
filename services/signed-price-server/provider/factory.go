package provider

import (
	"context"
	"fmt"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

// NewProvider creates a new provider instance based on the provider name.
// pairPriceModes keys use Base+Quote (e.g. BTCUSDT, BTCUSD). Nil or missing keys default to last_trade.
func NewProvider(
	ctx context.Context,
	providerName types.ProviderName,
	logger zerolog.Logger,
	endpoint Endpoint,
	pairPriceModes map[string]types.PriceFeedMode,
	bboStore *bbo.SnapshotStore,
	providerPairs ...types.CurrencyPair,
) (Provider, error) {
	switch providerName {
	case ProviderBinance:
		return NewBinanceProvider(ctx, logger, endpoint, false, pairPriceModes, bboStore, providerPairs...)

	case ProviderBinanceUS:
		return NewBinanceProvider(ctx, logger, endpoint, true, pairPriceModes, bboStore, providerPairs...)

	case ProviderCoinbase:
		return NewCoinbaseProvider(ctx, logger, endpoint, pairPriceModes, bboStore, providerPairs...)

	// Add more providers here as needed
	// case ProviderKraken:
	// 	return NewKrakenProvider(ctx, logger, endpoint, providerPairs...)
	//
	// case ProviderHuobi:
	// 	return NewHuobiProvider(ctx, logger, endpoint, providerPairs...)
	//
	// case ProviderOsmosis:
	// 	return NewOsmosisProvider(ctx, logger, endpoint, providerPairs...)

	default:
		return nil, fmt.Errorf("unsupported provider: %s", providerName)
	}
}

// ProviderInfo holds information about a provider instance.
type ProviderInfo struct {
	Name     types.ProviderName
	Provider Provider
	Pairs    []types.CurrencyPair
}

// CreateProvidersForPairs creates provider instances for each provider-pair combination.
// This allows different pairs to use different providers.
func CreateProvidersForPairs(
	ctx context.Context,
	logger zerolog.Logger,
	providerPairs map[types.ProviderName][]types.CurrencyPair,
	pairModesByProvider map[types.ProviderName]map[string]types.PriceFeedMode,
	endpoints map[types.ProviderName]Endpoint,
	bboStore *bbo.SnapshotStore,
) (map[types.ProviderName]Provider, error) {
	providers := make(map[types.ProviderName]Provider)

	for providerName, pairs := range providerPairs {
		if len(pairs) == 0 {
			continue
		}

		// Get endpoint for this provider
		endpoint, ok := endpoints[providerName]
		if !ok {
			// Use default endpoint based on provider name
			endpoint = getDefaultEndpoint(providerName)
		}

		pairModes := pairModesByProvider[providerName]
		if pairModes == nil {
			pairModes = map[string]types.PriceFeedMode{}
		}

		// Create provider instance
		p, err := NewProvider(ctx, providerName, logger, endpoint, pairModes, bboStore, pairs...)
		if err != nil {
			return nil, fmt.Errorf("failed to create provider %s: %w", providerName, err)
		}

		providers[providerName] = p
		logger.Info().
			Str("provider", string(providerName)).
			Int("pairs", len(pairs)).
			Msg("created provider instance")
	}

	return providers, nil
}

// getDefaultEndpoint returns default endpoint configuration for a provider.
func getDefaultEndpoint(providerName types.ProviderName) Endpoint {
	switch providerName {
	case ProviderBinance:
		return Endpoint{
			Name:      ProviderBinance,
			Rest:      "https://api1.binance.com",
			Websocket: "stream.binance.com:9443",
		}
	case ProviderBinanceUS:
		return Endpoint{
			Name:      ProviderBinanceUS,
			Rest:      "https://api.binance.us",
			Websocket: "stream.binance.us:9443",
		}
	case ProviderCoinbase:
		return Endpoint{
			Name:      ProviderCoinbase,
			Rest:      "https://api.exchange.coinbase.com",
			Websocket: "ws-feed.exchange.coinbase.com",
		}
	// Add more default endpoints as needed
	default:
		return Endpoint{
			Name: providerName,
		}
	}
}

// StartAllProviders starts all provider connections.
func StartAllProviders(providers map[types.ProviderName]Provider) {
	for name, p := range providers {
		p.StartConnections()
		_ = name
	}
}

// GetProviderForPair returns the first available provider for a given currency pair.
func GetProviderForPair(
	base, quote string,
	providerPairs map[types.ProviderName][]types.CurrencyPair,
	providers map[types.ProviderName]Provider,
) (Provider, types.ProviderName, error) {
	for providerName, pairs := range providerPairs {
		for _, pair := range pairs {
			if pair.Base == base && pair.Quote == quote {
				p, ok := providers[providerName]
				if !ok {
					continue
				}
				return p, providerName, nil
			}
		}
	}
	return nil, "", fmt.Errorf("no provider found for pair %s/%s", base, quote)
}
