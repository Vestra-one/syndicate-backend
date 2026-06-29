package provider

import (
	"sync"

	"github.com/syndicate/backend/services/signed-price-server/types"
)

// priceStore manages subscribed currency pairs for a provider.
// Simplified to only track subscriptions - price-bot uses direct trade callbacks.
type priceStore struct {
	subscribedPairs sync.Map // map[string]types.CurrencyPair - lock-free
}

// newPriceStore creates a new price store
func newPriceStore() priceStore {
	return priceStore{}
}

// setSubscribedPairs sets N currency pairs to the map of subscribed pairs.
// Lock-free operation using sync.Map
func (ps *priceStore) setSubscribedPairs(cps ...types.CurrencyPair) {
	for _, cp := range cps {
		ps.subscribedPairs.Store(cp.String(), cp)
	}
}

// isSubscribed returns true if the provider is subscribed to the currency pair.
// Lock-free read using sync.Map
func (ps *priceStore) isSubscribed(currencyPair string) bool {
	_, ok := ps.subscribedPairs.Load(currencyPair)
	return ok
}

// GetAvailablePairs returns all subscribed currency pair strings
func (ps *priceStore) GetAvailablePairs() map[string]struct{} {
	pairs := make(map[string]struct{})
	ps.subscribedPairs.Range(func(key, value interface{}) bool {
		pairs[key.(string)] = struct{}{}
		return true
	})
	return pairs
}
