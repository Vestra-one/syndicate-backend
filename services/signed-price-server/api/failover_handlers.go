package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/syndicate/backend/services/signed-price-server/failover"
)

const failoverSecretHeader = "X-Failover-Secret"

func (s *Server) handleFailoverPromote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.failover == nil || !s.failover.Enabled() {
		http.Error(w, "failover disabled", http.StatusNotFound)
		return
	}
	if !s.authorizeFailover(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req failover.PromoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	resp := s.failover.HandlePromote(r.Context(), req)
	status := http.StatusOK
	if !resp.Accepted {
		status = http.StatusConflict
	}
	writeFailoverJSON(w, status, resp)
}

func (s *Server) handleFailoverDemote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.failover == nil || !s.failover.Enabled() {
		http.Error(w, "failover disabled", http.StatusNotFound)
		return
	}
	if !s.authorizeFailover(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req failover.DemoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	resp := s.failover.HandleDemote(r.Context(), req)
	writeFailoverJSON(w, http.StatusOK, resp)
}

func (s *Server) handleFailoverStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.failover == nil || !s.failover.Enabled() {
		http.Error(w, "failover disabled", http.StatusNotFound)
		return
	}
	if !s.authorizeFailover(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	resp := s.failover.Status()
	writeFailoverJSON(w, http.StatusOK, resp)
}

func (s *Server) authorizeFailover(r *http.Request) bool {
	secret := s.failover.SharedSecret()
	if secret == "" {
		// No secret configured: allowed only for local single-node use. Production
		// deployments with failover.enabled are required to set the secret (enforced
		// at startup in cmd/bot), so this branch is unreachable there.
		return true
	}
	got := r.Header.Get(failoverSecretHeader)
	// Constant-time comparison to avoid leaking the secret via response timing.
	return subtle.ConstantTimeCompare([]byte(got), []byte(secret)) == 1
}

func writeFailoverJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
