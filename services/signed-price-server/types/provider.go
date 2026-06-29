package types

type Trade struct {
	Time  int64 // time in unix epoch
	Size  string
	Price string
}

// String cast provider name to string.
func (n ProviderName) String() string {
	return string(n)
}

type (
	// ProviderName name of an oracle provider. Usually it is an exchange
	// but this can be any provider name that can give token prices
	// examples.: "binance", "osmosis", "kraken".
	ProviderName string
)
