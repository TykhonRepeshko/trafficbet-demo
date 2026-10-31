package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Exercise the member's complete credit journey through the public HTTP
// handlers. All records and synthetic counting evidence belong to the isolated
// schema created by integrationStore; no live camera evidence is asserted.
func TestPostgresHTTPFullCreditLifecycle(t *testing.T) {
	s, ctx := integrationStore(t, true)
	integrationUser(t, s, ctx, "lifecycle-admin@example.org", RoleAdmin, 0)
	stream := integrationStream(t, s, ctx)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200", CookieSecure: true}).Routes()

	request := func(method, path string, payload any, cookie *http.Cookie, key string, wantStatus int) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		if payload != nil {
			var err error
			body, err = json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Origin", "http://localhost:4200")
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != wantStatus {
			t.Fatalf("%s %s: status %d, want %d: %s", method, path, w.Code, wantStatus, w.Body.String())
		}
		return w
	}
	decode := func(w *httptest.ResponseRecorder, target any) {
		t.Helper()
		if err := json.Unmarshal(w.Body.Bytes(), target); err != nil {
			t.Fatalf("decode response: %v", err)
		}
	}
	sessionCookie := func(w *httptest.ResponseRecorder) *http.Cookie {
		t.Helper()
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != sessionCookieName || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/api" {
			t.Fatal("authentication did not issue the protected session cookie")
		}
		return cookies[0]
	}
	adminLogin := request(http.MethodPost, "/api/auth/login", map[string]string{
		"email": "lifecycle-admin@example.org", "password": "integration-random-password",
	}, nil, "", http.StatusOK)
	adminCookie := sessionCookie(adminLogin)

	const email = "credit-lifecycle@example.org"
	const password = "lifecycle-test-password"
	registration := request(http.MethodPost, "/api/auth/register", map[string]string{
		"email": email, "displayName": "Credit lifecycle test", "password": password,
	}, nil, "", http.StatusCreated)
	var registered struct {
		User User `json:"user"`
	}
	decode(registration, &registered)
	if registered.User.Role != RoleUser || registered.User.BalanceCredits != 10000 {
		t.Fatalf("unexpected registered profile: %+v", registered.User)
	}
	memberCookie := sessionCookie(registration)
	assertBalance := func(cookie *http.Cookie, stage string, want int64) {
		t.Helper()
		var user User
		decode(request(http.MethodGet, "/api/me", nil, cookie, "", http.StatusOK), &user)
		if user.ID != registered.User.ID || user.BalanceCredits != want {
			t.Fatalf("%s: balance %d, want %d; user %d", stage, user.BalanceCredits, want, user.ID)
		}
		t.Logf("%s: %d virtual credits", stage, user.BalanceCredits)
	}
	type expectedEntry struct {
		reason string
		delta  int64
		after  int64
		betID  int64
		market int64
	}
	expected := []expectedEntry{{reason: "opening", delta: 10000, after: 10000}}
	assertLedger := func(cookie *http.Cookie) {
		t.Helper()
		var entries []CreditLedgerEntry
		decode(request(http.MethodGet, "/api/me/ledger?limit=200", nil, cookie, "", http.StatusOK), &entries)
		if len(entries) != len(expected) {
			t.Fatalf("ledger length %d, want %d: %+v", len(entries), len(expected), entries)
		}
		var total int64
		for i, want := range expected {
			got := entries[len(entries)-1-i] // API returns newest entries first.
			if got.Reason != want.reason || got.DeltaCredits != want.delta || got.BalanceAfter != want.after {
				t.Fatalf("ledger operation %d: %+v, want %+v", i, got, want)
			}
			if want.betID == 0 {
				if got.BetID != nil || got.MarketID != nil {
					t.Fatal("opening entry unexpectedly belongs to a prediction")
				}
			} else if got.BetID == nil || *got.BetID != want.betID || got.MarketID == nil || *got.MarketID != want.market {
				t.Fatalf("ledger operation %d points to a different prediction or round", i)
			}
			total += got.DeltaCredits
			if total != got.BalanceAfter {
				t.Fatalf("ledger operation %d does not reconcile: sum %d, balance %d", i, total, got.BalanceAfter)
			}
		}
	}
	assertBalance(memberCookie, "Registration", 10000)
	assertLedger(memberCookie)

	createRound := func(title string) Market {
		t.Helper()
		now := time.Now().UTC()
		var market Market
		decode(request(http.MethodPost, "/api/admin/markets", map[string]any{
			"streamId": stream.ID, "title": title, "threshold": 10,
			"bettingClosesAt": now.Add(5 * time.Minute).Format(time.RFC3339),
			"windowStart":     now.Add(6 * time.Minute).Format(time.RFC3339),
			"windowEnd":       now.Add(7 * time.Minute).Format(time.RFC3339),
			"oddsOver":        1.90, "oddsUnder": 1.90, "status": MarketOpen,
		}, adminCookie, "", http.StatusCreated), &market)
		if market.StreamID != stream.ID || market.Status != MarketOpen {
			t.Fatal("administrator did not create an open synthetic round", market)
		}
		return market
	}
	winningRound := createRound("Synthetic credit lifecycle: winning round")
	refundRound := createRound("Synthetic credit lifecycle: cancellation round")
	type placedPrediction struct {
		Bet  Bet  `json:"bet"`
		User User `json:"user"`
	}
	winningPayload := map[string]any{"marketId": winningRound.ID, "side": BetSideOver, "stakeCredits": 100}
	var winning placedPrediction
	decode(request(http.MethodPost, "/api/bets", winningPayload, memberCookie, "lifecycle-winning-intent", http.StatusCreated), &winning)
	if winning.Bet.Status != BetPending || winning.Bet.PotentialPayoutCredits != 190 || winning.User.BalanceCredits != 9900 {
		t.Fatal("stake or potential payout incorrect", winning)
	}
	expected = append(expected, expectedEntry{"stake", -100, 9900, winning.Bet.ID, winningRound.ID})
	assertBalance(memberCookie, "After 100-credit stake", 9900)
	var retry placedPrediction
	decode(request(http.MethodPost, "/api/bets", winningPayload, memberCookie, "lifecycle-winning-intent", http.StatusCreated), &retry)
	if retry.Bet.ID != winning.Bet.ID || retry.User.BalanceCredits != 9900 {
		t.Fatal("idempotent placement changed the prediction or balance", retry)
	}
	assertLedger(memberCookie)

	settlePath := fmt.Sprintf("/api/admin/markets/%d/settle", winningRound.ID)
	settlePayload := map[string]any{"actualCount": 11, "verification": verifiedSettlementFixture()}
	request(http.MethodPatch, settlePath, settlePayload, memberCookie, "", http.StatusForbidden)
	request(http.MethodGet, "/api/admin/users", nil, memberCookie, "", http.StatusForbidden)
	request(http.MethodPatch, settlePath, settlePayload, adminCookie, "", http.StatusConflict)
	assertLedger(memberCookie)

	// Advance only this synthetic fixture after proving early settlement is
	// rejected; no production clock, source evidence or real round is changed.
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, winningRound.ID); err != nil {
		t.Fatal(err)
	}
	var settled Market
	decode(request(http.MethodPatch, settlePath, settlePayload, adminCookie, "", http.StatusOK), &settled)
	if settled.Status != MarketSettled || settled.ActualCount == nil || *settled.ActualCount != 11 {
		t.Fatal("synthetic winning round not settled", settled)
	}
	expected = append(expected, expectedEntry{"payout", 190, 10090, winning.Bet.ID, winningRound.ID})
	assertBalance(memberCookie, "After winning payout (190 including stake)", 10090)
	request(http.MethodPatch, settlePath, settlePayload, adminCookie, "", http.StatusConflict)
	assertLedger(memberCookie)

	var cancelled placedPrediction
	decode(request(http.MethodPost, "/api/bets", map[string]any{
		"marketId": refundRound.ID, "side": BetSideUnder, "stakeCredits": 250,
	}, memberCookie, "lifecycle-refund-intent", http.StatusCreated), &cancelled)
	if cancelled.Bet.Status != BetPending || cancelled.User.BalanceCredits != 9840 {
		t.Fatal("cancellation stake was not debited", cancelled)
	}
	expected = append(expected, expectedEntry{"stake", -250, 9840, cancelled.Bet.ID, refundRound.ID})
	assertBalance(memberCookie, "After second 250-credit stake", 9840)
	voidPath := fmt.Sprintf("/api/admin/markets/%d/void", refundRound.ID)
	voidPayload := map[string]string{"reason": "Synthetic cancellation for full credit lifecycle verification"}
	request(http.MethodPatch, voidPath, voidPayload, memberCookie, "", http.StatusForbidden)
	var voided Market
	decode(request(http.MethodPatch, voidPath, voidPayload, adminCookie, "", http.StatusOK), &voided)
	if voided.Status != MarketVoid || voided.VoidReason != voidPayload["reason"] {
		t.Fatal("round cancellation not recorded", voided)
	}
	expected = append(expected, expectedEntry{"refund", 250, 10090, cancelled.Bet.ID, refundRound.ID})
	assertBalance(memberCookie, "After cancellation refund", 10090)
	request(http.MethodPatch, voidPath, voidPayload, adminCookie, "", http.StatusOK)
	assertLedger(memberCookie)

	assertPredictions := func(cookie *http.Cookie) {
		t.Helper()
		var bets []Bet
		decode(request(http.MethodGet, "/api/bets/my", nil, cookie, "", http.StatusOK), &bets)
		if len(bets) != 2 {
			t.Fatal("prediction history contains an unexpected number of entries", bets)
		}
		for _, bet := range bets {
			want := BetWon
			if bet.ID == cancelled.Bet.ID {
				want = BetVoid
			} else if bet.ID != winning.Bet.ID {
				t.Fatal("unexpected prediction in member history", bet)
			}
			if bet.Status != want || bet.SettledAt == nil || bet.UserID != registered.User.ID {
				t.Fatal("prediction outcome or ownership incorrect", bet)
			}
		}
	}
	assertPredictions(memberCookie)
	directory := request(http.MethodGet, "/api/admin/users", nil, adminCookie, "", http.StatusOK)
	var users []User
	decode(directory, &users)
	found := false
	for _, user := range users {
		if user.ID == registered.User.ID {
			found = user.Email == email && user.BalanceCredits == 10090 && user.Role == RoleUser
		}
	}
	if !found || strings.Contains(directory.Body.String(), "password") || strings.Contains(directory.Body.String(), "hash") || strings.Contains(directory.Body.String(), "token") {
		t.Fatal("administrator account directory omitted the member or exposed authentication data")
	}

	request(http.MethodPost, "/api/auth/logout", nil, memberCookie, "", http.StatusOK)
	request(http.MethodGet, "/api/me", nil, memberCookie, "", http.StatusUnauthorized)
	request(http.MethodGet, "/api/me/ledger", nil, memberCookie, "", http.StatusUnauthorized)
	login := request(http.MethodPost, "/api/auth/login", map[string]string{"email": email, "password": password}, nil, "", http.StatusOK)
	newCookie := sessionCookie(login)
	if newCookie.Value == memberCookie.Value {
		t.Fatal("sign-in reused the revoked session")
	}
	assertBalance(newCookie, "After logout and fresh sign-in", 10090)
	assertLedger(newCookie)
	assertPredictions(newCookie)
	request(http.MethodGet, "/api/me", nil, memberCookie, "", http.StatusUnauthorized)
}
