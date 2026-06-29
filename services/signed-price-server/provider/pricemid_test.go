package provider

import "testing"

func TestMidPriceFromBestBidAsk(t *testing.T) {
	t.Parallel()
	mid, err := MidPriceFromBestBidAsk("100", "102")
	if err != nil {
		t.Fatal(err)
	}
	if mid != "101" {
		t.Fatalf("expected 101, got %q", mid)
	}
}

func TestMidPriceFromBestBidAsk_errors(t *testing.T) {
	t.Parallel()
	_, err := MidPriceFromBestBidAsk("", "1")
	if err == nil {
		t.Fatal("expected error")
	}
	_, err = MidPriceFromBestBidAsk("1", "")
	if err == nil {
		t.Fatal("expected error")
	}
	_, err = MidPriceFromBestBidAsk("-1", "2")
	if err == nil {
		t.Fatal("expected error")
	}
	_, err = MidPriceFromBestBidAsk("3", "2")
	if err == nil {
		t.Fatal("expected error")
	}
}
