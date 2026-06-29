package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/go-playground/validator/v10"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/provider"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

const (
	defaultListenAddr      = "0.0.0.0:8080"
	defaultSrvWriteTimeout = 15 * time.Second
	defaultSrvReadTimeout  = 15 * time.Second
	defaultProviderTimeout = 100 * time.Millisecond
)

var (
	validate = validator.New()

	// ErrEmptyConfigPath defines a sentinel error for an empty config path.
	ErrEmptyConfigPath = errors.New("empty configuration file path")
)

// init registers struct-level validations once. Registering inside Validate()
// mutated the shared validator on every call, which is a data race when configs
// are validated concurrently.
func init() {
	validate.RegisterStructValidation(endpointValidation, provider.Endpoint{})
}

type (
	// Config defines all necessary price-bot configuration parameters.
	Config struct {
		Server            Server              `mapstructure:"server"`
		Signing           SigningConfig       `mapstructure:"signing"`
		Store             StoreConfig         `mapstructure:"store"`
		Hub               HubConfig           `mapstructure:"hub"`
		BookMid           BookMidConfig       `mapstructure:"book_mid"`
		CurrencyPairs     []CurrencyPair      `mapstructure:"currency_pairs" validate:"required,gt=0,dive,required"`
		ProviderEndpoints []provider.Endpoint `mapstructure:"provider_endpoints" validate:"dive"`
		TokenMappings     []TokenMapping      `mapstructure:"token_mappings" validate:"required,dive"`
		ProviderTimeout   string              `mapstructure:"provider_timeout"`
		Logging           LoggingConfig       `mapstructure:"logging"`
		Metrics           MetricsConfig       `mapstructure:"metrics"`
		Failover          FailoverConfig      `mapstructure:"failover"`
	}

	// Server defines the API server configuration.
	Server struct {
		ListenAddr      string `mapstructure:"listen_addr"`
		WriteTimeout    string `mapstructure:"write_timeout"`
		ReadTimeout     string `mapstructure:"read_timeout"`
		MaxConnections  int    `mapstructure:"max_connections"`
		ReadBufferSize  int    `mapstructure:"read_buffer_size"`
		WriteBufferSize int    `mapstructure:"write_buffer_size"`
		ShutdownTimeout string `mapstructure:"shutdown_timeout"`
	}

	// SigningConfig defines the signing worker pool configuration.
	SigningConfig struct {
		NumWorkers      int `mapstructure:"num_workers"`
		TradeQueueSize  int `mapstructure:"trade_queue_size"`
		SignedQueueSize int `mapstructure:"signed_queue_size"`
	}

	// StoreConfig defines the price store configuration.
	StoreConfig struct {
		HistoryCapacity int    `mapstructure:"history_capacity"`
		SQLitePath      string `mapstructure:"sqlite_path"`
	}

	// HubConfig defines the WebSocket hub configuration.
	HubConfig struct {
		ClientQueueSize      int    `mapstructure:"client_queue_size"`
		ClientSendBufferSize int    `mapstructure:"client_send_buffer_size"`
		PingInterval         string `mapstructure:"ping_interval"`
		WriteTimeout         string `mapstructure:"write_timeout"`
	}

	// BookMidConfig configures the book_mid heartbeat emitter, staleness gate, and
	// the per-symbol stale-book reconnect watchdog.
	BookMidConfig struct {
		EmitIntervalMs int `mapstructure:"emit_interval_ms"`
		MaxBookAgeMs   int `mapstructure:"max_book_age_ms"`
		// StaleWatchdogIntervalMs is how often the watchdog checks each book_mid
		// symbol's BBO freshness. 0 disables the watchdog.
		StaleWatchdogIntervalMs int `mapstructure:"stale_watchdog_interval_ms"`
		// StaleThresholdMs is how long a symbol may go without a BBO update before
		// the watchdog forces a provider reconnect.
		StaleThresholdMs int `mapstructure:"stale_threshold_ms"`
		// StaleReconnectCooldownMs bounds how often the watchdog may force a reconnect.
		StaleReconnectCooldownMs int `mapstructure:"stale_reconnect_cooldown_ms"`
	}

	// CurrencyPair defines a price quote and the providers that support it.
	CurrencyPair struct {
		Base      string               `mapstructure:"base" validate:"required"`
		Quote     string               `mapstructure:"quote" validate:"required"`
		Token     string               `mapstructure:"token" validate:"required"` // Token contract address
		Providers []types.ProviderName `mapstructure:"providers" validate:"required,gt=0,dive,required"`
		// ProviderPriceModes maps provider name → "last_trade" or "book_mid". Omitted entries default to last_trade.
		ProviderPriceModes map[string]string `mapstructure:"provider_price_modes"`
	}

	// TokenMapping defines a mapping from a symbol to its token address.
	TokenMapping struct {
		Symbol  string `mapstructure:"symbol" validate:"required"`
		Address string `mapstructure:"address" validate:"required"`
	}

	// LoggingConfig defines logging configuration.
	LoggingConfig struct {
		Level  string `mapstructure:"level"`
		Format string `mapstructure:"format"`
	}

	// MetricsConfig defines Prometheus metrics configuration.
	MetricsConfig struct {
		Path string `mapstructure:"path"`
	}

	// FailoverConfig configures cross-server active/standby signing coordination.
	FailoverConfig struct {
		Enabled              bool                   `mapstructure:"enabled"`
		NodeID               string                 `mapstructure:"node_id"`
		PeerNodeID           string                 `mapstructure:"peer_node_id"`
		PeerURL              string                 `mapstructure:"peer_url"`
		SharedSecretEnv      string                 `mapstructure:"shared_secret_env"`
		PromoteDebounceMs    int                    `mapstructure:"promote_debounce_ms"`
		RecoverHysteresisMs  int                    `mapstructure:"recover_hysteresis_ms"`
		PeerRequestTimeoutMs int                    `mapstructure:"peer_request_timeout_ms"`
		LeaseTTLMs           int                    `mapstructure:"lease_ttl_ms"`
		LeaseRenewMs         int                    `mapstructure:"lease_renew_ms"`
		ClockSkewMarginMs    int                    `mapstructure:"clock_skew_margin_ms"`
		Symbols              []FailoverSymbolConfig `mapstructure:"symbols"`
	}

	// FailoverSymbolConfig binds a USD symbol to primary or standby role on this node.
	FailoverSymbolConfig struct {
		Symbol string `mapstructure:"symbol"`
		Role   string `mapstructure:"role"`
	}
)

