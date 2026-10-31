package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPostgresVoidingRefundsOnceAndPreservesHistory(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "void-admin@example.org", RoleAdmin, 0)
	ctx = context.WithValue(ctx, userContextKey, admin)
	firstUser := integrationUser(t, s, ctx, "first-refund@example.org", RoleUser, 1000)
	secondUser := integrationUser(t, s, ctx, "second-refund@example.org", RoleUser, 500)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	for i, stake := range []int64{100, 200} {
		if _, _, err := s.PlaceBet(ctx, firstUser.ID, market.ID, BetSideOver, stake, fmt.Sprintf("refund-first-%04d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.PlaceBet(ctx, secondUser.ID, market.ID, BetSideUnder, 400, "refund-second-intent"); err != nil {
		t.Fatal(err)
	}
	const reason = "Camera feed went offline during observation"
	var wg sync.WaitGroup
	results := make(chan error, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cancelled, err := s.VoidMarket(ctx, market.ID, reason)
			if err == nil && (cancelled.Status != MarketVoid || cancelled.VoidReason != reason || !cancelled.BettingClosesAt.Equal(market.BettingClosesAt)) {
				err = errors.New("cancellation changed deadline or lost its reason")
			}
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, original := range []User{firstUser, secondUser} {
		user, err := s.GetUserByID(ctx, original.ID)
		if err != nil || user.BalanceCredits != original.BalanceCredits {
			t.Fatal("refund did not restore opening balance", user, err)
		}
		var sum int64
		if err := s.pool.QueryRow(ctx, `SELECT sum(delta_credits) FROM credit_ledger WHERE user_id=$1`, user.ID).Scan(&sum); err != nil || sum != user.BalanceCredits {
			t.Fatal("refund ledger failed to reconcile", sum, err)
		}
	}
	var refundCount, auditCount int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM credit_ledger WHERE market_id=$1 AND reason='refund'`, market.ID).Scan(&refundCount); err != nil || refundCount != 3 {
		t.Fatal("refund duplicated or missing", refundCount, err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='market.voided' AND actor_user_id=$2`, market.ID, admin.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatal("cancellation audit duplicated or lost its actor", auditCount, err)
	}
	bets, err := s.ListAllBets(ctx, &market.ID)
	if err != nil || len(bets) != 3 {
		t.Fatal("cancellation erased bets", err)
	}
	for _, bet := range bets {
		if bet.Status != BetVoid || bet.SettledAt == nil {
			t.Fatal("pending bet not cancelled", bet)
		}
	}
	if _, err := s.VoidMarket(ctx, market.ID, "A different cancellation reason"); !errors.Is(err, ErrConflict) {
		t.Fatal("reason history could be rewritten", err)
	}
	if _, err := s.SettleMarket(ctx, market.ID, 30, verifiedSettlementFixture()); !errors.Is(err, ErrConflict) {
		t.Fatal("void market was settled", err)
	}
	bet, user, err := s.PlaceBet(ctx, firstUser.ID, market.ID, BetSideOver, 100, "refund-first-0000")
	if err != nil || bet.Status != BetVoid || user.BalanceCredits != 1000 {
		t.Fatal("retry of original bet after void debited credits", err)
	}
	if _, _, err := s.PlaceBet(ctx, firstUser.ID, market.ID, BetSideOver, 100, "new-intent-after-void"); !errors.Is(err, ErrConflict) {
		t.Fatal("fresh bet accepted after cancellation", err)
	}
}

func TestPostgresSettlementAndCancellationRace(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "race-refund@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	if _, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, "settle-void-race-intent"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	go func() { _, err := s.VoidMarket(ctx, market.ID, "Camera evidence is unavailable"); results <- err }()
	go func() { _, err := s.SettleMarket(ctx, market.ID, 11, verifiedSettlementFixture()); results <- err }()
	successes := 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if successes != 1 {
		t.Fatal("both settlement and cancellation were applied")
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM bet_markets WHERE id=$1`, market.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	updated, err := s.GetUserByID(ctx, user.ID)
	expected := int64(1000)
	if status == MarketSettled {
		expected = 1090
	}
	if err != nil || updated.BalanceCredits != expected {
		t.Fatal("race produced mixed credit outcomes", status, updated, err)
	}
	var creditEvents int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM credit_ledger WHERE market_id=$1 AND reason IN ('refund','payout')`, market.ID).Scan(&creditEvents); err != nil || creditEvents != 1 {
		t.Fatal("race duplicated payout/refund", creditEvents, err)
	}
}

func TestPostgresFairRoundValidationAndVoidAuthorization(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "fair-admin@example.org", RoleAdmin, 0)
	user := integrationUser(t, s, ctx, "fair-user@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	unsafe := market
	unsafe.BettingClosesAt = unsafe.WindowStart
	if _, err := s.CreateMarket(ctx, unsafe); !errors.Is(err, ErrInvalid) {
		t.Fatal("new round without safety gap accepted", err)
	}
	// Emulate an unchanged legacy row which predates the new insert guard.
	if _, err := s.pool.Exec(ctx, `ALTER TABLE bet_markets DISABLE TRIGGER market_observation_lead`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=window_start WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `ALTER TABLE bet_markets ENABLE TRIGGER market_observation_lead`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, "unsafe-legacy-round"); !errors.Is(err, ErrConflict) {
		t.Fatal("legacy unsafe round accepted a bet", err)
	}
	stream.StreamType = StreamTypeMP4
	if _, err := s.UpdateStream(ctx, stream); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMarket(ctx, market); !errors.Is(err, ErrConflict) {
		t.Fatal("recorded clip accepted for predictions", err)
	}
	cfg := Config{FrontendOrigin: "http://localhost:4200", WorkerToken: strings.Repeat("w", 64)}
	handler := NewAPI(s, cfg).Routes()
	cookie := func(userID int64) *http.Cookie {
		token, err := newSessionToken()
		if err != nil {
			t.Fatal(err)
		}
		if err := s.CreateSession(ctx, userID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
		return &http.Cookie{Name: sessionCookieName, Value: token}
	}
	adminCookie, userCookie := cookie(admin.ID), cookie(user.ID)
	request := func(cookie *http.Cookie, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("PATCH", fmt.Sprintf("/api/admin/markets/%d/void", market.ID), strings.NewReader(body))
		r.Header.Set("Origin", cfg.FrontendOrigin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	const body = `{"reason":"Source is not a continuous camera"}`
	if got := request(nil, body); got.Code != 401 {
		t.Fatal("anonymous cancellation accepted", got.Code)
	}
	if got := request(userCookie, body); got.Code != 403 {
		t.Fatal("ordinary account cancellation accepted", got.Code)
	}
	if got := request(adminCookie, `{"reason":""}`); got.Code != 400 {
		t.Fatal("empty cancellation reason accepted", got.Code)
	}
	got := request(adminCookie, body)
	var result Market
	if err := json.Unmarshal(got.Body.Bytes(), &result); err != nil || got.Code != 200 || result.Status != MarketVoid || result.VoidReason == "" {
		t.Fatal("legacy round could not be cancelled safely", got.Code, got.Body.String(), err)
	}
}
