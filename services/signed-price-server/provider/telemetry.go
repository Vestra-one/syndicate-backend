package provider

import (
	"github.com/cosmos/cosmos-sdk/telemetry"
	"github.com/hashicorp/go-metrics"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

const (
	MessageTypeCandle        = MessageType("candle")
	MessageTypeTicker        = MessageType("ticker")
	MessageTypeTrade         = MessageType("trade")
	MessageTypeBookTicker    = MessageType("book_ticker")
	MessageTypeTickerTrade   = MessageType("ticker_trade")
	MessageTypeTickerMid     = MessageType("ticker_mid")
	MessageTypeUsdtUsdUpdate = MessageType("usdtusd_update")
	MessageTypeL2Snapshot    = MessageType("l2_snapshot")
	MessageTypeL2Update      = MessageType("l2_update")
	MessageTypeHeartbeat     = MessageType("heartbeat")
)

type (
	MessageType string
)

// String cast provider MessageType to string.
func (mt MessageType) String() string {
	return string(mt)
}

// providerLabel returns a label based on the provider name.
func providerLabel(n types.ProviderName) metrics.Label {
	return metrics.Label{
		Name:  "provider",
		Value: n.String(),
	}
}

// messageTypeLabel returns a label based on the message type.
func messageTypeLabel(mt MessageType) metrics.Label {
	return metrics.Label{
		Name:  "type",
		Value: mt.String(),
	}
}

// telemetryWebsocketReconnect gives an standard way to add
// `price_feeder_websocket_reconnect` metric.
func telemetryWebsocketReconnect(n types.ProviderName) {
	telemetry.IncrCounterWithLabels(
		[]string{
			"websocket",
			"reconnect",
		},
		1,
		[]metrics.Label{
			providerLabel(n),
		},
	)
}

// telemetryWebsocketSubscribeCurrencyPairs gives an standard way to add
// `price_feeder_websocket_subscribe_currency_pairs{provider="x"}` metric.
func telemetryWebsocketSubscribeCurrencyPairs(n types.ProviderName, incr int) {
	telemetry.IncrCounterWithLabels(
		[]string{
			"websocket",
			"subscribe",
			"currency_pairs",
		},
		float32(incr),
		[]metrics.Label{
			providerLabel(n),
		},
	)
}

// telemetryWebsocketMessage gives an standard way to add
// `price_feeder_websocket_message{type="x", provider="x"}` metric.
func telemetryWebsocketMessage(n types.ProviderName, mt MessageType) {
	telemetry.IncrCounterWithLabels(
		[]string{
			"websocket",
			"message",
		},
		1,
		[]metrics.Label{
			providerLabel(n),
			messageTypeLabel(mt),
		},
	)
}

// TelemetryFailure gives an standard way to add
// `price_feeder_failure_provider{type="x", provider="x"}` metric.
func TelemetryFailure(n types.ProviderName, mt MessageType) {
	telemetry.IncrCounterWithLabels(
		[]string{
			"failure",
		},
		1,
		[]metrics.Label{
			providerLabel(n),
			messageTypeLabel(mt),
		},
	)
}
