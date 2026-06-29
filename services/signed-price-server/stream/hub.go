package stream

import (
	"context"
	"hash/fnv"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/rs/zerolog"
)

var (
	activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_active_connections",
		Help: "Number of active WebSocket connections",
	})

	messagesSent = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_messages_sent_total",
		Help: "Total number of WebSocket messages sent",
	})

	messagesDropped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_messages_dropped_total",
		Help: "Total number of messages dropped (slow clients)",
	})

	messagesCoalesced = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_messages_coalesced_total",
		Help: "Total number of messages coalesced to latest per symbol",
	})

	broadcastLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "ws_broadcast_latency_seconds",
		Help:    "Per-shard WebSocket broadcast fan-out latency",
		Buckets: prometheus.ExponentialBuckets(0.00001, 2, 15),
	})

	connectionsRejected = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_connections_rejected_total",
		Help: "Total number of WebSocket connections rejected (max_connections limit)",
	})
)

// Shard sizing: one broadcast goroutine per shard fans out to its slice of
// clients in parallel, so the fan-out cost per update is O(N / numShards).
const (
	minShards = 8
	maxShards = 16
)

func numShards() int {
	n := runtime.NumCPU()
	if n < minShards {
		return minShards
	}
	if n > maxShards {
		return maxShards
	}
	return n
}

// shardIndex deterministically maps a client ID to a shard.
func shardIndex(clientID string, n int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(clientID))
	return int(h.Sum32() % uint32(n))
}

// registerReq carries a client and a channel to signal whether registration was accepted.
type registerReq struct {
	client   *Client
	accepted chan bool
}

// subUpdateReq carries a subscription change routed to the owning shard so the
// symbol index is mutated by the shard goroutine alone (no shared lock).
type subUpdateReq struct {
	client  *Client
	symbols []string
}

// broadcastMsg is a pre-serialized price routed to every shard. data is
// immutable and shared read-only across all clients.
type broadcastMsg struct {
	symbol string
	data   []byte
}

// Hub owns M shards. Each shard runs its own goroutine and registry so
// connection churn and fan-out never contend on a shared lock.
type Hub struct {
	ctx            context.Context
	cancel         context.CancelFunc
	shards         []*shard
	logger         zerolog.Logger
	wg             sync.WaitGroup
	maxConnections int // 0 or negative = unlimited
	clientSendBuf  int

	// Metrics (shared across shards)
	connCount int64
	msgCount  uint64
	dropCount uint64
}

// NewHub creates a new sharded WebSocket hub. maxConnections caps concurrent
// connections across all shards; 0 or negative means no limit.
func NewHub(ctx context.Context, broadcastQueueSize, maxConnections, clientSendBufferSize int, logger zerolog.Logger) *Hub {
	ctx, cancel := context.WithCancel(ctx)
	if clientSendBufferSize <= 0 {
		clientSendBufferSize = 256
	}
	if broadcastQueueSize <= 0 {
		broadcastQueueSize = 1024
	}

	h := &Hub{
		ctx:            ctx,
		cancel:         cancel,
		maxConnections: maxConnections,
		clientSendBuf:  clientSendBufferSize,
		logger:         logger.With().Str("component", "ws_hub").Logger(),
	}

	n := numShards()
	h.shards = make([]*shard, n)
	for i := 0; i < n; i++ {
		h.shards[i] = &shard{
			id:         i,
			hub:        h,
			broadcast:  make(chan broadcastMsg, broadcastQueueSize),
			register:   make(chan registerReq, 1000),
			unregister: make(chan *Client, 1000),
			subUpdate:  make(chan subUpdateReq, 1000),
			clients:    make(map[string]*Client),
			bySymbol:   make(map[string]map[*Client]struct{}),
			sendAll:    make(map[*Client]struct{}),
			applied:    make(map[*Client]appliedSub),
			logger:     h.logger.With().Int("shard", i).Logger(),
		}
	}
	return h
}

// Start starts all shard goroutines plus a metrics-logging goroutine.
func (h *Hub) Start() {
	h.logger.Info().Int("shards", len(h.shards)).Msg("starting sharded WebSocket hub")
	for _, s := range h.shards {
		h.wg.Add(1)
		go s.run()
	}
	h.wg.Add(1)
	go h.metricsLoop()
}

// Stop gracefully stops the hub and all shards.
func (h *Hub) Stop() {
	h.logger.Info().Msg("stopping WebSocket hub")
	h.cancel()
	h.wg.Wait()
	h.logger.Info().
		Int64("final_conn_count", atomic.LoadInt64(&h.connCount)).
		Uint64("total_messages", atomic.LoadUint64(&h.msgCount)).
		Uint64("total_dropped", atomic.LoadUint64(&h.dropCount)).
		Msg("WebSocket hub stopped")
}

// Broadcast fans a pre-serialized price out to every shard (non-blocking). Each
// shard then delivers only to its interested subscribers. data must not be
// mutated after this call. Returns false if any shard's queue was full.
func (h *Hub) Broadcast(symbol string, data []byte) bool {
	msg := broadcastMsg{symbol: symbol, data: data}
	delivered := true
	for _, s := range h.shards {
		select {
		case s.broadcast <- msg:
		default:
			delivered = false
			h.logger.Warn().Str("symbol", symbol).Int("shard", s.id).Msg("shard broadcast queue full")
		}
	}
	atomic.AddUint64(&h.msgCount, 1)
	return delivered
}

