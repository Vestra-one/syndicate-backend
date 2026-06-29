package signing

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/rs/zerolog"
)

var (
	signingLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "signing_latency_seconds",
		Help:    "ECDSA signing latency",
		Buckets: prometheus.ExponentialBuckets(0.00001, 2, 15), // 10μs to 163ms
	})

	signingTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "signing_total",
		Help: "Total signatures created",
	})

	signingErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "signing_errors_total",
		Help: "Total signing errors",
	})
)

// WorkerPool manages ECDSA signing workers
type WorkerPool struct {
	ctx          context.Context
	cancel       context.CancelFunc
	privateKey   *ecdsa.PrivateKey
	publicKeyHex string
	numWorkers   int
	tradeQueue   chan TradeUpdate
	signedQueue  chan SignedPrice
	wg           sync.WaitGroup
	stopOnce     sync.Once // ensures Stop() is idempotent (close signedQueue at most once)
	logger       zerolog.Logger

	// Metrics
	processed uint64
	errors    uint64
}

// NewWorkerPool creates a new signing worker pool
func NewWorkerPool(
	ctx context.Context,
	privateKeyHex string,
	numWorkers int,
	tradeQueueSize int,
	signedQueueSize int,
	logger zerolog.Logger,
) (*WorkerPool, error) {

	// Remove 0x prefix if present
	if len(privateKeyHex) > 2 && privateKeyHex[:2] == "0x" {
		privateKeyHex = privateKeyHex[2:]
	}

	privateKey, err := crypto.HexToECDSA(privateKeyHex)
	if err != nil {
		return nil, err
	}

	// Pre-compute public key
	publicKeyBytes := crypto.FromECDSAPub(&privateKey.PublicKey)
	publicKeyHex := hex.EncodeToString(publicKeyBytes)

	ctx, cancel := context.WithCancel(ctx)

	return &WorkerPool{
		ctx:          ctx,
		cancel:       cancel,
		privateKey:   privateKey,
		publicKeyHex: publicKeyHex,
		numWorkers:   numWorkers,
		tradeQueue:   make(chan TradeUpdate, tradeQueueSize),
		signedQueue:  make(chan SignedPrice, signedQueueSize),
		logger:       logger.With().Str("component", "signing_pool").Logger(),
	}, nil
}

// Start starts all workers
func (wp *WorkerPool) Start() {
	wp.logger.Info().Int("workers", wp.numWorkers).Msg("starting signing worker pool")

	for i := 0; i < wp.numWorkers; i++ {
		wp.wg.Add(1)
		go wp.worker(i)
	}
}

// Stop gracefully stops all workers and closes the signed prices channel.
// It is safe to call Stop() multiple times; subsequent calls are no-ops.
func (wp *WorkerPool) Stop() {
	wp.stopOnce.Do(func() {
		wp.logger.Info().Msg("stopping signing worker pool")
		wp.cancel()
		wp.wg.Wait()
		close(wp.signedQueue)
		wp.logger.Info().
			Uint64("processed", atomic.LoadUint64(&wp.processed)).
			Uint64("errors", atomic.LoadUint64(&wp.errors)).
			Msg("signing worker pool stopped")
	})
}

// SubmitTrade submits a trade for signing (non-blocking)
func (wp *WorkerPool) SubmitTrade(trade TradeUpdate) bool {
	select {
	case wp.tradeQueue <- trade:
		return true
	default:
		wp.logger.Warn().Str("symbol", trade.Symbol).Msg("trade queue full")
		return false
	}
}

// SignedPrices returns the channel of signed prices
func (wp *WorkerPool) SignedPrices() <-chan SignedPrice {
	return wp.signedQueue
}

// GetMetrics returns current metrics
func (wp *WorkerPool) GetMetrics() (processed, errors uint64) {
	return atomic.LoadUint64(&wp.processed), atomic.LoadUint64(&wp.errors)
}

