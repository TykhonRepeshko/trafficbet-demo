package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStakeDetailQueryRejectsMalformedAndUnboundedFilters(t *testing.T) {
	for _, query := range []string{"", "streamId=0", "streamId=1%20OR%201=1", "streamId=1&streamId=2", "streamId=1&marketId=-1", "streamId=1&marketId=1&marketId=2", "streamId=1&status=unknown", "streamId=1&status=pending&status=all", "streamId=1&pageSize=201", "streamId=1&page=0", "streamId=1&page=1000001", "streamId=1&q=member", "streamId=1&status="} {
		w := httptest.NewRecorder()
		(&API{store: &Store{}}).handleStakeDetails(w, httptest.NewRequest("GET", "/api/admin/stake-volume/bets?"+query, nil))
		if w.Code != 400 {
			t.Fatal("invalid filter reached database", query, w.Code)
		}
	}
}

func TestPostgresStakeDetailsScopePagesIdentityAndLifecycle(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "details-admin@example.org", RoleAdmin, 0)
	first := integrationUser(t, s, ctx, "details-first@example.org", RoleUser, 10000)
	second := integrationUser(t, s, ctx, "details-second@example.org", RoleUser, 10000)
	a, b := integrationStream(t, s, ctx), integrationStream(t, s, ctx)
	one, two, foreign := integrationMarket(t, s, ctx, a.ID), integrationMarket(t, s, ctx, a.ID), integrationMarket(t, s, ctx, b.ID)
	place := func(user, market int64, side string, stake int64, key string) {
		t.Helper()
		if _, _, err := s.PlaceBet(ctx, user, market, side, stake, key); err != nil {
			t.Fatal(err)
		}
	}
	place(first.ID, one.ID, BetSideOver, 100, "detail-first-intent")
	place(second.ID, one.ID, BetSideUnder, 200, "detail-second-intent")
	place(first.ID, two.ID, BetSideUnder, 50, "detail-void-intent")
	place(second.ID, foreign.ID, BetSideOver, 400, "detail-foreign-intent")
	for i := 0; i < 60; i++ {
		place(first.ID, one.ID, BetSideOver, 1, fmt.Sprintf("detail-small-intent-%04d", i))
	}
	if _, err := s.VoidMarket(ctx, two.ID, "Synthetic details fixture refund"); err != nil {
		t.Fatal(err)
	}
	adminToken, _ := newSessionToken()
	memberToken, _ := newSessionToken()
	for _, item := range []struct {
		id    int64
		token string
	}{{admin.ID, adminToken}, {first.ID, memberToken}} {
		if err := s.CreateSession(ctx, item.id, sessionHash(item.token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	cookie := &http.Cookie{Name: sessionCookieName, Value: adminToken}
	get := func(query string, status int) StakeBetPage {
		t.Helper()
		w := accountTestRequest(handler, "GET", "/api/admin/stake-volume/bets?"+query, "", cookie)
		if w.Code != status {
			t.Fatal("unexpected details status", query, w.Code, w.Body.String())
		}
		var page StakeBetPage
		if status == 200 {
			if json.Unmarshal(w.Body.Bytes(), &page) != nil {
				t.Fatal("bad details response")
			}
			if w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "token") || strings.Contains(w.Body.String(), "balanceCredits") {
				t.Fatal("unsafe details response")
			}
		}
		return page
	}
	base := fmt.Sprintf("streamId=%d", a.ID)
	pending := get(base, 200)
	if pending.Total != 62 || pending.StakeCredits != 360 || len(pending.Items) != 25 || pending.Status != "pending" {
		t.Fatal("default unsettled details mismatch", pending)
	}
	seen := map[int64]bool{}
	for number := 1; number <= 7; number++ {
		page := get(base+fmt.Sprintf("&status=all&page=%d&pageSize=10", number), 200)
		if page.Total != 63 || page.TotalPages != 7 || page.StakeCredits != 410 {
			t.Fatal("page totals were truncated", page)
		}
		for _, item := range page.Items {
			if seen[item.ID] || item.StreamID != a.ID || item.MarketID == foreign.ID {
				t.Fatal("duplicate or foreign prediction", item)
			}
			seen[item.ID] = true
			if item.UserID == first.ID {
				if item.Email != first.Email || item.DisplayName != first.DisplayName {
					t.Fatal("first member identity mismatched")
				}
			} else if item.UserID == second.ID {
				if item.Email != second.Email || item.DisplayName != second.DisplayName {
					t.Fatal("second member identity mismatched")
				}
			} else {
				t.Fatal("unrelated member leaked")
			}
		}
	}
	if len(seen) != 63 {
		t.Fatal("older predictions omitted")
	}
	round := get(base+fmt.Sprintf("&marketId=%d&status=pending", one.ID), 200)
	if round.Total != 62 || round.StakeCredits != 360 || round.MarketID == nil || *round.MarketID != one.ID {
		t.Fatal("round scope mismatch", round)
	}
	refunded := get(base+"&status=void", 200)
	if refunded.Total != 1 || refunded.StakeCredits != 50 || refunded.Items[0].MarketID != two.ID {
		t.Fatal("status filter mismatch", refunded)
	}
	get(base+fmt.Sprintf("&marketId=%d", foreign.ID), 404)
	get("streamId=99999999", 404)
	for _, item := range []struct {
		cookie *http.Cookie
		status int
	}{{nil, 401}, {&http.Cookie{Name: sessionCookieName, Value: memberToken}, 403}} {
		if w := accountTestRequest(handler, "GET", "/api/admin/stake-volume/bets?"+base, "", item.cookie); w.Code != item.status {
			t.Fatal("details access not restricted", w.Code)
		}
	}
	if _, err := s.VoidMarket(ctx, one.ID, "Synthetic live filter update"); err != nil {
		t.Fatal(err)
	}
	empty := get(base+"&status=pending&page=7&pageSize=10", 200)
	if empty.Total != 0 || empty.StakeCredits != 0 || empty.Page != 1 || len(empty.Items) != 0 {
		t.Fatal("live lifecycle refresh did not clamp empty pages", empty)
	}
}

func TestPostgresRetiredSourceHiddenButHistoryPreserved(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "retired-member@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	if _, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, "retired-history-intent"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE streams SET is_active=false,retired_at=now() WHERE id=$1`, stream.ID); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListStreams(ctx, false)
	if err != nil || len(list) != 0 {
		t.Fatal("retired source still in working catalog", list, err)
	}
	if _, err := s.RestoreStream(ctx, stream.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("removed source is restorable", err)
	}
	if _, err := s.UpdateStream(ctx, stream); !errors.Is(err, ErrNotFound) {
		t.Fatal("removed source can be edited", err)
	}
	if err := s.DeleteStream(ctx, stream.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("removed source can be archived again", err)
	}
	if _, err := s.StakeBetDetails(ctx, stakeDetailOptions{StreamID: stream.ID, Status: "all", Page: 1, PageSize: 25}); !errors.Is(err, ErrNotFound) {
		t.Fatal("removed source appears in current details", err)
	}
	snapshot, err := s.StakeVolume(ctx)
	if err != nil || len(snapshot.Cameras) != 0 || snapshot.Totals.PendingStakeCredits != 100 || snapshot.HistoricalTotals.PendingStakeCredits != 100 {
		t.Fatal("removed history vanished from financial totals", snapshot, err)
	}
	bets, err := s.ListBetsForUser(ctx, user.ID)
	if err != nil || len(bets) != 1 || bets[0].StreamTitle != stream.Title {
		t.Fatal("user history lost camera identity", bets, err)
	}
	current, err := s.GetUserByID(ctx, user.ID)
	if err != nil || current.BalanceCredits != 900 {
		t.Fatal("removal changed balance", current, err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE streams SET is_active=true WHERE id=$1`, stream.ID); err == nil {
		t.Fatal("retired source can become active")
	}
	future := integrationStream(t, s, ctx)
	if err := s.DeleteStream(ctx, future.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RestoreStream(ctx, future.ID); err != nil {
		t.Fatal("future source restoration broken", err)
	}
}
