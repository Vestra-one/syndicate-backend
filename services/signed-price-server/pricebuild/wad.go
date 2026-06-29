package pricebuild

import (
	"fmt"
	"math/big"
	"strings"
)

// WadScale is 10^18 for WAD fixed-point conversion.
var wadScale = new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))

// MaxPriceUSD caps allowed price so priceInWad fits in uint256.
const MaxPriceUSD = 1e30

// PriceToWad converts a decimal price string to WAD (18 decimals).
func PriceToWad(priceStr string) (*big.Int, error) {
	priceStr = strings.TrimSpace(priceStr)
	if priceStr == "" {
		return nil, fmt.Errorf("price string is empty")
	}

	priceVal, ok := new(big.Float).SetString(priceStr)
	if !ok {
		return nil, fmt.Errorf("invalid price: %q", priceStr)
	}
	if priceVal.Sign() <= 0 {
		return nil, fmt.Errorf("price must be positive, got %s", priceStr)
	}

	maxPrice := new(big.Float).SetFloat64(MaxPriceUSD)
	if priceVal.Cmp(maxPrice) > 0 {
		return nil, fmt.Errorf("price exceeds maximum %g: %s", MaxPriceUSD, priceStr)
	}

	priceInWadFloat := new(big.Float).Mul(priceVal, wadScale)
	half := big.NewFloat(0.5)
	priceInWadFloat.Add(priceInWadFloat, half)

	priceInWad := new(big.Int)
	priceInWadFloat.Int(priceInWad)
	return priceInWad, nil
}

// SymbolUSDTToUSD converts BTCUSDT-style symbols to BTCUSD.
func SymbolUSDTToUSD(symbol string) string {
	if strings.HasSuffix(symbol, "USDT") {
		return strings.TrimSuffix(symbol, "USDT") + "USD"
	}
	return symbol
}
