package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestCustomRangePricingAndInclusiveBounds(t *testing.T) {
	market := Market{ID: 7, Threshold: 10}
	for _, bounds := range [][2]int{{0, 0}, {12, 25}, {0, maxVehicleCount}, {maxVehicleCount, maxVehicleCount}} {
		quote, err := quoteCountRange(market, bounds[0], bounds[1])
		if err != nil || !validOdds(quote.Odds) || quote.PricingModel != rangePricingModel {
			t.Fatalf("invalid quote: %+v %v", quote, err)
		}
	}
	quote, _ := quoteCountRange(market, 12, 25)
	scale := math.Sqrt(10.5) * math.Sqrt2
	mass := func(lo, hi float64) float64 { return .5 * (math.Erfc((lo-10.5)/scale) - math.Erfc((hi-10.5)/scale)) }
	expected := math.Max(1, math.Min(10, math.Floor(85/(mass(11.5, 25.5)/mass(-.5, float64(maxVehicleCount)+.5)))/100))
	if quote.Odds != expected {
		t.Fatalf("incorrect demo price: %v, want %v", quote.Odds, expected)
	}
	narrow, _ := quoteCountRange(market, 15, 15)
	if narrow.Odds < quote.Odds {
		t.Fatal("narrower range has a lower return")
	}
	broad, _ := quoteCountRange(market, 0, maxVehicleCount)
	if broad.Odds != 1 {
		t.Fatal("a nearly certain model range must not generate free model profit", broad)
	}
	for _, bounds := range [][2]int{{-1, 5}, {25, 12}, {0, maxVehicleCount + 1}} {
		if _, err := quoteCountRange(market, bounds[0], bounds[1]); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid range accepted", bounds, err)
		}
	}
	for count, want := range map[int]bool{11: false, 12: true, 20: true, 25: true, 26: false} {
		if rangeWins(count, 12, 25) != want {
			t.Fatal("inclusive boundary error", count)
		}
	}
}

