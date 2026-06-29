package provider

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
	"github.com/syndicate/backend/services/signed-price-server/types"
)

const (
	defaultReadNewWSMessage   = 50 * time.Millisecond
	defaultMaxConnectionTime  = time.Hour * 23 // should be < 24h
	defaultPingDuration       = 15 * time.Second
	disabledPingDuration      = time.Duration(0)
	startingReconnectDuration = 5 * time.Second
	maxRetryMultiplier        = 25 // max retry duration: 52m5s
)

type (
	MessageHandler func(int, *WebsocketConnection, []byte)

	WebsocketConnection struct {
		parentCtx           context.Context
		websocketCtx        context.Context
		websocketCancelFunc context.CancelFunc
		providerName        types.ProviderName
		websocketURL        url.URL
		subscriptionMsgs    []interface{}
		messageHandler      MessageHandler
		pingDuration        time.Duration
		pingMessageType     uint
		logger              zerolog.Logger

		mtx              sync.Mutex
		client           *websocket.Conn
		reconnectCounter uint

		// lastSequence tracks Coinbase Advanced Trade envelope sequence_num for
		// this connection only. Reset on each successful dial. seqInitialized
		// distinguishes "no frame seen yet" from a genuine sequence value of 0,
		// so a gap across the first frames (e.g. 0 -> 2) is still detected.
		lastSequence   atomic.Int64
		seqInitialized atomic.Bool
	}

	// WebsocketController defines a provider agnostic websocket handler
	// that manages reconnecting, subscribing, and receiving messages.
	WebsocketController struct {
		parentCtx    context.Context
		providerName types.ProviderName
		websocketURL url.URL
		logger       zerolog.Logger
		connections  []*WebsocketConnection
	}
)

func NewWebsocketController(
	ctx context.Context,
	providerName types.ProviderName,
	websocketURL url.URL,
	subscriptionMsgs []interface{},
	messageHandler MessageHandler,
	pingDuration time.Duration,
	pingMessageType uint,
	logger zerolog.Logger,
) *WebsocketController {
	connections := make([]*WebsocketConnection, 0, 1)
	if len(subscriptionMsgs) > 0 {
		connections = append(connections, &WebsocketConnection{
			parentCtx:        ctx,
			providerName:     providerName,
			websocketURL:     websocketURL,
			subscriptionMsgs: subscriptionMsgs,
			messageHandler:   messageHandler,
			pingDuration:     pingDuration,
			pingMessageType:  pingMessageType,
			logger:           logger,
		})
	}

	return &WebsocketController{
		parentCtx:    ctx,
		providerName: providerName,
		websocketURL: websocketURL,
		logger:       logger,
		connections:  connections,
	}
}

func (wsc *WebsocketController) StartConnections() {
	for _, conn := range wsc.connections {
		go conn.start()
	}
}

// ForceReconnectAll closes every connection on this controller so the reconnect
// machinery dials again. Used by the book_mid staleness watchdog to recover a
// feed that has silently stopped streaming a product while the socket stays open.
func (wsc *WebsocketController) ForceReconnectAll() {
	for _, conn := range wsc.connections {
		conn.ForceReconnect()
	}
}

// AddWebsocketConnection adds a new websocket connection to subribe to a
// new pair.
func (wsc *WebsocketController) AddWebsocketConnection(
	msgs []interface{},
	messageHandler MessageHandler,
	pingDuration time.Duration,
	pingMessageType uint,
) {
	if len(msgs) == 0 {
		return
	}
	conn := &WebsocketConnection{
		parentCtx:        wsc.parentCtx,
		providerName:     wsc.providerName,
		websocketURL:     wsc.websocketURL,
		subscriptionMsgs: msgs,
		messageHandler:   messageHandler,
		pingDuration:     pingDuration,
		pingMessageType:  pingMessageType,
		logger:           wsc.logger,
	}
	wsc.connections = append(wsc.connections, conn)
	go conn.start()
}

