package provider

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

var (
	providerWSConnected = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "provider_ws_connected",
		Help: "1 if the provider has at least one active exchange WebSocket connection",
	}, []string{"provider"})

	providerWSLastMessageSeconds = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "provider_ws_last_message_seconds",
		Help: "Unix timestamp of the last message received on the provider WebSocket",
	}, []string{"provider"})

	wsConnRefCounts sync.Map // provider string -> *atomic.Int32
)

func providerConnCount(provider types.ProviderName) *atomic.Int32 {
	key := provider.String()
	if v, ok := wsConnRefCounts.Load(key); ok {
		return v.(*atomic.Int32)
	}
	c := &atomic.Int32{}
	actual, _ := wsConnRefCounts.LoadOrStore(key, c)
	return actual.(*atomic.Int32)
}

// recordProviderWSConnected adjusts the active connection refcount for a provider.
func recordProviderWSConnected(provider types.ProviderName, delta int32) {
	c := providerConnCount(provider)
	n := c.Add(delta)
	prov := provider.String()
	if n > 0 {
		providerWSConnected.WithLabelValues(prov).Set(1)
	} else {
		if n < 0 {
			c.Store(0)
		}
		providerWSConnected.WithLabelValues(prov).Set(0)
	}
}

// recordProviderWSMessage updates last-message time for a provider.
func recordProviderWSMessage(provider types.ProviderName) {
	providerWSLastMessageSeconds.WithLabelValues(provider.String()).Set(float64(time.Now().Unix()))
}
