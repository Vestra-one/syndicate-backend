package signing

import (
	"context"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/rs/zerolog"
)

func newTestPool(t *testing.T) (*WorkerPool, common.Address) {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	privHex := hex.EncodeToString(crypto.FromECDSA(key))
	wp, err := NewWorkerPool(context.Background(), privHex, 1, 1, 1, zerolog.Nop())
	if err != nil {
		t.Fatalf("new worker pool: %v", err)
	}
	return wp, addr
}

// ethSignedHash recomputes keccak256("\x19Ethereum Signed Message:\n32" ||
// keccak256(token || priceInWad || timestamp)), matching signTrade and the
// Solidity verifier. Locking this in a test guards the on-chain wire format.
func ethSignedHash(token common.Address, priceInWad *big.Int, timestamp int64) []byte {
	priceBytes := make([]byte, 32)
	priceInWad.FillBytes(priceBytes)
	tsBytes := make([]byte, 32)
	new(big.Int).SetInt64(timestamp).FillBytes(tsBytes)

	msg := make([]byte, 0, 84)
	msg = append(msg, token.Bytes()...)
	msg = append(msg, priceBytes...)
	msg = append(msg, tsBytes...)
	messageHash := crypto.Keccak256Hash(msg)

	prefixed := append([]byte("\x19Ethereum Signed Message:\n32"), messageHash.Bytes()...)
	return crypto.Keccak256Hash(prefixed).Bytes()
}

// TestSignTrade_SignatureRecoverable locks the EIP-191 signing wire format: the
// signer address recovered from (r, s, v) over the reconstructed hash must equal
// the worker pool's key.
func TestSignTrade_SignatureRecoverable(t *testing.T) {
	wp, addr := newTestPool(t)

	token := common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf")
	priceInWad, _ := new(big.Int).SetString("100550000000000000000", 10)
	trade := TradeUpdate{
		Token:      token,
		Symbol:     "BTCUSD",
		Price:      "100.55",
		PriceInWad: priceInWad,
		Timestamp:  1700000000000,
		Exchange:   "coinbase",
		Bid:        "100.50",
		Ask:        "100.60",
		BookAgeMs:  7,
	}

	signed, err := wp.signTrade(trade)
	if err != nil {
		t.Fatalf("signTrade: %v", err)
	}

	r, err := hex.DecodeString(strings.TrimPrefix(signed.R, "0x"))
	if err != nil {
		t.Fatalf("decode r: %v", err)
	}
	s, err := hex.DecodeString(strings.TrimPrefix(signed.S, "0x"))
	if err != nil {
		t.Fatalf("decode s: %v", err)
	}
	if signed.V != 27 && signed.V != 28 {
		t.Fatalf("expected v in {27,28}, got %d", signed.V)
	}

	sig := make([]byte, 65)
	copy(sig[0:32], r)
	copy(sig[32:64], s)
	sig[64] = signed.V - 27

	hash := ethSignedHash(token, priceInWad, trade.Timestamp)
	pub, err := crypto.SigToPub(hash, sig)
	if err != nil {
		t.Fatalf("recover pubkey: %v", err)
	}
	if got := crypto.PubkeyToAddress(*pub); got != addr {
		t.Fatalf("recovered signer %s, want %s", got, addr)
	}
}

// TestSignTrade_MetaPopulatedForBookMid verifies the observational sidecar
// carries bid/ask/book_age_ms for book_mid emissions.
func TestSignTrade_MetaPopulatedForBookMid(t *testing.T) {
	wp, _ := newTestPool(t)
	trade := TradeUpdate{
		Token:      common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
		Symbol:     "BTCUSD",
		Price:      "100.55",
		PriceInWad: big.NewInt(1),
		Timestamp:  1,
		Bid:        "100.50",
		Ask:        "100.60",
		BookAgeMs:  42,
	}
	signed, err := wp.signTrade(trade)
	if err != nil {
		t.Fatalf("signTrade: %v", err)
	}
	if signed.Meta == nil {
		t.Fatal("expected meta to be populated for book_mid")
	}
	if signed.Meta.Bid != "100.50" || signed.Meta.Ask != "100.60" || signed.Meta.BookAgeMs != 42 {
		t.Fatalf("unexpected meta: %+v", signed.Meta)
	}
}

// TestSignTrade_NoMetaForLastTrade verifies last_trade emissions (no bid/ask/age)
// omit the meta sidecar entirely.
func TestSignTrade_NoMetaForLastTrade(t *testing.T) {
	wp, _ := newTestPool(t)
	trade := TradeUpdate{
		Token:      common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
		Symbol:     "BTCUSD",
		Price:      "100.55",
		PriceInWad: big.NewInt(1),
		Timestamp:  1,
	}
	signed, err := wp.signTrade(trade)
	if err != nil {
		t.Fatalf("signTrade: %v", err)
	}
	if signed.Meta != nil {
		t.Fatalf("expected nil meta for last_trade, got %+v", signed.Meta)
	}
}