func TestPostgresRangePredictionRetriesHistoryAndRefund(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "range@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	quote, err := s.QuoteRange(ctx, market.ID, 12, 25)
	if err != nil {
		t.Fatal(err)
	}
	const key = "range-concurrent-intent"
	var wg sync.WaitGroup
	ids := make(chan int64, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bet, _, err := s.placePrediction(ctx, user.ID, market.ID, BetSideRange, 100, key, &quote)
			ids <- bet.ID
			errs <- err
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var betID int64
	for id := range ids {
		if betID == 0 {
			betID = id
		}
		if id != betID {
			t.Fatal("duplicate prediction created")
		}
	}
	got, _, err := s.GetUserByEmail(ctx, user.Email)
	if err != nil || got.BalanceCredits != 900 {
		t.Fatal("range debited more than once", got, err)
	}
	history, err := s.ListBetsForUser(ctx, user.ID)
	if err != nil || len(history) != 1 || history[0].RangeMin == nil || *history[0].RangeMin != 12 || history[0].RangeMax == nil || *history[0].RangeMax != 25 || history[0].RangeOdds == nil || *history[0].RangeOdds != quote.Odds {
		t.Fatal("range missing from saved history", history, err)
	}
	changed := quote
	changed.RangeMax = 26
	if _, _, err := s.placePrediction(ctx, user.ID, market.ID, BetSideRange, 100, key, &changed); !errors.Is(err, ErrConflict) {
		t.Fatal("same key accepted different bounds", err)
	}
	forged := quote
	if forged.Odds == 100 {
		forged.Odds = 99
	} else {
		forged.Odds = 100
	}
	if _, _, err := s.placePrediction(ctx, user.ID, market.ID, BetSideRange, 100, "range-forged-odds-intent", &forged); !errors.Is(err, ErrConflict) {
		t.Fatal("client changed server odds", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bets SET range_min=11 WHERE id=$1`, betID); err == nil {
		t.Fatal("accepted bounds were mutable")
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO bets(user_id,market_id,side,stake_credits,potential_payout_credits,status,idempotency_key,range_min,range_max,range_odds,pricing_model) VALUES($1,$2,'range',1,1,'pending','range-bad-db-constraint',25,12,1,'demo_geometric_v1')`, user.ID, market.ID); err == nil {
		t.Fatal("database accepted reversed bounds")
	}
	volume, err := s.StakeVolume(ctx)
	if err != nil || volume.Totals.PendingRangeCredits != 100 || volume.Totals.PendingRangeBetCount != 1 || volume.Totals.PendingUnderCredits != 0 || volume.Totals.PendingOverCredits != 0 {
		t.Fatal("range volume counted as another outcome", volume, err)
	}
	page, err := s.StakeBetDetails(ctx, stakeDetailOptions{StreamID: stream.ID, Status: BetPending, Page: 1, PageSize: 25})
	if err != nil || len(page.Items) != 1 || page.Items[0].RangeMin == nil || *page.Items[0].RangeMin != 12 {
		t.Fatal("admin inspector lost range", page, err)
	}
	if _, err := s.VoidMarket(ctx, market.ID, "Synthetic range refund verification"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VoidMarket(ctx, market.ID, "Synthetic range refund verification"); err != nil {
		t.Fatal(err)
	}
	got, _, err = s.GetUserByEmail(ctx, user.Email)
	if err != nil || got.BalanceCredits != 1000 {
		t.Fatal("range refund not exact-once", got, err)
	}
	retry, after, err := s.placePrediction(ctx, user.ID, market.ID, BetSideRange, 100, key, &quote)
	if err != nil || retry.ID != betID || retry.Status != BetVoid || after.BalanceCredits != 1000 {
		t.Fatal("old retry was charged after cancellation", retry, after, err)
	}
}

func TestPostgresRangeSettlementAtBothBounds(t *testing.T) {
	for _, count := range []int{11, 12, 25, 26} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			s, ctx := integrationStore(t, true)
			user := integrationUser(t, s, ctx, "range-settlement@example.org", RoleUser, 1000)
			stream := integrationStream(t, s, ctx)
			market := integrationMarket(t, s, ctx, stream.ID)
			quote, err := s.QuoteRange(ctx, market.ID, 12, 25)
			if err != nil {
				t.Fatal(err)
			}
			bet, _, err := s.placePrediction(ctx, user.ID, market.ID, BetSideRange, 100, "range-settlement-intent", &quote)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, market.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SettleMarket(ctx, market.ID, count, verifiedSettlementFixture()); err != nil {
				t.Fatal(err)
			}
			want := int64(900)
			status := BetLost
			if count >= 12 && count <= 25 {
				want += bet.PotentialPayoutCredits
				status = BetWon
			}
			got, _, err := s.GetUserByEmail(ctx, user.Email)
			if err != nil || got.BalanceCredits != want {
				t.Fatalf("count %d balance %d want %d: %v", count, got.BalanceCredits, want, err)
			}
			history, err := s.ListBetsForUser(ctx, user.ID)
			if err != nil || history[0].Status != status {
				t.Fatal("incorrect range settlement", history, err)
			}
			if _, err := s.SettleMarket(ctx, market.ID, count, verifiedSettlementFixture()); !errors.Is(err, ErrConflict) {
				t.Fatal("settled twice", err)
			}
		})
	}
}

