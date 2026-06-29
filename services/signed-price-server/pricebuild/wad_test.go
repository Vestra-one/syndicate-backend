package pricebuild

import "testing"

func TestPriceToWad(t *testing.T) {
	t.Parallel()
	w, err := PriceToWad("101.5")
	if err != nil {
		t.Fatal(err)
	}
	if w.Sign() <= 0 {
		t.Fatal("expected positive wad")
	}
}
