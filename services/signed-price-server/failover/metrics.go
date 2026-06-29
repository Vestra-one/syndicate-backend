package failover

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	failoverState = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "failover_state",
		Help: "Failover state per symbol (1=active signing, 0=not signing)",
	}, []string{"symbol", "state"})

	failoverHandoffsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "failover_handoffs_total",
		Help: "Total failover handoffs",
	}, []string{"symbol", "direction"})

	failoverPeerRequestDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "failover_peer_request_duration_seconds",
		Help:    "Duration of outbound failover peer HTTP requests",
		Buckets: prometheus.ExponentialBuckets(0.01, 2, 12),
	})

	failoverBlockedSignsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "failover_blocked_signs_total",
		Help: "Signing/broadcast attempts blocked by failover gate",
	}, []string{"symbol"})

	failoverBothStaleTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "failover_both_stale_total",
		Help: "Promote rejected because peer book is also stale",
	}, []string{"symbol"})

	failoverNotSigningSeconds = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "failover_primary_not_signing_seconds",
		Help: "Seconds a primary-role symbol has been unable to sign (0 while signing). Alert when this stays high — it indicates a stuck or prolonged failover.",
	}, []string{"symbol"})
)

func setFailoverStateMetric(symbol string, state State, canSign bool) {
	val := 0.0
	if canSign {
		val = 1.0
	}
	failoverState.WithLabelValues(symbol, string(state)).Set(val)
}

func setFailoverNotSigningSeconds(symbol string, secs float64) {
	failoverNotSigningSeconds.WithLabelValues(symbol).Set(secs)
}

// BlockedSign records a signing/broadcast blocked by the failover gate.
func BlockedSign(symbol string) {
	failoverBlockedSignsTotal.WithLabelValues(symbol).Inc()
}