// Validate returns an error if the Config object is invalid.
func (c Config) Validate() (err error) {
	if err = c.validateCurrencyPairs(); err != nil {
		return err
	}
	if err = c.validateServer(); err != nil {
		return err
	}
	if err = c.validateBookMid(); err != nil {
		return err
	}
	if err = c.validateFailover(); err != nil {
		return err
	}
	if err = c.validateTokenMappings(); err != nil {
		return err
	}

	return validate.Struct(c)
}

// validateTokenMappings ensures each token_mappings address is a valid hex address
// and not the zero address, so invalid config fails at load instead of producing
// wrong signatures (HexToAddress returns zero for invalid hex and does not error).
func (c Config) validateTokenMappings() error {
	zeroAddr := common.Address{}
	for _, mapping := range c.TokenMappings {
		addrStr := strings.TrimSpace(mapping.Address)
		if !common.IsHexAddress(addrStr) {
			return fmt.Errorf("token_mappings: invalid address %q for symbol %q (must be 0x-prefixed 40-char hex)", addrStr, mapping.Symbol)
		}
		addr := common.HexToAddress(addrStr)
		if addr == zeroAddr {
			return fmt.Errorf("token_mappings: zero address not allowed for symbol %q", mapping.Symbol)
		}
	}
	return nil
}

