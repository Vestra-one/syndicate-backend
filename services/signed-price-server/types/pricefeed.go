package types

import (
	"fmt"
	"strings"
)

// PriceFeedMode selects how spot price is derived from exchange data.
type PriceFeedMode string

const (
	// PriceFeedLastTrade uses last trade (Binance @trade; Coinbase ticker price).
	PriceFeedLastTrade PriceFeedMode = "last_trade"
	// PriceFeedBookMid uses midpoint of best bid and best ask.
	PriceFeedBookMid PriceFeedMode = "book_mid"
)

// ParsePriceFeedMode parses and validates s.
func ParsePriceFeedMode(s string) (PriceFeedMode, error) {
	switch PriceFeedMode(strings.TrimSpace(s)) {
	case PriceFeedLastTrade:
		return PriceFeedLastTrade, nil
	case PriceFeedBookMid:
		return PriceFeedBookMid, nil
	case "":
		return PriceFeedLastTrade, nil
	default:
		return "", fmt.Errorf("unknown price_feed mode %q (allowed: last_trade, book_mid)", s)
	}
}
