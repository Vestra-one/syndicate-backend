package api

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/syndicate/backend/services/signed-price-server/stream"
)

var priceServerVersion = "dev"

func init() {
	if data, err := os.ReadFile("VERSION"); err == nil {
		priceServerVersion = strings.TrimSpace(string(data))
	}
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// handleWebSocket handles WebSocket streaming endpoint
// GET /ws?symbols=BTCUSDT,ETHUSDT
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error().Err(err).Msg("failed to upgrade connection")
		return
	}

	// Parse symbol filter from query params
	symbolsParam := r.URL.Query().Get("symbols")
	var symbols []string
	if symbolsParam != "" {
		symbols = strings.Split(symbolsParam, ",")
	}

	// Create WebSocket client
	client := stream.NewClient(conn, symbols, s.hub.ClientSendBufferSize())

	// Register with hub; reject if at connection limit (response already sent via Upgrade)
	if !s.hub.Register(client) {
		s.logger.Warn().
			Str("client_id", client.ID).
			Str("remote_addr", r.RemoteAddr).
			Msg("rejecting WebSocket connection: server at capacity")
		_ = conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "server at capacity"))
		conn.Close()
		return
	}

	s.logger.Info().
		Str("client_id", client.ID).
		Str("remote_addr", r.RemoteAddr).
		Interface("symbols", symbols).
		Msg("new WebSocket client connected")

	// Send initial message
	initialMsg := map[string]interface{}{
		"type":      "connected",
		"client_id": client.ID,
		"message":   "WebSocket connection established",
		"timestamp": time.Now().Unix(),
	}
	conn.WriteJSON(initialMsg)

	// Send latest prices for subscribed symbols
	if len(symbols) > 0 {
		for _, symbol := range symbols {
			if price, ok := s.store.GetLatest(symbol); ok {
				if jsonBytes, err := json.Marshal(price); err == nil {
					client.SendMessage(jsonBytes)
				}
			}
		}
	} else {
		// Send all latest prices if no filter
		allPrices := s.store.GetAll()
		for _, price := range allPrices {
			if jsonBytes, err := json.Marshal(price); err == nil {
				client.SendMessage(jsonBytes)
			}
		}
	}

	// Start goroutines for reading and writing
	go s.hub.HandleClientMessages(client)
	go s.hub.WritePump(client)
}

// handlePriceAt handles exact second lookup for settlement.
// GET /prices/at?symbol=BTCUSD&timestamp=1715000000
func (s *Server) handlePriceAt(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	timestampRaw := strings.TrimSpace(r.URL.Query().Get("timestamp"))
	timestampSec, err := strconv.ParseInt(timestampRaw, 10, 64)
	if symbol == "" || err != nil || timestampSec <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error": "symbol and positive integer timestamp are required",
		})
		return
	}

	price, ok, err := s.store.GetAt(symbol, timestampSec)
	if err != nil {
		s.logger.Error().Err(err).Str("symbol", symbol).Int64("timestamp", timestampSec).Msg("price archive lookup failed")
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{"error": "price lookup failed"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{"error": "price not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"price":     price,
		"symbol":    symbol,
		"timestamp": timestampSec,
	})
}

// handlePrices handles REST endpoint for latest prices
// GET /prices?symbols=BTCUSDT,ETHUSDT
func (s *Server) handlePrices(w http.ResponseWriter, r *http.Request) {
	symbolsParam := r.URL.Query().Get("symbols")

	var prices []interface{}

	if symbolsParam == "" {
		// Return all prices
		allPrices := s.store.GetAll()
		for _, price := range allPrices {
			prices = append(prices, price)
		}
	} else {
		// Return specific symbols
		symbols := strings.Split(symbolsParam, ",")
		for _, symbol := range symbols {
			if price, ok := s.store.GetLatest(symbol); ok {
				prices = append(prices, price)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"prices":    prices,
		"count":     len(prices),
		"timestamp": time.Now().Unix(),
	})
}

// handleHealth handles health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	connections, messages, dropped := s.hub.GetMetrics()

	bookMidOK := true
	failoverOK := true
	status := "healthy"
	statusCode := http.StatusOK

	resp := map[string]interface{}{
		"service": "ryze-price-server",
		"version": priceServerVersion,
		"websocket": map[string]interface{}{
			"connections": connections,
			"messages":    messages,
			"dropped":     dropped,
		},
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}

	if s.bboStore != nil && len(s.bookMidKeys) > 0 {
		bookMid := s.bboStore.HealthReport(s.bookMidKeys, s.maxBookAge, s.startedAt)
		resp["book_mid"] = bookMid
		bookMidOK = !s.bboStore.AnyPaused(s.bookMidKeys, s.maxBookAge, s.startedAt)
		resp["book_mid_ok"] = bookMidOK
	}

	if s.failover != nil && s.failover.Enabled() {
		failoverSnap, leaders := s.failover.HealthSnapshot()
		resp["failover"] = failoverSnap
		resp["signing_leader"] = leaders
		failoverOK = s.failover.FailoverOK()
		resp["failover_ok"] = failoverOK
	}

	healthy := bookMidOK && failoverOK
	resp["ok"] = healthy
	if !healthy {
		status = "unhealthy"
		statusCode = http.StatusServiceUnavailable
	}
	resp["status"] = status

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(resp)
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
