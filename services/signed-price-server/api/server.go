package api

import (
	"context"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
	"github.com/syndicate/backend/services/signed-price-server/failover"
	"github.com/syndicate/backend/services/signed-price-server/store"
	"github.com/syndicate/backend/services/signed-price-server/stream"
)

// Server is the HTTP server for WebSocket and REST endpoints
type Server struct {
	httpServer  *http.Server
	hub         *stream.Hub
	store       *store.SignedPriceStore
	bboStore    *bbo.SnapshotStore
	bookMidKeys []bbo.Key
	maxBookAge  time.Duration
	startedAt   time.Time
	failover    *failover.Controller
	metricsPath string
	logger      zerolog.Logger
}

// NewServer creates a new HTTP server
func NewServer(
	addr string,
	hub *stream.Hub,
	priceStore *store.SignedPriceStore,
	bboStore *bbo.SnapshotStore,
	bookMidKeys []bbo.Key,
	maxBookAge time.Duration,
	startedAt time.Time,
	failoverCtrl *failover.Controller,
	metricsPath string,
	logger zerolog.Logger,
) *Server {
	if startedAt.IsZero() {
		startedAt = time.Now()
	}

	s := &Server{
		hub:         hub,
		store:       priceStore,
		bboStore:    bboStore,
		bookMidKeys: bookMidKeys,
		maxBookAge:  maxBookAge,
		startedAt:   startedAt,
		failover:    failoverCtrl,
		metricsPath: metricsPath,
		logger:      logger.With().Str("component", "api_server").Logger(),
	}

	// Create mux
	mux := http.NewServeMux()

	// Register endpoints
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/prices", s.handlePrices)
	mux.HandleFunc("/prices/at", s.handlePriceAt)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/internal/failover/promote", s.handleFailoverPromote)
	mux.HandleFunc("/internal/failover/demote", s.handleFailoverDemote)
	mux.HandleFunc("/internal/failover/status", s.handleFailoverStatus)
	if metricsPath != "" {
		mux.Handle(metricsPath, promhttp.Handler())
	}

	// Create HTTP server
	s.httpServer = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      0, // No timeout for WebSocket
		IdleTimeout:       120 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1MB
	}

	return s
}

// Start starts the server
func (s *Server) Start() error {
	s.logger.Info().Str("addr", s.httpServer.Addr).Msg("starting HTTP server")
	return s.httpServer.ListenAndServe()
}

// Stop gracefully stops the server
func (s *Server) Stop(ctx context.Context) error {
	s.logger.Info().Msg("stopping HTTP server")
	return s.httpServer.Shutdown(ctx)
}
