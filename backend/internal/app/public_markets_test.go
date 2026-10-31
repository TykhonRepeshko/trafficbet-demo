package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestPostgresPublicMarketHistoryNeverExposesDrafts(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	open := integrationMarket(t, s, ctx, stream.ID)
	draft := open
	draft.Title = "Unpublished draft rules"
	draft.Status = MarketDraft
	if _, err := s.CreateMarket(ctx, draft); err != nil {
		t.Fatal(err)
	}
	settled := integrationMarket(t, s, ctx, stream.ID)
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET status='settled', actual_count=12 WHERE id=$1`, settled.ID); err != nil {
		t.Fatal(err)
	}
	voided := integrationMarket(t, s, ctx, stream.ID)
	if _, err := s.VoidMarket(ctx, voided.ID, "Camera stream was interrupted"); err != nil {
		t.Fatal(err)
	}
	api := &API{store: s, cfg: Config{FrontendOrigin: "http://localhost:4200"}}
	for _, tc := range []struct {
		query  string
		status int
		count  int
	}{
		{"", http.StatusOK, 3},
		{"?status=open", http.StatusOK, 1},
		{"?status=settled", http.StatusOK, 1},
		{"?status=void", http.StatusOK, 1},
		{"?status=draft", http.StatusBadRequest, 0},
		{"?status=unknown", http.StatusBadRequest, 0},
	} {
		w := accountTestRequest(api.Routes(), "GET", fmt.Sprintf("/api/streams/%d/markets%s", stream.ID, tc.query), "", nil)
		if w.Code != tc.status {
			t.Fatalf("filter %q: got %d: %s", tc.query, w.Code, w.Body.String())
		}
		if tc.status != http.StatusOK {
			continue
		}
		var markets []Market
		if err := json.Unmarshal(w.Body.Bytes(), &markets); err != nil || len(markets) != tc.count {
			t.Fatalf("filter %q: wrong market history: %s (%v)", tc.query, w.Body.String(), err)
		}
		for _, market := range markets {
			if market.Status == MarketDraft {
				t.Fatal("public history exposed an unpublished draft")
			}
		}
	}
	adminMarkets, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(adminMarkets) != 4 {
		t.Fatal("admin history lost access to drafts", len(adminMarkets), err)
	}
}