func TestPostgresRangeHTTPValidationAndSessionPersistence(t *testing.T) {
	s, ctx := integrationStore(t, true)
	member := integrationUser(t, s, ctx, "range-http@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	request := func(method, path, body string, cookie *http.Cookie, key string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
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
		if w.Code != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, w.Code, want, w.Body.String())
		}
		return w
	}
	login := func() *http.Cookie {
		w := request("POST", "/api/auth/login", `{"email":"range-http@example.org","password":"integration-random-password"}`, nil, "", 200)
		return w.Result().Cookies()[0]
	}
	path := fmt.Sprintf("/api/bets/range-quote?marketId=%d&from=12&to=25", market.ID)
	request("GET", path, "", nil, "", 401)
	cookie := login()
	var quote RangeQuote
	if err := json.Unmarshal(request("GET", path, "", cookie, "", 200).Body.Bytes(), &quote); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"from=-1&to=25", "from=26&to=12", "from=12&from=13&to=25", "from=12.5&to=25", "from=0&to=100000001", "from=0%3BDROP%20TABLE%20users&to=25"} {
		request("GET", fmt.Sprintf("/api/bets/range-quote?marketId=%d&%s", market.ID, query), "", cookie, "", 400)
	}
	payload := fmt.Sprintf(`{"marketId":%d,"side":"range","stakeCredits":100,"rangeMin":12,"rangeMax":25,"quotedOdds":%g,"pricingModel":"%s"}`, market.ID, quote.Odds, quote.PricingModel)
	request("POST", "/api/bets", payload, cookie, "range-http-stake-intent", 201)
	request("POST", "/api/bets", payload, cookie, "range-http-stake-intent", 201)
	request("POST", "/api/bets", strings.Replace(payload, `"rangeMin":12`, `"rangeMin":-1`, 1), cookie, "range-http-invalid-intent", 400)
	request("POST", "/api/bets", strings.Replace(payload, `"rangeMin":12`, `"rangeMin":"12; DROP TABLE users"`, 1), cookie, "range-http-injection-intent", 400)
	request("POST", "/api/bets", strings.Replace(payload, `"side":"range"`, `"side":"under"`, 1), cookie, "range-http-mixed-intent", 400)
	request("POST", "/api/auth/logout", `{}`, cookie, "", 200)
	cookie = login()
	var restored User
	if err := json.Unmarshal(request("GET", "/api/me", "", cookie, "", 200).Body.Bytes(), &restored); err != nil || restored.ID != member.ID || restored.BalanceCredits != 900 {
		t.Fatal("range debit did not survive sign-in", restored, err)
	}
	request("GET", "/api/admin/stake-volume", "", cookie, "", 403)
	// Quotes and submissions both close on server time; old accepted retries still work.
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	request("GET", path, "", cookie, "", 409)
	request("POST", "/api/bets", payload, cookie, "range-http-late-intent", 409)
	request("POST", "/api/bets", payload, cookie, "range-http-stake-intent", 201)
}

func TestPostgresLegacyRangePayoutSurvivesNewPricing(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "legacy-range@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	var id int64
	err := s.pool.QueryRow(ctx, `INSERT INTO bets(user_id,market_id,side,stake_credits,potential_payout_credits,status,idempotency_key,range_min,range_max,range_odds,pricing_model) VALUES($1,$2,'range',100,2000,'pending','legacy-range-intent',12,25,20,'demo_geometric_v1') RETURNING id`, user.ID, market.ID).Scan(&id)
	if err != nil {
		t.Fatal("historical v1 terms rejected", err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE users SET balance_credits=900 WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO credit_ledger(user_id,bet_id,market_id,reason,delta_credits,balance_after) VALUES($1,$2,$3,'stake',-100,900)`, user.ID, id, market.ID); err != nil {
		t.Fatal(err)
	}
	endAutomationWindow(t, s, ctx, market.ID, 0)
	if _, err = s.SettleMarket(ctx, market.ID, 12, verifiedSettlementFixture()); err != nil {
		t.Fatal(err)
	}
	history, err := s.ListBetsForUser(ctx, user.ID)
	if err != nil || len(history) != 1 || history[0].Status != BetWon || history[0].PotentialPayoutCredits != 2000 || *history[0].PricingModel != "demo_geometric_v1" {
		t.Fatal("stored legacy payout changed", history, err)
	}
	got, _, err := s.GetUserByEmail(ctx, user.Email)
	if err != nil || got.BalanceCredits != 2900 {
		t.Fatal("legacy payout repriced", got.BalanceCredits, err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE bets SET pricing_model='demo_normal_v2',range_odds=2,potential_payout_credits=200 WHERE id=$1`, id); err == nil {
		t.Fatal("accepted terms were mutable")
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO bets(user_id,market_id,side,stake_credits,potential_payout_credits,status,idempotency_key,range_min,range_max,range_odds,pricing_model) VALUES($1,$2,'range',1,11,'pending','invalid-v2-cap',12,25,10.01,'demo_normal_v2')`, user.ID, market.ID); err == nil {
		t.Fatal("database accepted v2 above 10x")
	}
}
