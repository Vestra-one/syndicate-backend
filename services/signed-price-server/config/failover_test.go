package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadRegionalFailoverConfigs(t *testing.T) {
	t.Parallel()
	cases := []string{
		"config.us-east.toml",
		"config.canada.toml",
	}
	for _, name := range cases {
		cfg, err := LoadConfig(name)
		if err != nil {
			t.Fatalf("load %s: %v", name, err)
		}
		if !cfg.Failover.Enabled {
			t.Fatalf("%s: failover should be enabled", name)
		}
		if len(cfg.Failover.Symbols) != 3 {
			t.Fatalf("%s: expected 3 failover symbols, got %d", name, len(cfg.Failover.Symbols))
		}
		settings := cfg.Failover.ToFailoverSettings()
		if settings.NodeID == "" || settings.PeerURL == "" {
			t.Fatalf("%s: incomplete failover settings", name)
		}
	}
}

// TestLoadConfig_failoverLeaseTunablesFromTOML proves the lease params are
// configurable end-to-end: TOML keys -> FailoverConfig -> failover.Settings, and
// that omitted keys fall back to the documented defaults.
func TestLoadConfig_failoverLeaseTunablesFromTOML(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "lease.toml")
	content := `
[[currency_pairs]]
base = "BTC"
quote = "USD"
token = "0xa7BaE7da3E4950700BE9f107EB186e89a474d180"
providers = ["coinbase"]

[[token_mappings]]
symbol = "BTCUSD"
address = "0xa7BaE7da3E4950700BE9f107EB186e89a474d180"

[failover]
enabled = true
node_id = "local"
peer_url = "http://localhost:8081"
shared_secret_env = "FAILOVER_SHARED_SECRET"
peer_request_timeout_ms = 300
lease_ttl_ms = 2500
lease_renew_ms = 400
clock_skew_margin_ms = 600

[[failover.symbols]]
symbol = "BTCUSD"
role = "primary"
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	s := cfg.Failover.ToFailoverSettings()
	if s.LeaseTTL != 2500*time.Millisecond {
		t.Errorf("lease_ttl_ms not applied: got %v, want 2.5s", s.LeaseTTL)
	}
	if s.LeaseRenew != 400*time.Millisecond {
		t.Errorf("lease_renew_ms not applied: got %v, want 400ms", s.LeaseRenew)
	}
	if s.ClockSkewMargin != 600*time.Millisecond {
		t.Errorf("clock_skew_margin_ms not applied: got %v, want 600ms", s.ClockSkewMargin)
	}

	// Omitted lease keys fall back to defaults.
	def := FailoverConfig{Enabled: true}.ToFailoverSettings()
	if def.LeaseTTL != time.Second || def.LeaseRenew != 200*time.Millisecond || def.ClockSkewMargin != 500*time.Millisecond {
		t.Errorf("defaults wrong: ttl=%v renew=%v margin=%v", def.LeaseTTL, def.LeaseRenew, def.ClockSkewMargin)
	}
}
