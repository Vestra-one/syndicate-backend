package config

import (
	"os"
	"time"

	"github.com/syndicate/backend/services/signed-price-server/failover"
)

// ToFailoverSettings maps TOML failover config to controller settings.
func (f FailoverConfig) ToFailoverSettings() failover.Settings {
	symbols := make([]failover.SymbolSettings, len(f.Symbols))
	for i, sym := range f.Symbols {
		symbols[i] = failover.SymbolSettings{
			Symbol: sym.Symbol,
			Role:   failover.Role(sym.Role),
		}
	}
	return failover.Settings{
		Enabled:            f.Enabled,
		NodeID:             f.NodeID,
		PeerNodeID:         f.PeerNodeID,
		PeerURL:            f.PeerURL,
		SharedSecret:       f.SharedSecret(),
		PromoteDebounce:    f.PromoteDebounce(),
		RecoverHysteresis:  f.RecoverHysteresis(),
		PeerRequestTimeout: f.PeerRequestTimeout(),
		LeaseTTL:           f.LeaseTTL(),
		LeaseRenew:         f.LeaseRenew(),
		ClockSkewMargin:    f.ClockSkewMargin(),
		Symbols:            symbols,
	}
}

// LeaseTTL returns how long a delegated signing lease stays valid without renewal.
func (f FailoverConfig) LeaseTTL() time.Duration {
	ms := f.LeaseTTLMs
	if ms <= 0 {
		ms = 1000
	}
	return time.Duration(ms) * time.Millisecond
}

// LeaseRenew returns how often the primary renews the standby's lease while delegated.
func (f FailoverConfig) LeaseRenew() time.Duration {
	ms := f.LeaseRenewMs
	if ms <= 0 {
		ms = 200
	}
	return time.Duration(ms) * time.Millisecond
}

// ClockSkewMargin returns the safety margin added to lease_ttl before a recovering
// primary resumes without a peer ack.
func (f FailoverConfig) ClockSkewMargin() time.Duration {
	ms := f.ClockSkewMarginMs
	if ms <= 0 {
		ms = 500
	}
	return time.Duration(ms) * time.Millisecond
}

// PromoteDebounce returns debounce before delegating to peer.
func (f FailoverConfig) PromoteDebounce() time.Duration {
	ms := f.PromoteDebounceMs
	if ms <= 0 {
		ms = 100
	}
	return time.Duration(ms) * time.Millisecond
}

// RecoverHysteresis returns fresh-book duration before failback demote.
func (f FailoverConfig) RecoverHysteresis() time.Duration {
	ms := f.RecoverHysteresisMs
	if ms <= 0 {
		ms = 500
	}
	return time.Duration(ms) * time.Millisecond
}

// PeerRequestTimeout returns outbound peer HTTP timeout.
func (f FailoverConfig) PeerRequestTimeout() time.Duration {
	ms := f.PeerRequestTimeoutMs
	if ms <= 0 {
		ms = 300
	}
	return time.Duration(ms) * time.Millisecond
}

// SharedSecret resolves the failover auth secret from the configured env var.
func (f FailoverConfig) SharedSecret() string {
	env := f.SharedSecretEnv
	if env == "" {
		env = "FAILOVER_SHARED_SECRET"
	}
	return os.Getenv(env)
}
