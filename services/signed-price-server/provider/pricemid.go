package provider

import (
	"fmt"
	"math/big"
	"strings"
)

// MidPriceFromBestBidAsk returns (bid+ask)/2 as a decimal string suitable for priceToWad.
// It rejects non-positive sides and inverted books (bid > ask).
func MidPriceFromBestBidAsk(bidStr, askStr string) (string, error) {
	bidStr = strings.TrimSpace(bidStr)
	askStr = strings.TrimSpace(askStr)
	if bidStr == "" || askStr == "" {
		return "", fmt.Errorf("empty bid or ask")
	}

	bid := new(big.Float).SetPrec(256)
	if _, ok := bid.SetString(bidStr); !ok {
		return "", fmt.Errorf("invalid bid %q", bidStr)
	}
	ask := new(big.Float).SetPrec(256)
	if _, ok := ask.SetString(askStr); !ok {
		return "", fmt.Errorf("invalid ask %q", askStr)
	}
	if bid.Sign() <= 0 || ask.Sign() <= 0 {
		return "", fmt.Errorf("bid and ask must be positive")
	}
	if bid.Cmp(ask) > 0 {
		return "", fmt.Errorf("bid exceeds ask")
	}

	two := big.NewFloat(2.0)
	two.SetPrec(256)
	mid := new(big.Float).SetPrec(256)
	mid.Add(bid, ask)
	mid.Quo(mid, two)
	return mid.Text('f', -1), nil
}
