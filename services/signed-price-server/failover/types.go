package failover

import "time"

// Role identifies steady-state ownership for a symbol.
type Role string

const (
	RolePrimary Role = "primary"
	RoleStandby Role = "standby"
)

// State is the per-symbol failover state machine value.
type State string

const (
	StateActive      State = "active"
	StateDelegating  State = "delegating"
	StateDelegated   State = "delegated"
	StateRecovering  State = "recovering"
	StateStandbyWarm State = "standby_warm"
)

// Settings configures the failover controller (mapped from config at startup).
type Settings struct {
	Enabled            bool
	NodeID             string
	PeerNodeID         string
	PeerURL            string
	SharedSecret       string
	PromoteDebounce    time.Duration
	RecoverHysteresis  time.Duration
	PeerRequestTimeout time.Duration
	LeaseTTL           time.Duration
	LeaseRenew         time.Duration
	ClockSkewMargin    time.Duration
	Symbols            []SymbolSettings
}

// SymbolSettings binds a USD symbol to primary or standby role on this node.
type SymbolSettings struct {
	Symbol string
	Role   Role
}

// PromoteRequest is the JSON body for POST /internal/failover/promote.
type PromoteRequest struct {
	Symbols   []string `json:"symbols"`
	Epoch     uint64   `json:"epoch"`
	Reason    string   `json:"reason,omitempty"`
	BookAgeMs int64    `json:"book_age_ms,omitempty"`
	Source    string   `json:"source,omitempty"`
}

// DemoteRequest is the JSON body for POST /internal/failover/demote.
type DemoteRequest struct {
	Symbols []string `json:"symbols"`
	Epoch   uint64   `json:"epoch"`
	Source  string   `json:"source,omitempty"`
}

// SymbolStatus is per-symbol detail in API responses.
type SymbolStatus struct {
	Role           string `json:"role"`
	State          string `json:"state"`
	Epoch          uint64 `json:"epoch"`
	CanSign        bool   `json:"can_sign"`
	BookAgeMs      int64  `json:"book_age_ms,omitempty"`
	BookMidOK      bool   `json:"book_mid_ok,omitempty"`
	LastSignedAtMs int64  `json:"last_signed_at_ms,omitempty"`
}

// PromoteResponse is returned from promote handler and peer client.
type PromoteResponse struct {
	Accepted bool                    `json:"accepted"`
	Epoch    uint64                  `json:"epoch"`
	Reason   string                  `json:"reason,omitempty"`
	Symbols  map[string]SymbolStatus `json:"symbols,omitempty"`
}

// DemoteResponse is returned from demote handler and peer client.
type DemoteResponse struct {
	Accepted bool                    `json:"accepted"`
	Epoch    uint64                  `json:"epoch"`
	Reason   string                  `json:"reason,omitempty"`
	Symbols  map[string]SymbolStatus `json:"symbols,omitempty"`
}

// StatusResponse is returned from GET /internal/failover/status.
type StatusResponse struct {
	NodeID  string                  `json:"node_id"`
	PeerURL string                  `json:"peer_url,omitempty"`
	Symbols map[string]SymbolStatus `json:"symbols"`
}

// HealthSymbolStatus is exposed on GET /health under failover.
type HealthSymbolStatus struct {
	State   string `json:"state"`
	Epoch   uint64 `json:"epoch"`
	Role    string `json:"role"`
	CanSign bool   `json:"can_sign"`
}