// start will continuously loop and attempt connecting to the websocket
// until a successful connection is made. It then starts the ping
// service and read listener in new go routines and sends a subscription
// message using the passed in subscription message.
func (conn *WebsocketConnection) start() {
	connectTicker := time.NewTicker(time.Millisecond)
	defer connectTicker.Stop()

	for {
		if err := conn.connect(); err != nil {
			conn.logger.Error().Err(err).Msg("websocket connect failed")
			select {
			case <-conn.parentCtx.Done():
				return
			case <-connectTicker.C:
				connectTicker.Reset(conn.iterateRetryCounter())
				continue
			}
		}

		go conn.readWebSocket()
		go conn.pingLoop()

		if err := conn.subscribeAll(); err != nil {
			conn.logger.Error().Err(err).Msg("websocket subscribe failed")
			conn.close()
			continue
		}
		return
	}
}

// connect dials the websocket and sets the client to the established connection.
func (conn *WebsocketConnection) connect() error {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()

	conn.logger.Debug().Msg("connecting to websocket")
	connection, resp, err := websocket.DefaultDialer.Dial(conn.websocketURL.String(), nil)
	if err != nil {
		return fmt.Errorf(types.ErrWebsocketDial.Error(), conn.providerName, err)
	}
	defer resp.Body.Close()
	conn.client = connection
	conn.websocketCtx, conn.websocketCancelFunc = context.WithCancel(conn.parentCtx)
	conn.client.SetPingHandler(conn.pingHandler)
	conn.reconnectCounter = 0
	conn.lastSequence.Store(0)
	conn.seqInitialized.Store(false)
	recordProviderWSConnected(conn.providerName, 1)
	return nil
}

func (conn *WebsocketConnection) iterateRetryCounter() time.Duration {
	if conn.reconnectCounter < 25 {
		conn.reconnectCounter++
	}
	multiplier := math.Pow(float64(conn.reconnectCounter), 2)
	return startingReconnectDuration * time.Duration(multiplier)
}

// subscribeAll sends every subscription message on this connection sequentially.
func (conn *WebsocketConnection) subscribeAll() error {
	if len(conn.subscriptionMsgs) == 0 {
		return nil
	}
	telemetryWebsocketSubscribeCurrencyPairs(conn.providerName, len(conn.subscriptionMsgs))
	for _, msg := range conn.subscriptionMsgs {
		conn.logger.Debug().Interface("msg", msg).Msg("sending subscription message")
		if err := conn.SendJSON(msg); err != nil {
			return fmt.Errorf(types.ErrWebsocketSend.Error(), conn.providerName, err)
		}
	}
	return nil
}

// ForceReconnect closes the underlying *websocket.Conn so the read loop errors
// and the existing reconnect machinery dials again. Used when the message
// handler detects an unrecoverable condition such as an L2 sequence gap that
// requires a fresh snapshot.
func (conn *WebsocketConnection) ForceReconnect() {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()
	conn.seqInitialized.Store(false)
	conn.lastSequence.Store(0)
	if conn.client == nil {
		return
	}
	_ = conn.client.Close()
}

// SendJSON sends a json message to the websocket connection using the connections
// mutex to ensure multiple writes do not happen at once.
func (conn *WebsocketConnection) SendJSON(msg interface{}) error {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()

	if conn.client == nil {
		return nil
	}
	if err := conn.client.WriteJSON(msg); err != nil {
		return fmt.Errorf(types.ErrWebsocketSend.Error(), conn.providerName, err)
	}
	return nil
}

// ping sends a ping to the server every defaultPingDuration
func (conn *WebsocketConnection) pingLoop() {
	if conn.pingDuration == disabledPingDuration {
		return // disable ping loop if disabledPingDuration
	}
	pingTicker := time.NewTicker(conn.pingDuration)
	defer pingTicker.Stop()

	for {
		err := conn.ping()
		if err != nil {
			return
		}
		select {
		case <-conn.websocketCtx.Done():
			return
		case <-pingTicker.C:
			continue
		}
	}
}

func (conn *WebsocketConnection) ping() error {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()

	if conn.client == nil {
		return fmt.Errorf("unable to ping closed connection")
	}
	err := conn.client.WriteMessage(int(conn.pingMessageType), ping)
	if err != nil {
		conn.logger.Error().Err(fmt.Errorf(types.ErrWebsocketSend.Error(), conn.providerName, err)).Msg("websocket ping failed")
	}
	return err
}