func (c Config) validateFailover() error {
	if !c.Failover.Enabled {
		return nil
	}
	if c.Failover.NodeID == "" {
		return fmt.Errorf("failover.node_id: required when failover.enabled")
	}
	if c.Failover.PeerURL == "" {
		return fmt.Errorf("failover.peer_url: required when failover.enabled")
	}
	for _, sym := range c.Failover.Symbols {
		if sym.Symbol == "" {
			return fmt.Errorf("failover.symbols: symbol required")
		}
		switch sym.Role {
		case "primary", "standby":
		default:
			return fmt.Errorf("failover.symbols: role for %q must be primary or standby, got %q", sym.Symbol, sym.Role)
		}
	}
	if c.Failover.LeaseTTLMs <= c.Failover.LeaseRenewMs {
		return fmt.Errorf("failover.lease_ttl_ms (%d) must be greater than lease_renew_ms (%d)", c.Failover.LeaseTTLMs, c.Failover.LeaseRenewMs)
	}
	// The recovering primary resumes after lease_ttl + clock_skew_margin without a
	// peer ack; that margin must cover the peer request timeout (a promote can still
	// be in flight) plus clock skew, or the primary could resume before the peer's
	// lease expires and both could sign.
	if c.Failover.ClockSkewMarginMs < c.Failover.PeerRequestTimeoutMs {
		return fmt.Errorf("failover.clock_skew_margin_ms (%d) must be >= peer_request_timeout_ms (%d)", c.Failover.ClockSkewMarginMs, c.Failover.PeerRequestTimeoutMs)
	}
	return nil
}

func (c Config) validateBookMid() error {
	emit := c.BookMid.EmitIntervalMs
	maxAge := c.BookMid.MaxBookAgeMs
	if emit > 0 && emit < 10 {
		return fmt.Errorf("book_mid.emit_interval_ms: must be >= 10 when set, got %d", emit)
	}
	if maxAge > 0 && emit > 0 && maxAge < emit*2 {
		return fmt.Errorf("book_mid.max_book_age_ms: must be >= 2 * emit_interval_ms (%d), got %d", emit*2, maxAge)
	}

	interval := c.BookMid.StaleWatchdogIntervalMs
	threshold := c.BookMid.StaleThresholdMs
	cooldown := c.BookMid.StaleReconnectCooldownMs
	if interval < 0 || threshold < 0 || cooldown < 0 {
		return fmt.Errorf("book_mid stale watchdog params must be non-negative")
	}
	// Only validate the relationships when the watchdog is enabled.
	if interval > 0 {
		if threshold <= 0 {
			return fmt.Errorf("book_mid.stale_threshold_ms: must be > 0 when stale_watchdog_interval_ms is set")
		}
		if maxAge > 0 && threshold < maxAge {
			return fmt.Errorf("book_mid.stale_threshold_ms: must be >= max_book_age_ms (%d), got %d", maxAge, threshold)
		}
		if threshold < interval {
			return fmt.Errorf("book_mid.stale_threshold_ms (%d): must be >= stale_watchdog_interval_ms (%d)", threshold, interval)
		}
	}
	return nil
}

// EmitInterval returns the book_mid signing interval.
func (c Config) EmitInterval() time.Duration {
	ms := c.BookMid.EmitIntervalMs
	if ms <= 0 {
		ms = 45
	}
	return time.Duration(ms) * time.Millisecond
}

// MaxBookAge returns the maximum age of a BBO snapshot before pausing emits.
func (c Config) MaxBookAge() time.Duration {
	ms := c.BookMid.MaxBookAgeMs
	if ms <= 0 {
		ms = 1500
	}
	return time.Duration(ms) * time.Millisecond
}

// StaleWatchdogInterval returns how often the stale-book watchdog checks BBO
// freshness. A zero duration disables the watchdog.
func (c Config) StaleWatchdogInterval() time.Duration {
	return time.Duration(c.BookMid.StaleWatchdogIntervalMs) * time.Millisecond
}

