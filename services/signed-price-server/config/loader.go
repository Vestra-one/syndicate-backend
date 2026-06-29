package config

import (
	"fmt"
	"os"

	"github.com/spf13/viper"
)

// LoadConfig loads the configuration from a TOML file.
func LoadConfig(configPath string) (Config, error) {
	if configPath == "" {
		return Config{}, ErrEmptyConfigPath
	}

	v := viper.New()
	v.SetConfigFile(configPath)
	v.SetConfigType("toml")

	if err := v.ReadInConfig(); err != nil {
		return Config{}, fmt.Errorf("failed to read config: %w", err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return Config{}, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	// Set defaults
	cfg.SetDefaults()

	// Validate
	if err := cfg.Validate(); err != nil {
		return Config{}, fmt.Errorf("invalid config: %w", err)
	}

	return cfg, nil
}

// LoadConfigFromEnv loads configuration from environment variables as well.
func LoadConfigFromEnv(configPath string) (Config, error) {
	cfg, err := LoadConfig(configPath)
	if err != nil {
		return Config{}, err
	}

	// Override with environment variables if present
	if addr := os.Getenv("LISTEN_ADDR"); addr != "" {
		cfg.Server.ListenAddr = addr
	}

	if level := os.Getenv("LOG_LEVEL"); level != "" {
		cfg.Logging.Level = level
	}

	return cfg, nil
}