// Register registers a new client with its owning shard. Blocks until the shard
// processes the request. Returns false if rejected (at connection limit).
func (h *Hub) Register(client *Client) bool {
	s := h.shards[shardIndex(client.ID, len(h.shards))]
	accepted := make(chan bool, 1)
	select {
	case s.register <- registerReq{client: client, accepted: accepted}:
		return <-accepted
	case <-h.ctx.Done():
		return false
	}
}

// Unregister removes a client via its owning shard.
func (h *Hub) Unregister(client *Client) {
	s := h.shards[shardIndex(client.ID, len(h.shards))]
	select {
	case s.unregister <- client:
	case <-h.ctx.Done():
	}
}

// updateSubscription routes a subscription change to the client's shard so the
// symbol index stays consistent with client.Symbols.
func (h *Hub) updateSubscription(client *Client, symbols []string) {
	s := h.shards[shardIndex(client.ID, len(h.shards))]
	select {
	case s.subUpdate <- subUpdateReq{client: client, symbols: symbols}:
	case <-h.ctx.Done():
	}
}

// ClientSendBufferSize returns per-client outbound queue capacity.
func (h *Hub) ClientSendBufferSize() int {
	return h.clientSendBuf
}

// GetMetrics returns current metrics.
func (h *Hub) GetMetrics() (connections int64, messages, dropped uint64) {
	return atomic.LoadInt64(&h.connCount),
		atomic.LoadUint64(&h.msgCount),
		atomic.LoadUint64(&h.dropCount)
}

func (h *Hub) metricsLoop() {
	defer h.wg.Done()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-ticker.C:
			h.logger.Info().
				Int64("active_connections", atomic.LoadInt64(&h.connCount)).
				Uint64("messages_sent", atomic.LoadUint64(&h.msgCount)).
				Uint64("messages_dropped", atomic.LoadUint64(&h.dropCount)).
				Msg("WebSocket hub metrics")
		}
	}
}

// HandleClientMessages handles incoming messages from the client.
func (h *Hub) HandleClientMessages(client *Client) {
	defer h.Unregister(client)

	for {
		var msg SubscriptionMessage
		err := client.Conn.ReadJSON(&msg)
		if err != nil {
			// Benign client disconnects (normal closure, going away, no status
			// code, abnormal drop) are expected and not logged. Anything else is
			// a protocol-level anomaly worth a warning — but it is a remote peer's
			// behavior, not a server error.
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
				websocket.CloseAbnormalClosure,
			) {
				h.logger.Warn().Err(err).Str("client_id", client.ID).Msg("unexpected websocket close")
			}
			break
		}

		switch msg.Action {
		case "subscribe":
			h.updateSubscription(client, msg.Symbols)
			h.logger.Debug().
				Str("client_id", client.ID).
				Interface("symbols", msg.Symbols).
				Msg("client subscription updated")

		case "unsubscribe":
			// Unsubscribe from all: empty list => send nothing.
			h.updateSubscription(client, []string{})
			h.logger.Debug().
				Str("client_id", client.ID).
				Msg("client unsubscribed from all")
		}
	}
}

// WritePump sends messages from the hub to the client.
func (h *Hub) WritePump(client *Client) {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		client.Close()
		h.Unregister(client)
	}()

	for {
		select {
		case <-client.CloseCh:
			return

		case jsonBytes, ok := <-client.SendCh:
			if !ok {
				// SendCh closed by shard on unregister; exit without spinning.
				return
			}
			client.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := client.SendMessage(jsonBytes); err != nil {
				h.logger.Debug().
					Err(err).
					Str("client_id", client.ID).
					Msg("failed to send message")
				return
			}
			client.FlushPending()

		case <-ticker.C:
			client.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := client.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// NewClient creates a new WebSocket client with the given outbound send buffer
// capacity. If symbols is nil or empty, the client receives all prices.
func NewClient(conn *websocket.Conn, symbols []string, sendBufferSize int) *Client {
	if sendBufferSize <= 0 {
		sendBufferSize = 256
	}
	client := &Client{
		ID:      uuid.New().String(),
		Conn:    conn,
		SendCh:  make(chan []byte, sendBufferSize),
		CloseCh: make(chan struct{}),
	}

	if len(symbols) == 0 {
		// No filter: send all.
		client.Symbols.Store(map[string]bool{SendAllSymbol: true})
	} else {
		symbolMap := make(map[string]bool, len(symbols))
		for _, symbol := range symbols {
			symbolMap[symbol] = true
		}
		client.Symbols.Store(symbolMap)
	}
	client.connected.Store(true)

	return client
}

// SendMessage sends pre-encoded JSON bytes to the client.
func (c *Client) SendMessage(jsonBytes []byte) error {
	if !c.connected.Load() {
		return nil
	}
	return c.Conn.WriteMessage(websocket.TextMessage, jsonBytes)
}

// UpdateSubscription updates the client's symbol subscriptions.
// Empty symbols means "unsubscribe from all" (store empty map = send none).
// Non-empty means subscribe only to those symbols.
func (c *Client) UpdateSubscription(symbols []string) {
	if len(symbols) == 0 {
		c.Symbols.Store(map[string]bool{})
		return
	}
	symbolMap := make(map[string]bool, len(symbols))
	for _, symbol := range symbols {
		symbolMap[symbol] = true
	}
	c.Symbols.Store(symbolMap)
}