// StaleThreshold returns how long a symbol may go without a BBO update before the
// watchdog forces a reconnect.
func (c Config) StaleThreshold() time.Duration {
	return time.Duration(c.BookMid.StaleThresholdMs) * time.Millisecond
}

// StaleReconnectCooldown returns the minimum interval between watchdog-forced reconnects.
func (c Config) StaleReconnectCooldown() time.Duration {
	return time.Duration(c.BookMid.StaleReconnectCooldownMs) * time.Millisecond
}

// BuildLogger constructs the root zerolog.Logger from the logging config and is
// the single, standardized entry point for logger creation. Format "json" emits
// structured JSON to stderr (fastest path, best for log aggregation); any other
// value emits human-readable console output. Level accepts the standard zerolog
// levels (debug/info/warn/error/...) and falls back to info when empty or
// unrecognized. The parsed level is also applied globally so the package-level
// zerolog logger is gated consistently.
func (l LoggingConfig) BuildLogger() zerolog.Logger {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix

	level, err := zerolog.ParseLevel(strings.ToLower(strings.TrimSpace(l.Level)))
	if err != nil || level == zerolog.NoLevel {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)

	if strings.EqualFold(strings.TrimSpace(l.Format), "json") {
		return zerolog.New(os.Stderr).Level(level).With().Timestamp().Logger()
	}
	return zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339}).
		Level(level).With().Timestamp().Logger()
}

// validateServer validates server-related config (e.g. shutdown_timeout).
func (c Config) validateServer() error {
	d, err := time.ParseDuration(c.Server.ShutdownTimeout)
	if err != nil {
		return fmt.Errorf("server.shutdown_timeout: invalid duration %q (use e.g. 30s, 1m): %w", c.Server.ShutdownTimeout, err)
	}
	if d <= 0 {
		return fmt.Errorf("server.shutdown_timeout: must be positive, got %v", d)
	}
	return nil
}

// normalizeShutdownTimeout converts a bare numeric string (e.g. "30" from TOML int)
// to a duration string with unit (e.g. "30s") so time.ParseDuration succeeds.
// If the value is already a valid duration string, it is returned unchanged.
func normalizeShutdownTimeout(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	if _, err := time.ParseDuration(s); err == nil {
		return s
	}
	// Viper may unmarshal TOML int (e.g. 30) as string "30"; ParseDuration requires a unit (e.g. "30s").
	// Only append "s" when the value looks like a bare number to avoid turning "1m" into "1ms".
	if isBareNumber(s) {
		if _, err := time.ParseDuration(s + "s"); err == nil {
			return s + "s"
		}
	}
	return s
}

func isBareNumber(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return len(s) > 0
}

func (c Config) validateCurrencyPairs() error {
	for _, cp := range c.CurrencyPairs {
		if cp.Base == "" {
			return fmt.Errorf("currency pair base cannot be empty")
		}
		if cp.Quote == "" {
			return fmt.Errorf("currency pair quote cannot be empty")
		}
		if cp.Base == cp.Quote {
			return fmt.Errorf("currency pair base and quote cannot be the same")
		}
		if cp.Token == "" {
			return fmt.Errorf("currency pair must have a token address")
		}
		if !common.IsHexAddress(cp.Token) {
			return fmt.Errorf("invalid token address: %s", cp.Token)
		}
		if len(cp.Providers) == 0 {
			return fmt.Errorf("currency pair must have at least one provider")
		}
		provInRow := make(map[types.ProviderName]struct{}, len(cp.Providers))
		for _, prov := range cp.Providers {
			if _, ok := SupportedProviders[prov]; !ok {
				return fmt.Errorf("unsupported provider: %s", prov)
			}
			provInRow[prov] = struct{}{}
		}
		for provStr, modeStr := range cp.ProviderPriceModes {
			pn := types.ProviderName(provStr)
			if _, ok := SupportedProviders[pn]; !ok {
				return fmt.Errorf("currency pair %s/%s: unknown provider %q in provider_price_modes", cp.Base, cp.Quote, provStr)
			}
			if _, ok := provInRow[pn]; !ok {
				return fmt.Errorf("currency pair %s/%s: provider_price_modes mentions %q but it is not in providers", cp.Base, cp.Quote, provStr)
			}
			if _, err := types.ParsePriceFeedMode(modeStr); err != nil {
				return fmt.Errorf("currency pair %s/%s: %w", cp.Base, cp.Quote, err)
			}
		}
	}
	return nil
}