// worker is the main worker loop
func (wp *WorkerPool) worker(id int) {
	defer wp.wg.Done()

	logger := wp.logger.With().Int("worker_id", id).Logger()
	logger.Debug().Msg("worker started")

	for {
		select {
		case <-wp.ctx.Done():
			logger.Debug().Msg("worker stopped")
			return

		case trade := <-wp.tradeQueue:
			startTime := time.Now()
			signed, err := wp.signTrade(trade)
			if err != nil {
				atomic.AddUint64(&wp.errors, 1)
				signingErrors.Inc()
				logger.Error().Err(err).Str("symbol", trade.Symbol).Msg("signing failed")
				continue
			}

			// Record latency
			signingLatency.Observe(time.Since(startTime).Seconds())

			// Send to output (non-blocking)
			select {
			case wp.signedQueue <- signed:
				atomic.AddUint64(&wp.processed, 1)
				signingTotal.Inc()
			default:
				logger.Warn().Str("symbol", signed.Symbol).Msg("signed queue full")
			}
		}
	}
}

// signTrade signs a trade with ECDSA using EIP-191 format (Solidity compatible)
func (wp *WorkerPool) signTrade(trade TradeUpdate) (SignedPrice, error) {
	// Create message hash: keccak256(abi.encodePacked(token, priceInWad, timestamp))
	// This matches the Solidity contract's verification:

	// Convert priceInWad to bytes32 (big-endian, padded to 32 bytes)
	priceBytes := make([]byte, 32)
	trade.PriceInWad.FillBytes(priceBytes)

	// Convert timestamp to bytes32 (big-endian, padded to 32 bytes)
	timestampBytes := make([]byte, 32)
	timestampBig := new(big.Int).SetInt64(trade.Timestamp)
	timestampBig.FillBytes(timestampBytes)

	// Concatenate: token (20 bytes) + priceInWad (32 bytes) + timestamp (32 bytes)
	message := make([]byte, 0, 84)
	message = append(message, trade.Token.Bytes()...) // 20 bytes
	message = append(message, priceBytes...)          // 32 bytes
	message = append(message, timestampBytes...)      // 32 bytes

	// Hash the message
	messageHash := crypto.Keccak256Hash(message)

	// Apply EIP-191 prefix: "\x19Ethereum Signed Message:\n32" + messageHash
	// This matches the Solidity contract:
	// bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
	prefix := []byte("\x19Ethereum Signed Message:\n32")
	prefixedMessage := append(prefix, messageHash.Bytes()...)
	ethSignedMessageHash := crypto.Keccak256Hash(prefixedMessage)

	// Sign the hash
	signature, err := crypto.Sign(ethSignedMessageHash.Bytes(), wp.privateKey)
	if err != nil {
		return SignedPrice{}, err
	}

	// Split signature into v, r, s components (Solidity format)
	// crypto.Sign returns [R || S || V] where V is 0 or 1
	// Solidity expects V to be 27 or 28
	r := signature[0:32]
	s := signature[32:64]
	v := signature[64] + 27

	signed := SignedPrice{
		Token:      trade.Token.Hex(),
		Symbol:     trade.Symbol,
		Price:      trade.Price,
		PriceInWad: trade.PriceInWad.String(),
		Quantity:   trade.Quantity,
		Timestamp:  trade.Timestamp,
		TradeID:    trade.TradeID,
		Exchange:   trade.Exchange,
		V:          v,
		R:          "0x" + hex.EncodeToString(r),
		S:          "0x" + hex.EncodeToString(s),
		PublicKey:  wp.publicKeyHex,
		SignedAt:   time.Now().UnixMilli(),
	}
	if trade.Bid != "" || trade.Ask != "" || trade.BookAgeMs > 0 {
		signed.Meta = &SignedPriceMeta{Bid: trade.Bid, Ask: trade.Ask, BookAgeMs: trade.BookAgeMs}
	}
	return signed, nil
}
