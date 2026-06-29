package failover

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const failoverSecretHeader = "X-Failover-Secret"

// PeerClient calls peer failover HTTP endpoints.
type PeerClient struct {
	baseURL    string
	secret     string
	httpClient *http.Client
}

// NewPeerClient creates a client for outbound promote/demote calls.
func NewPeerClient(baseURL, secret string, timeout time.Duration) *PeerClient {
	if timeout <= 0 {
		timeout = 300 * time.Millisecond
	}
	return &PeerClient{
		baseURL: baseURL,
		secret:  secret,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// Promote asks the peer to start signing the given symbols.
func (c *PeerClient) Promote(ctx context.Context, req PromoteRequest) (PromoteResponse, error) {
	var resp PromoteResponse
	err := c.postJSON(ctx, "/internal/failover/promote", req, &resp)
	return resp, err
}

// Demote asks the peer to stop signing the given symbols.
func (c *PeerClient) Demote(ctx context.Context, req DemoteRequest) (DemoteResponse, error) {
	var resp DemoteResponse
	err := c.postJSON(ctx, "/internal/failover/demote", req, &resp)
	return resp, err
}

func (c *PeerClient) postJSON(ctx context.Context, path string, body, out any) error {
	start := time.Now()
	defer func() {
		failoverPeerRequestDuration.Observe(time.Since(start).Seconds())
	}()

	data, err := json.Marshal(body)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.secret != "" {
		httpReq.Header.Set(failoverSecretHeader, c.secret)
	}

	httpResp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer httpResp.Body.Close()

	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return err
	}
	if httpResp.StatusCode >= 500 {
		return fmt.Errorf("peer %s: status %d: %s", path, httpResp.StatusCode, string(respBody))
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("decode peer response: %w", err)
	}
	return nil
}