// endpointValidation is custom validation for the ProviderEndpoint struct.
func endpointValidation(sl validator.StructLevel) {
	endpoint := sl.Current().Interface().(provider.Endpoint)

	if len(endpoint.Name) < 1 || len(endpoint.Websocket) < 1 {
		sl.ReportError(endpoint, "endpoint", "Endpoint", "invalidEndpoint", "")
	}
	if _, ok := SupportedProviders[endpoint.Name]; !ok {
		sl.ReportError(endpoint.Name, "name", "Name", "unsupportedProvider", "")
	}
}

// SetDefaults sets default values for optional configuration fields.
func (c *Config) SetDefaults() {
	if c.Server.ListenAddr == "" {
		c.Server.ListenAddr = defaultListenAddr
	}
	if c.Server.WriteTimeout == "" {
		c.Server.WriteTimeout = defaultSrvWriteTimeout.String()
	}
	if c.Server.ReadTimeout == "" {
		c.Server.ReadTimeout = defaultSrvReadTimeout.String()
	}
	if c.Server.MaxConnections == 0 {
		c.Server.MaxConnections = 12000
	}
	if c.Server.ReadBufferSize == 0 {
		c.Server.ReadBufferSize = 1024
	}
	if c.Server.WriteBufferSize == 0 {
		c.Server.WriteBufferSize = 1024
	}
	if c.Server.ShutdownTimeout == "" {
		c.Server.ShutdownTimeout = "30s"
	}
	c.Server.ShutdownTimeout = normalizeShutdownTimeout(c.Server.ShutdownTimeout)

	if c.Signing.NumWorkers == 0 {
		c.Signing.NumWorkers = 0 // 0 = auto-detect
	}
	if c.Signing.TradeQueueSize == 0 {
		c.Signing.TradeQueueSize = 100000
	}
	if c.Signing.SignedQueueSize == 0 {
		c.Signing.SignedQueueSize = 100000
	}

	if c.Store.HistoryCapacity == 0 {
		c.Store.HistoryCapacity = 100000
	}

	if c.Hub.ClientQueueSize == 0 {
		c.Hub.ClientQueueSize = 200000
	}
	if c.Hub.ClientSendBufferSize == 0 {
		c.Hub.ClientSendBufferSize = 256
	}
	if c.Hub.PingInterval == "" {
		c.Hub.PingInterval = "30s"
	}
	if c.Hub.WriteTimeout == "" {
		c.Hub.WriteTimeout = "10s"
	}

	if c.BookMid.EmitIntervalMs == 0 {
		c.BookMid.EmitIntervalMs = 45
	}
	if c.BookMid.MaxBookAgeMs == 0 {
		c.BookMid.MaxBookAgeMs = 1500
	}
	if c.BookMid.StaleWatchdogIntervalMs == 0 {
		c.BookMid.StaleWatchdogIntervalMs = 1000
	}
	if c.BookMid.StaleThresholdMs == 0 {
		c.BookMid.StaleThresholdMs = 5000
	}
	if c.BookMid.StaleReconnectCooldownMs == 0 {
		c.BookMid.StaleReconnectCooldownMs = 30000
	}

	if c.ProviderTimeout == "" {
		c.ProviderTimeout = defaultProviderTimeout.String()
	}

	if c.Logging.Level == "" {
		c.Logging.Level = "info"
	}
	if c.Logging.Format == "" {
		c.Logging.Format = "json"
	}

	if c.Metrics.Path == "" {
		c.Metrics.Path = "/metrics"
	}

	if c.Failover.PromoteDebounceMs == 0 {
		c.Failover.PromoteDebounceMs = 100
	}
	if c.Failover.RecoverHysteresisMs == 0 {
		c.Failover.RecoverHysteresisMs = 500
	}
	if c.Failover.PeerRequestTimeoutMs == 0 {
		c.Failover.PeerRequestTimeoutMs = 300
	}
	if c.Failover.LeaseTTLMs == 0 {
		c.Failover.LeaseTTLMs = 1000
	}
	if c.Failover.LeaseRenewMs == 0 {
		c.Failover.LeaseRenewMs = 200
	}
	if c.Failover.ClockSkewMarginMs == 0 {
		c.Failover.ClockSkewMarginMs = 500
	}
}