// readWebSocket continuously reads from the websocket and relays messages
// to the passed in messageHandler. On websocket error this function
// terminates and starts the reconnect process.
// Some providers (Binance) will only allow a valid connection for 24 hours
// so we manually disconnect and reconnect every 23 hours (defaultMaxConnectionTime)
func (conn *WebsocketConnection) readWebSocket() {
	reconnectTicker := time.NewTicker(defaultMaxConnectionTime)
	defer reconnectTicker.Stop()

	type readResult struct {
		messageType int
		bz          []byte
		err         error
	}
	// Buffered so the reader can stage a message even if the consumer loop is
	// momentarily busy; bounded to avoid unbounded growth under burst.
	msgChan := make(chan readResult, 50)

	// Single long-lived reader goroutine. It blocks on ReadMessage; when close()
	// cancels websocketCtx and shuts the underlying conn, ReadMessage returns an
	// error and the goroutine exits. The select on websocketCtx.Done guarantees a
	// clean exit even if the consumer loop has already returned (no leak).
	go func() {
		// Snapshot the client once; this reader's lifetime is bounded by this
		// connection (close() nils conn.client and shuts it down, ending the read).
		conn.mtx.Lock()
		client := conn.client
		conn.mtx.Unlock()
		if client == nil {
			return
		}

		for {
			messageType, bz, err := client.ReadMessage()
			select {
			case msgChan <- readResult{messageType, bz, err}:
			case <-conn.websocketCtx.Done():
				return
			}
			if err != nil {
				// Stop reading a broken/closed connection; the consumer loop
				// handles reconnect on receiving the errored message.
				return
			}
		}
	}()

	for {
		select {
		case <-conn.websocketCtx.Done():
			conn.close()
			return

		case msg := <-msgChan:
			if msg.err != nil {
				conn.logger.Error().Err(fmt.Errorf(types.ErrWebsocketRead.Error(), conn.providerName, msg.err)).Msg("websocket read failed")

				if websocket.IsUnexpectedCloseError(msg.err, websocket.CloseAbnormalClosure) {
					conn.logger.Warn().Str("provider", conn.providerName.String()).Err(msg.err).Msg("ERR_READING_WEB_SOCKET")
					conn.reconnect()
					return
				}
				conn.reconnect()
				return
			}
			conn.readSuccess(msg.messageType, msg.bz)

		case <-reconnectTicker.C:
			conn.reconnect()
			return
		}
	}
}

func (conn *WebsocketConnection) readSuccess(messageType int, bz []byte) {
	if len(bz) == 0 {
		return
	}
	// mexc and bitget do not send a valid pong response code so check for it here
	if string(bz) == "pong" {
		return
	}

	recordProviderWSMessage(conn.providerName)
	conn.messageHandler(messageType, conn, bz)
}

// close sends a close message to the websocket and sets the client to nil
func (conn *WebsocketConnection) close() {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()

	conn.logger.Debug().Msg("closing websocket")
	conn.websocketCancelFunc()
	if conn.client == nil {
		return
	}
	if err := conn.client.Close(); err != nil {
		conn.logger.Error().Err(fmt.Errorf(types.ErrWebsocketClose.Error(), conn.providerName, err)).Msg("websocket close failed")
	}
	conn.client = nil
	recordProviderWSConnected(conn.providerName, -1)
}

// reconnect closes the current websocket and starts a new connection process
func (conn *WebsocketConnection) reconnect() {
	conn.close()
	go conn.start()
	telemetryWebsocketReconnect(conn.providerName)
}

// pingHandler is called by the websocket library whenever a ping message is received
// and responds with a pong message to the server
func (conn *WebsocketConnection) pingHandler(string) error {
	conn.mtx.Lock()
	defer conn.mtx.Unlock()

	if conn.client == nil {
		return fmt.Errorf("unable to send pong on closed connection")
	}
	if err := conn.client.WriteMessage(websocket.PongMessage, []byte("pong")); err != nil {
		conn.logger.Error().Err(err).Msg("error sending pong")
	}
	return nil
}
