package provider

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	bookMidEmitTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "book_mid_emit_total",
		Help: "Total book_mid heartbeat emissions submitted for signing",
	}, []string{"symbol", "exchange"})

	bookMidEmitSkipped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "book_mid_emit_skipped_total",
		Help: "Skipped book_mid emit ticks",
	}, []string{"symbol", "reason"})

	bookMidBookAgeSeconds = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "book_mid_book_age_seconds",
		Help: "Seconds since last BBO WebSocket update",
	}, []string{"symbol"})

	bookMidPaused = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "book_mid_paused",
		Help: "1 if symbol book_mid feed is paused (stale or not ready)",
	}, []string{"symbol"})

	bookMidWSUpdates = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "book_mid_ws_updates_total",
		Help: "BBO WebSocket updates applied to snapshot store",
	}, []string{"provider", "symbol"})

	coinbaseL2UpdatesApplied = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinbase_l2_updates_applied_total",
		Help: "Per-symbol count of Coinbase Advanced Trade level2 update entries applied to the local book",
	}, []string{"symbol"})

	coinbaseL2SequenceGap = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinbase_l2_sequence_gap_total",
		Help: "Per-symbol count of detected sequence gaps that forced a reconnect",
	}, []string{"symbol"})

	coinbaseL2BookLevels = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "coinbase_l2_book_levels",
		Help: "Current depth on the local Coinbase level2 book per side",
	}, []string{"symbol", "side"})

	coinbaseL2StaleReconnect = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinbase_l2_stale_reconnect_total",
		Help: "Per-symbol count of stale-book watchdog triggered Advanced Trade reconnects",
	}, []string{"symbol"})
)

func recordCoinbaseL2StaleReconnect(symbol string) {
	coinbaseL2StaleReconnect.WithLabelValues(symbol).Inc()
}

func recordCoinbaseL2UpdatesApplied(symbol string, n int) {
	if n <= 0 {
		return
	}
	coinbaseL2UpdatesApplied.WithLabelValues(symbol).Add(float64(n))
}

func recordCoinbaseL2SequenceGap(symbol string) {
	coinbaseL2SequenceGap.WithLabelValues(symbol).Inc()
}

func setCoinbaseL2BookLevels(symbol string, bids, asks int) {
	coinbaseL2BookLevels.WithLabelValues(symbol, "bid").Set(float64(bids))
	coinbaseL2BookLevels.WithLabelValues(symbol, "ask").Set(float64(asks))
}

func recordBookMidWSUpdate(provider, symbol string) {
	bookMidWSUpdates.WithLabelValues(provider, symbol).Inc()
}

func recordBookMidEmit(symbol, exchange string) {
	bookMidEmitTotal.WithLabelValues(symbol, exchange).Inc()
}

func recordBookMidSkipped(symbol, reason string) {
	bookMidEmitSkipped.WithLabelValues(symbol, reason).Inc()
}

func setBookMidObservability(symbol string, bookAgeSec float64, paused bool) {
	bookMidBookAgeSeconds.WithLabelValues(symbol).Set(bookAgeSec)
	pausedVal := 0.0
	if paused {
		pausedVal = 1
	}
	bookMidPaused.WithLabelValues(symbol).Set(pausedVal)
}
