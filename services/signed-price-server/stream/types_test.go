package stream

import "testing"

func TestClient_EnqueuePrice_coalesceToLatest(t *testing.T) {
	t.Parallel()
	// Buffer of 1: second send must coalesce or replace.
	client := NewClient(nil, []string{"BTCUSD"}, 1)
	client.connected.Store(true)

	payloadA := []byte(`{"symbol":"BTCUSD","price":"1"}`)
	payloadB := []byte(`{"symbol":"BTCUSD","price":"2"}`)

	sent, _ := client.EnqueuePrice("BTCUSD", payloadA)
	if !sent {
		t.Fatal("expected first enqueue to succeed")
	}

	sent, coalesced := client.EnqueuePrice("BTCUSD", payloadB)
	if sent {
		// Replaced one slot and sent B — acceptable.
		select {
		case got := <-client.SendCh:
			if string(got) != string(payloadB) {
				t.Fatalf("expected latest payload, got %s", got)
			}
		default:
		}
		return
	}
	if !coalesced {
		t.Fatal("expected coalesce on full buffer")
	}
	v, ok := client.pendingLatest.Load("BTCUSD")
	if !ok {
		t.Fatal("expected pending latest stored")
	}
	if string(v.([]byte)) != string(payloadB) {
		t.Fatalf("expected payload B in pending, got %s", v)
	}
}

func TestClient_EnqueuePrice_disconnectedNoSend(t *testing.T) {
	t.Parallel()
	client := NewClient(nil, nil, 4)
	client.connected.Store(false)
	sent, coalesced := client.EnqueuePrice("BTCUSD", []byte("{}"))
	if sent || coalesced {
		t.Fatal("expected no send when disconnected")
	}
}
