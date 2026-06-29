package failover

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/syndicate/backend/services/signed-price-server/bbo"
)

// SignGate gates signing and broadcast by symbol.
type SignGate interface {
	CanSign(symbol string) bool
}

// StalenessObserver receives book_mid tick observations from the emitter.
type StalenessObserver interface {
	OnBookMidTick(symbol string, bookAge time.Duration, paused bool)
}

// BroadcastObserver records successful broadcasts for demote ack metadata.
type BroadcastObserver interface {
	OnBroadcast(symbol string, signedAtMs int64)
}

// Controller coordinates per-symbol active/standby signing leases.
type Controller struct {
	enabled bool
	nodeID  string
	peerID  string
	peerURL string

	mu              sync.RWMutex
	symbols         map[string]*symbolEntry
	bboStore        *bbo.SnapshotStore
	maxBookAge      time.Duration
	debounce        time.Duration
	hysteresis      time.Duration
	leaseTTL        time.Duration
	leaseRenew      time.Duration
	clockSkewMargin time.Duration
	peer            *PeerClient
	sharedSecret    string
	logger          zerolog.Logger
}

type symbolEntry struct {
	role         Role
	state        State
	epoch        uint64
	activeEpoch  uint64
	bboKey       bbo.Key
	hasBboKey    bool
	staleStart   time.Time
	freshStart   time.Time
	lastSignedAt int64

	// promoteDispatched is true once a promote RPC for the current epoch has been
	// (or is about to be) sent to the peer. While it is true, a local book
	// recovery must NOT resume signing directly — the peer may already be active,
	// so recovery is routed through an explicit demote instead (prevents dual-sign).
	promoteDispatched bool

	// leaseExpiry (standby) is when the current delegated signing lease lapses; the
	// standby may sign only while now < leaseExpiry. Renewed on each promote.
	leaseExpiry time.Time
	// lastDelegationSend (primary) is the last time a promote/renew was sent to the
	// peer. The reclaim deadline is derived from it so a recovering primary can
	// resume once the peer's lease is guaranteed expired, even if unreachable.
	lastDelegationSend time.Time
	// reclaimDeadline (primary) is the earliest time this primary may resume signing
	// after its book recovers without a peer demote ack (lease guaranteed expired).
	reclaimDeadline time.Time
	// notSigningStart (primary) marks when this primary last became unable to sign,
	// feeding the failover_primary_not_signing_seconds gauge.
	notSigningStart time.Time
}

// symEpoch pairs a symbol with the epoch to act on, so per-symbol peer calls
// (lease renewals) use each symbol's own epoch rather than a shared batch epoch.
type symEpoch struct {
	sym   string
	epoch uint64
}

// NewController builds a failover controller from config. When failover is disabled,
// CanSign returns true for all symbols.
func NewController(
	cfg Settings,
	bboStore *bbo.SnapshotStore,
	maxBookAge time.Duration,
	bboKeys []bbo.Key,
	logger zerolog.Logger,
) *Controller {
	leaseTTL := cfg.LeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = time.Second
	}
	leaseRenew := cfg.LeaseRenew
	if leaseRenew <= 0 {
		leaseRenew = 200 * time.Millisecond
	}
	clockSkewMargin := cfg.ClockSkewMargin
	if clockSkewMargin <= 0 {
		clockSkewMargin = 500 * time.Millisecond
	}
	c := &Controller{
		enabled:         cfg.Enabled,
		nodeID:          cfg.NodeID,
		peerID:          cfg.PeerNodeID,
		peerURL:         cfg.PeerURL,
		symbols:         make(map[string]*symbolEntry),
		bboStore:        bboStore,
		maxBookAge:      maxBookAge,
		debounce:        cfg.PromoteDebounce,
		hysteresis:      cfg.RecoverHysteresis,
		leaseTTL:        leaseTTL,
		leaseRenew:      leaseRenew,
		clockSkewMargin: clockSkewMargin,
		sharedSecret:    cfg.SharedSecret,
		logger:          logger.With().Str("component", "failover").Logger(),
	}

	keyBySymbol := make(map[string]bbo.Key, len(bboKeys))
	for _, k := range bboKeys {
		keyBySymbol[k.Symbol] = k
	}

	for _, symCfg := range cfg.Symbols {
		role := symCfg.Role
		state := StateStandbyWarm
		if role == RolePrimary {
			state = StateActive
		}
		ent := &symbolEntry{
			role:  role,
			state: state,
		}
		if k, ok := keyBySymbol[symCfg.Symbol]; ok {
			ent.bboKey = k
			ent.hasBboKey = true
		}
		c.symbols[symCfg.Symbol] = ent
		setFailoverStateMetric(symCfg.Symbol, state, c.canSignLocked(symCfg.Symbol, ent))
	}

	if cfg.Enabled && cfg.PeerURL != "" {
		c.peer = NewPeerClient(cfg.PeerURL, c.sharedSecret, cfg.PeerRequestTimeout)
	}

	return c
}

