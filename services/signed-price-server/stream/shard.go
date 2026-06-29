package stream

import (
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
)

// appliedSub records the index membership currently applied for a client, so a
// later subscription change or disconnect can be removed cleanly without
// re-reading stale state.
type appliedSub struct {
	all     bool
	symbols []string
}

// shard owns a disjoint subset of clients. All registry maps are mutated only
// by the shard goroutine (run), so they need no locking. Broadcasts, registers,
// unregisters, and subscription updates are serialized through its channels.
type shard struct {
	id  int
	hub *Hub

	broadcast  chan broadcastMsg
	register   chan registerReq
	unregister chan *Client
	subUpdate  chan subUpdateReq

	logger zerolog.Logger

	// Registry (shard goroutine only).
	clients  map[string]*Client                // ID -> client
	bySymbol map[string]map[*Client]struct{}   // symbol -> interested clients
	sendAll  map[*Client]struct{}              // clients with no filter
	applied  map[*Client]appliedSub            // currently-indexed membership
}

func (s *shard) run() {
	defer s.hub.wg.Done()
	for {
		select {
		case <-s.hub.ctx.Done():
			s.disconnectAll()
			return
		case req := <-s.register:
			s.handleRegister(req)
		case c := <-s.unregister:
			s.handleUnregister(c)
		case u := <-s.subUpdate:
			s.handleSubUpdate(u)
		case msg := <-s.broadcast:
			s.handleBroadcast(msg)
		}
	}
}

func (s *shard) handleRegister(req registerReq) {
	h := s.hub
	if h.maxConnections > 0 && atomic.LoadInt64(&h.connCount) >= int64(h.maxConnections) {
		connectionsRejected.Inc()
		s.logger.Debug().
			Str("client_id", req.client.ID).
			Int("max_connections", h.maxConnections).
			Msg("rejecting connection: at capacity")
		req.accepted <- false
		return
	}
	s.clients[req.client.ID] = req.client
	sub := subFromClient(req.client)
	s.addToIndex(req.client, sub)
	s.applied[req.client] = sub

	count := atomic.AddInt64(&h.connCount, 1)
	activeConnections.Set(float64(count))
	req.accepted <- true
	s.logger.Debug().
		Str("client_id", req.client.ID).
		Int64("total_clients", count).
		Msg("client connected")
}

func (s *shard) handleUnregister(client *Client) {
	if _, ok := s.clients[client.ID]; !ok {
		return // already gone; ignore duplicate unregister
	}
	delete(s.clients, client.ID)
	if sub, ok := s.applied[client]; ok {
		s.removeFromIndex(client, sub)
		delete(s.applied, client)
	}
	close(client.SendCh)
	client.Close()

	count := atomic.AddInt64(&s.hub.connCount, -1)
	activeConnections.Set(float64(count))
	s.logger.Debug().
		Str("client_id", client.ID).
		Int64("total_clients", count).
		Msg("client disconnected")
}

func (s *shard) handleSubUpdate(u subUpdateReq) {
	if _, ok := s.clients[u.client.ID]; !ok {
		return // disconnected before the update was processed
	}
	if old, ok := s.applied[u.client]; ok {
		s.removeFromIndex(u.client, old)
	}
	u.client.UpdateSubscription(u.symbols)
	sub := subFromClient(u.client)
	s.addToIndex(u.client, sub)
	s.applied[u.client] = sub
}

func (s *shard) handleBroadcast(msg broadcastMsg) {
	start := time.Now()

	for client := range s.sendAll {
		s.deliver(client, msg)
	}
	if set := s.bySymbol[msg.symbol]; set != nil {
		for client := range set {
			s.deliver(client, msg)
		}
	}

	broadcastLatency.Observe(time.Since(start).Seconds())
}

func (s *shard) deliver(client *Client, msg broadcastMsg) {
	sent, coalesced := client.EnqueuePrice(msg.symbol, msg.data)
	if sent {
		messagesSent.Inc()
	}
	if coalesced {
		messagesCoalesced.Inc()
	}
	if !sent {
		messagesDropped.Inc()
		atomic.AddUint64(&s.hub.dropCount, 1)
	}
}

func (s *shard) disconnectAll() {
	for id, client := range s.clients {
		client.Close()
		delete(s.clients, id)
	}
}

// addToIndex / removeFromIndex maintain the symbol-keyed subscriber sets. A
// client is either in sendAll (no filter) or in zero-or-more per-symbol sets,
// never both.
func (s *shard) addToIndex(client *Client, sub appliedSub) {
	if sub.all {
		s.sendAll[client] = struct{}{}
		return
	}
	for _, sym := range sub.symbols {
		set := s.bySymbol[sym]
		if set == nil {
			set = make(map[*Client]struct{})
			s.bySymbol[sym] = set
		}
		set[client] = struct{}{}
	}
}

func (s *shard) removeFromIndex(client *Client, sub appliedSub) {
	if sub.all {
		delete(s.sendAll, client)
		return
	}
	for _, sym := range sub.symbols {
		if set := s.bySymbol[sym]; set != nil {
			delete(set, client)
			if len(set) == 0 {
				delete(s.bySymbol, sym)
			}
		}
	}
}

// subFromClient derives index membership from the client's current Symbols map.
func subFromClient(client *Client) appliedSub {
	m, _ := client.Symbols.Load().(map[string]bool)
	if len(m) == 0 {
		return appliedSub{} // send nothing
	}
	if m[SendAllSymbol] {
		return appliedSub{all: true}
	}
	syms := make([]string, 0, len(m))
	for k := range m {
		syms = append(syms, k)
	}
	return appliedSub{symbols: syms}
}
