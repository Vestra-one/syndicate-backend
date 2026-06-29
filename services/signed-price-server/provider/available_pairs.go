package provider

import (
	"strings"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/types"
)

// ConfirmPairAvailability takes a list of pairs that are meant to be subscribed
// to, and uses the given provider's GetAvailablePairs method to check that the
// given pairs can be subscribed to. It will return an updated list of pairs that
// can be subsribed to, and send a warning log about any pairs passed in that
// cannot be subsribed to.
func ConfirmPairAvailability(
	p Provider,
	providerName types.ProviderName,
	logger zerolog.Logger,
	cps ...types.CurrencyPair,
) ([]types.CurrencyPair, error) {
	availablePairs, err := p.GetAvailablePairs()
	if err != nil {
		return nil, err
	}

	// confirm pairs can be subscribed to
	confirmedPairs := []types.CurrencyPair{}
	for _, cp := range cps {
		if _, ok := availablePairs[strings.ToUpper(cp.String())]; !ok {
			logger.Warn().
				Str("pair", cp.String()).
				Str("provider", string(providerName)).
				Msg("pair not available to subscribe, ignoring")
			continue
		}
		confirmedPairs = append(confirmedPairs, cp)
	}

	return confirmedPairs, nil
}