// Enabled reports whether failover coordination is active.
func (c *Controller) Enabled() bool {
	return c.enabled
}

// SharedSecret returns the configured secret for inbound auth.
func (c *Controller) SharedSecret() string {
	return c.sharedSecret
}

// CanSign implements SignGate.
func (c *Controller) CanSign(symbol string) bool {
	if !c.enabled {
		return true
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	ent, ok := c.symbols[symbol]
	if !ok {
		return true
	}
	return c.canSignLocked(symbol, ent)
}

func (c *Controller) canSignLocked(symbol string, ent *symbolEntry) bool {
	switch ent.state {
	case StateActive:
		if ent.role == RoleStandby {
			// A delegated standby may sign only while its lease is unexpired.
			return ent.activeEpoch > 0 && ent.activeEpoch == ent.epoch && time.Now().Before(ent.leaseExpiry)
		}
		return ent.role == RolePrimary
	default:
		return false
	}
}

// OnBookMidTick implements StalenessObserver.
func (c *Controller) OnBookMidTick(symbol string, bookAge time.Duration, paused bool) {
	if !c.enabled {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	ent, ok := c.symbols[symbol]
	if !ok || ent.role != RolePrimary {
		return
	}

	switch ent.state {
	case StateActive:
		if paused {
			if ent.staleStart.IsZero() {
				ent.staleStart = time.Now()
			} else if time.Since(ent.staleStart) >= c.debounce {
				c.beginPromoteLocked(symbol, ent, bookAge)
			}
		} else {
			ent.staleStart = time.Time{}
		}
	case StateDelegating:
		if !paused {
			ent.staleStart = time.Time{}
			if ent.promoteDispatched {
				// The promote RPC was already sent, so the peer may have promoted
				// itself. Do NOT resume signing locally (that would dual-sign).
				// Move to delegated and let the recovery path demote the peer
				// before we sign again. Epoch is left monotonic (never decremented).
				ent.state = StateDelegated
				setFailoverStateMetric(symbol, ent.state, false)
				c.logger.Info().Str("symbol", symbol).Uint64("epoch", ent.epoch).Msg("book fresh after promote dispatch; recovering via peer demote")
			} else {
				// No promote has been sent yet (still within debounce/before the
				// first tick dispatched it): the peer never heard anything, so it
				// is safe to resume signing locally.
				ent.state = StateActive
				setFailoverStateMetric(symbol, ent.state, true)
				c.logger.Info().Str("symbol", symbol).Msg("cancelled promote; book fresh before dispatch")
			}
		}
	case StateDelegated:
		if paused {
			ent.freshStart = time.Time{}
		} else {
			if ent.freshStart.IsZero() {
				ent.freshStart = time.Now()
			} else if time.Since(ent.freshStart) >= c.hysteresis {
				c.beginRecoverLocked(symbol, ent)
			}
		}
	case StateRecovering:
		if paused {
			ent.state = StateDelegated
			ent.freshStart = time.Time{}
			setFailoverStateMetric(symbol, ent.state, false)
		}
	}
}

// OnBroadcast implements BroadcastObserver.
func (c *Controller) OnBroadcast(symbol string, signedAtMs int64) {
	if !c.enabled {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if ent, ok := c.symbols[symbol]; ok {
		ent.lastSignedAt = signedAtMs
	}
}

// Run drives promote retries and recovery checks.
func (c *Controller) Run(ctx context.Context) {
	if !c.enabled {
		return
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.tick(ctx)
		}
	}
}

func (c *Controller) tick(ctx context.Context) {
	now := time.Now()
	c.mu.Lock()
	var promoteBatch []string
	var promoteEpoch uint64
	var demoteBatch []string
	var demoteEpoch uint64
	var renewItems []symEpoch

	for sym, ent := range c.symbols {
		if ent.role == RoleStandby {
			// Expire a delegated lease so a standby that has lost contact with the
			// primary stops signing on its own; the primary relies on this to
			// reclaim safely without having to reach the peer.
			if ent.state == StateActive && !ent.leaseExpiry.IsZero() && !now.Before(ent.leaseExpiry) {
				ent.state = StateStandbyWarm
				ent.activeEpoch = 0
				ent.leaseExpiry = time.Time{}
				setFailoverStateMetric(sym, ent.state, false)
				c.logger.Warn().Str("symbol", sym).Msg("delegated lease expired; standby stopped signing")
			}
			continue
		}
		if ent.role != RolePrimary {
			continue
		}

		// Track how long this primary has been unable to sign (0 while signing).
		if c.canSignLocked(sym, ent) {
			ent.notSigningStart = time.Time{}
			setFailoverNotSigningSeconds(sym, 0)
		} else {
			if ent.notSigningStart.IsZero() {
				ent.notSigningStart = now
			}
			setFailoverNotSigningSeconds(sym, now.Sub(ent.notSigningStart).Seconds())
		}

		switch ent.state {
		case StateDelegating:
			promoteBatch = append(promoteBatch, sym)
			// Mark the promote as dispatched so a concurrent book recovery
			// (OnBookMidTick) routes through demote instead of resuming locally.
			ent.promoteDispatched = true
			ent.lastDelegationSend = now
			if promoteEpoch == 0 {
				promoteEpoch = ent.epoch
			}
		case StateDelegated:
			if ent.hasBboKey && c.bboStore != nil && c.bboStore.IsFresh(ent.bboKey, c.maxBookAge) {
				// Our book recovered: stop renewing the peer's lease and, after
				// hysteresis, begin reclaiming.
				if ent.freshStart.IsZero() {
					ent.freshStart = now
				} else if now.Sub(ent.freshStart) >= c.hysteresis {
					c.beginRecoverLocked(sym, ent)
					demoteBatch = append(demoteBatch, sym)
					demoteEpoch = ent.epoch
				}
			} else {
				// Our book is still stale: keep the peer's lease alive so it keeps
				// signing. If these renews stop reaching the peer, its lease lapses.
				ent.freshStart = time.Time{}
				if now.Sub(ent.lastDelegationSend) >= c.leaseRenew {
					renewItems = append(renewItems, symEpoch{sym: sym, epoch: ent.epoch})
					ent.lastDelegationSend = now
				}
			}
		case StateRecovering:
			if !ent.reclaimDeadline.IsZero() && !now.Before(ent.reclaimDeadline) {
				// The peer's lease is guaranteed expired (so it has stopped signing),
				// even though we could not confirm via demote (peer unreachable).
				// Resume — this is the safety floor that breaks the stuck loop.
				ent.state = StateActive
				ent.reclaimDeadline = time.Time{}
				ent.freshStart = time.Time{}
				ent.promoteDispatched = false
				setFailoverStateMetric(sym, ent.state, true)
				c.logger.Warn().Str("symbol", sym).Uint64("epoch", ent.epoch).Msg("resumed signing via lease-expiry deadline (peer unconfirmed)")
			} else {
				demoteBatch = append(demoteBatch, sym)
				demoteEpoch = ent.epoch
			}
		}
	}
	c.mu.Unlock()

	if len(promoteBatch) > 0 && c.peer != nil {
		c.doPromote(ctx, promoteBatch, promoteEpoch)
	}
	if len(demoteBatch) > 0 && c.peer != nil {
		c.doDemote(ctx, demoteBatch, demoteEpoch)
	}
	if c.peer != nil {
		for _, it := range renewItems {
			c.doRenew(ctx, it.sym, it.epoch)
		}
	}
}

func (c *Controller) beginPromoteLocked(symbol string, ent *symbolEntry, bookAge time.Duration) {
	ent.epoch++
	ent.state = StateDelegating
	ent.staleStart = time.Time{}
	ent.promoteDispatched = false
	setFailoverStateMetric(symbol, ent.state, false)
	failoverHandoffsTotal.WithLabelValues(symbol, "promote").Inc()
	c.logger.Warn().
		Str("symbol", symbol).
		Uint64("epoch", ent.epoch).
		Dur("book_age", bookAge).
		Msg("book stale; delegating to peer")
}

func (c *Controller) beginRecoverLocked(symbol string, ent *symbolEntry) {
	ent.state = StateRecovering
	ent.freshStart = time.Time{}
	// Resume is allowed without a peer ack once the peer's lease is guaranteed
	// expired: lastDelegationSend + leaseTTL + clockSkewMargin. (Zero send time —
	// no promote ever left — yields a past deadline, i.e. immediate safe resume.)
	ent.reclaimDeadline = ent.lastDelegationSend.Add(c.leaseTTL + c.clockSkewMargin)
	setFailoverStateMetric(symbol, ent.state, false)
	failoverHandoffsTotal.WithLabelValues(symbol, "demote").Inc()
	c.logger.Info().Str("symbol", symbol).Uint64("epoch", ent.epoch).Dur("max_reclaim_wait", c.leaseTTL+c.clockSkewMargin).Msg("book fresh; recovering from peer")
}

func (c *Controller) doPromote(ctx context.Context, symbols []string, epoch uint64) {
	resp, err := c.peer.Promote(ctx, PromoteRequest{
		Symbols: symbols,
		Epoch:   epoch,
		Reason:  "book_stale",
		Source:  c.nodeID,
	})
	if err != nil {
		c.logger.Error().Err(err).Strs("symbols", symbols).Msg("peer promote failed")
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sym := range symbols {
		ent, ok := c.symbols[sym]
		if !ok || ent.state != StateDelegating || ent.epoch != epoch {
			continue
		}
		st, ok := resp.Symbols[sym]
		if resp.Accepted && ok && st.CanSign {
			ent.state = StateDelegated
			setFailoverStateMetric(sym, ent.state, false)
			c.logger.Info().Str("symbol", sym).Uint64("epoch", epoch).Msg("peer promote ack")
		} else {
			failoverBothStaleTotal.WithLabelValues(sym).Inc()
			c.logger.Warn().Str("symbol", sym).Str("reason", resp.Reason).Msg("peer promote rejected")
		}
	}
}

func (c *Controller) doDemote(ctx context.Context, symbols []string, epoch uint64) {
	resp, err := c.peer.Demote(ctx, DemoteRequest{
		Symbols: symbols,
		Epoch:   epoch,
		Source:  c.nodeID,
	})
	if err != nil {
		c.logger.Error().Err(err).Strs("symbols", symbols).Msg("peer demote failed")
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sym := range symbols {
		ent, ok := c.symbols[sym]
		if !ok || ent.state != StateRecovering || ent.epoch != epoch {
			continue
		}
		// Resume only once the peer has positively stood down for this symbol —
		// either it acked the demote, or it reports it is not signing (e.g. it
		// rejected the earlier promote and was never active). Without this, a
		// recovery that followed a rejected promote would never resume.
		st, hasStatus := resp.Symbols[sym]
		peerStoodDown := resp.Accepted || (hasStatus && !st.CanSign)
		if peerStoodDown {
			ent.state = StateActive
			ent.freshStart = time.Time{}
			ent.reclaimDeadline = time.Time{}
			ent.promoteDispatched = false
			setFailoverStateMetric(sym, ent.state, true)
			c.logger.Info().Str("symbol", sym).Uint64("epoch", epoch).Msg("peer stood down; resuming signing")
		}
	}
}

// doRenew re-sends a promote to extend the standby's delegation lease while our
// book stays stale. Failures are expected when the peer is unreachable (the
// standby's lease then lapses on its own) and are logged at debug.
func (c *Controller) doRenew(ctx context.Context, sym string, epoch uint64) {
	_, err := c.peer.Promote(ctx, PromoteRequest{
		Symbols: []string{sym},
		Epoch:   epoch,
		Reason:  "lease_renew",
		Source:  c.nodeID,
	})
	if err != nil {
		c.logger.Debug().Err(err).Str("symbol", sym).Msg("lease renew failed; standby lease will lapse if this persists")
	}
}

// HandlePromote processes an inbound promote request on the standby.
func (c *Controller) HandlePromote(_ context.Context, req PromoteRequest) PromoteResponse {
	resp := PromoteResponse{
		Epoch:   req.Epoch,
		Symbols: make(map[string]SymbolStatus),
	}
	if !c.enabled {
		resp.Accepted = false
		resp.Reason = "failover_disabled"
		return resp
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	allAccepted := true
	for _, sym := range req.Symbols {
		ent, ok := c.symbols[sym]
		if !ok || ent.role != RoleStandby {
			resp.Symbols[sym] = SymbolStatus{
				Role:    string(RoleStandby),
				State:   string(StateStandbyWarm),
				CanSign: false,
			}
			allAccepted = false
			continue
		}
		if req.Epoch < ent.epoch {
			resp.Symbols[sym] = c.symbolStatusLocked(sym, ent)
			allAccepted = false
			continue
		}
		if !ent.hasBboKey || c.bboStore == nil || !c.bboStore.IsFresh(ent.bboKey, c.maxBookAge) {
			resp.Symbols[sym] = c.symbolStatusLocked(sym, ent)
			allAccepted = false
			continue
		}
		wasActiveThisEpoch := ent.state == StateActive && ent.activeEpoch == req.Epoch
		ent.epoch = req.Epoch
		ent.activeEpoch = req.Epoch
		ent.state = StateActive
		// Grant/extend the delegated signing lease. Renewals (same epoch) refresh it.
		ent.leaseExpiry = time.Now().Add(c.leaseTTL)
		setFailoverStateMetric(sym, ent.state, true)
		resp.Symbols[sym] = c.symbolStatusLocked(sym, ent)
		if !wasActiveThisEpoch {
			c.logger.Info().Str("symbol", sym).Uint64("epoch", req.Epoch).Msg("promoted to active signing")
		}
	}
	resp.Accepted = allAccepted
	if !allAccepted {
		resp.Reason = "peer_book_stale"
	}
	return resp
}

// HandleDemote processes an inbound demote request on the standby.
func (c *Controller) HandleDemote(_ context.Context, req DemoteRequest) DemoteResponse {
	resp := DemoteResponse{
		Epoch:   req.Epoch,
		Symbols: make(map[string]SymbolStatus),
	}
	if !c.enabled {
		resp.Accepted = false
		resp.Reason = "failover_disabled"
		return resp
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	allAccepted := true
	for _, sym := range req.Symbols {
		ent, ok := c.symbols[sym]
		if !ok || ent.role != RoleStandby {
			allAccepted = false
			continue
		}
		if req.Epoch != ent.epoch {
			allAccepted = false
			resp.Symbols[sym] = c.symbolStatusLocked(sym, ent)
			continue
		}
		ent.state = StateStandbyWarm
		ent.activeEpoch = 0
		ent.leaseExpiry = time.Time{}
		setFailoverStateMetric(sym, ent.state, false)
		st := c.symbolStatusLocked(sym, ent)
		st.LastSignedAtMs = ent.lastSignedAt
		resp.Symbols[sym] = st
		c.logger.Info().Str("symbol", sym).Uint64("epoch", req.Epoch).Msg("demoted to standby")
	}
	resp.Accepted = allAccepted
	return resp
}

// Status returns current failover state for all managed symbols.
func (c *Controller) Status() StatusResponse {
	c.mu.RLock()
	defer c.mu.RUnlock()

	out := StatusResponse{
		NodeID:  c.nodeID,
		Symbols: make(map[string]SymbolStatus, len(c.symbols)),
	}
	if c.peerURL != "" {
		out.PeerURL = c.peerURL
	}
	for sym, ent := range c.symbols {
		out.Symbols[sym] = c.symbolStatusLocked(sym, ent)
	}
	return out
}

// HealthSnapshot returns failover fields for /health.
func (c *Controller) HealthSnapshot() (map[string]HealthSymbolStatus, map[string]string) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	failover := make(map[string]HealthSymbolStatus, len(c.symbols))
	leaders := make(map[string]string, len(c.symbols))
	for sym, ent := range c.symbols {
		canSign := c.canSignLocked(sym, ent)
		failover[sym] = HealthSymbolStatus{
			State:   string(ent.state),
			Epoch:   ent.epoch,
			Role:    string(ent.role),
			CanSign: canSign,
		}
		if canSign {
			leaders[sym] = c.nodeID
		} else if c.peerID != "" {
			leaders[sym] = c.peerID
		}
	}
	return failover, leaders
}

// FailoverOK is true when every primary-role symbol that should sign locally can,
// or is intentionally delegated with a healthy book on recovery path.
func (c *Controller) FailoverOK() bool {
	if !c.enabled {
		return true
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	for sym, ent := range c.symbols {
		if ent.role != RolePrimary {
			continue
		}
		if ent.state == StateDelegated || ent.state == StateDelegating {
			continue
		}
		if ent.state == StateActive && !c.canSignLocked(sym, ent) {
			return false
		}
	}
	return true
}

func (c *Controller) symbolStatusLocked(sym string, ent *symbolEntry) SymbolStatus {
	st := SymbolStatus{
		Role:    string(ent.role),
		State:   string(ent.state),
		Epoch:   ent.epoch,
		CanSign: c.canSignLocked(sym, ent),
	}
	if ent.hasBboKey && c.bboStore != nil {
		st.BookMidOK = c.bboStore.IsFresh(ent.bboKey, c.maxBookAge)
		if bid, ask, updatedAt, ready, ok := c.bboStore.Snapshot(ent.bboKey); ok && ready {
			_ = bid
			_ = ask
			st.BookAgeMs = time.Since(updatedAt).Milliseconds()
		}
	}
	return st
}
