package signing

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// TradeUpdate represents a raw trade from an exchange
type TradeUpdate struct {
	Token      common.Address `json:"token"`        // Token contract address
	Symbol     string         `json:"symbol"`       // Trading symbol (e.g., BTCUSDT)
	Price      string         `json:"price"`        // Price as string
	PriceInWad *big.Int       `json:"price_in_wad"` // Price in WAD (18 decimals)
	Quantity   string         `json:"quantity"`
	Timestamp  int64          `json:"timestamp"` // (in milliseconds!)
	TradeID    int64          `json:"trade_id"`
	Exchange   string         `json:"exchange"`

	// Bid / Ask are observational best-bid and best-ask in the SAME currency as Price.
	// They are populated only for book_mid emissions and are NOT part of the signed payload.
	Bid string `json:"-"`
	Ask string `json:"-"`

	// BookAgeMs is the age (ms) of the underlying BBO snapshot at emit time. Observational
	// only (book_mid emissions); NOT part of the signed payload.
	BookAgeMs int64 `json:"-"`
}

// SignedPriceMeta is observational sidecar metadata on SignedPrice. It is set only for
// book_mid emissions and carries the best bid / best ask used to compute the mid. The
// values are in the SAME currency as SignedPrice.Price, so verification is direct:
// (Meta.Bid + Meta.Ask) / 2 == Price for book_mid messages.
//
// Meta is NOT included in the signed message; clients verifying the ECDSA signature
// MUST ignore it.
type SignedPriceMeta struct {
	Bid string `json:"bid,omitempty"`
	Ask string `json:"ask,omitempty"`

	// BookAgeMs is the age (ms) of the BBO snapshot when the mid was computed, for
	// off-chain freshness audit. Observational only; NOT included in the signature.
	BookAgeMs int64 `json:"book_age_ms,omitempty"`
}

// SignedPrice represents a trade with ECDSA signature (Solidity compatible)
type SignedPrice struct {
	Token      string `json:"token"`        // Token address (hex)
	Symbol     string `json:"symbol"`       // Trading symbol
	Price      string `json:"price"`        // Original price string
	PriceInWad string `json:"price_in_wad"` // Price in WAD (uint256)
	Quantity   string `json:"quantity"`
	Timestamp  int64  `json:"timestamp"` // Unix milliseconds (matches the signed payload)
	TradeID    int64  `json:"trade_id"`
	Exchange   string `json:"exchange"`

	// Signature components (Solidity format)
	V uint8  `json:"v"` // Recovery ID + 27
	R string `json:"r"` // R component (bytes32)
	S string `json:"s"` // S component (bytes32)

	PublicKey string `json:"public_key"` // Hex-encoded public key (for reference)
	SignedAt  int64  `json:"signed_at"`  // Unix milliseconds

	// Meta carries observational best bid / best ask for book_mid emissions only.
	// Omitted for last_trade messages.
	Meta *SignedPriceMeta `json:"meta,omitempty"`
}