// DefaultWorkers returns the default number of signing workers.
func (s SigningConfig) DefaultWorkers() int {
	return 0 // 0 means auto-detect (runtime.NumCPU() * 2)
}

// ProviderPairs returns a map of provider pairs where the key is the provider name.
func (c Config) ProviderPairs() map[types.ProviderName][]types.CurrencyPair {
	providerPairs := make(map[types.ProviderName][]types.CurrencyPair)

	for _, pair := range c.CurrencyPairs {
		for _, providerName := range pair.Providers {
			providerPairs[providerName] = append(providerPairs[providerName], types.CurrencyPair{
				Base:  pair.Base,
				Quote: pair.Quote,
			})
		}
	}

	return providerPairs
}

// ProviderPriceModesMap returns per-provider maps from pair key (Base+Quote, e.g. BTCUSDT) to feed mode.
func (c Config) ProviderPriceModesMap() map[types.ProviderName]map[string]types.PriceFeedMode {
	out := make(map[types.ProviderName]map[string]types.PriceFeedMode)
	for _, row := range c.CurrencyPairs {
		pairKey := row.Base + row.Quote
		for _, providerName := range row.Providers {
			mode := types.PriceFeedLastTrade
			if row.ProviderPriceModes != nil {
				if mStr, ok := row.ProviderPriceModes[string(providerName)]; ok {
					if parsed, err := types.ParsePriceFeedMode(mStr); err == nil {
						mode = parsed
					}
				}
			}
			if out[providerName] == nil {
				out[providerName] = make(map[string]types.PriceFeedMode)
			}
			out[providerName][pairKey] = mode
		}
	}
	return out
}

// ProviderEndpointsMap converts the provider_endpoints from the config
// file into a map of provider.Endpoint where the key is the provider name.
func (c Config) ProviderEndpointsMap() map[types.ProviderName]provider.Endpoint {
	endpoints := make(map[types.ProviderName]provider.Endpoint, len(c.ProviderEndpoints))
	for _, endpoint := range c.ProviderEndpoints {
		endpoints[endpoint.Name] = endpoint
	}
	return endpoints
}

// TokenMappingsMap converts the token_mappings from the config file into
// a map of common.Address where the key is the symbol.
func (c Config) TokenMappingsMap() map[string]common.Address {
	mappings := make(map[string]common.Address, len(c.TokenMappings))
	for _, mapping := range c.TokenMappings {
		mappings[mapping.Symbol] = common.HexToAddress(mapping.Address)
	}
	return mappings
}

// GetPairTokenAddress returns the token address for a given currency pair symbol.
func (c Config) GetPairTokenAddress(base, quote string) (common.Address, error) {
	for _, pair := range c.CurrencyPairs {
		if pair.Base == base && pair.Quote == quote {
			return common.HexToAddress(pair.Token), nil
		}
	}
	return common.Address{}, fmt.Errorf("token address not found for pair %s/%s", base, quote)
}
