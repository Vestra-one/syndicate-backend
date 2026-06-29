package config

import (
	"github.com/syndicate/backend/services/signed-price-server/provider"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

// SupportedProviders defines the list of supported providers.
var SupportedProviders = map[types.ProviderName]struct{}{
	provider.ProviderBinance:   {},
	provider.ProviderBinanceUS: {},
	provider.ProviderCoinbase:  {},
	// Add more providers as needed
	// provider.ProviderKraken:    {},
	// provider.ProviderHuobi:     {},
	// provider.ProviderOsmosis:   {},
}
