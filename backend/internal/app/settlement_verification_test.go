package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// This fixture represents an operator reviewing synthetic integration evidence.
// It must never be used to infer evidence quality for a real camera.
func verifiedSettlementFixture() SettlementVerification {
	return SettlementVerification{
		CaptureTimeVerified: true,
		CoverageVerified:    true,
		FramingVerified:     true,
		EvidenceNote:        "Synthetic test evidence covers UTC capture times, the full interval and the unchanged counting zone.",
	}
}

func TestSettlementVerificationRejectsIncompleteEvidenceBeforeDatabaseAccess(t *testing.T) {
	cases := []struct {
		name   string
		change func(*SettlementVerification)
	}{
		{"capture time unverified", func(v *SettlementVerification) { v.CaptureTimeVerified = false }},
		{"coverage incomplete", func(v *SettlementVerification) { v.CoverageVerified = false }},
		{"counting zone changed", func(v *SettlementVerification) { v.FramingVerified = false }},
		{"empty note", func(v *SettlementVerification) { v.EvidenceNote = "" }},
		{"spaces only", func(v *SettlementVerification) { v.EvidenceNote = strings.Repeat(" ", 40) }},
		{"short note", func(v *SettlementVerification) { v.EvidenceNote = strings.Repeat("a", 19) }},
		{"long note", func(v *SettlementVerification) { v.EvidenceNote = strings.Repeat("a", 2001) }},
		{"invalid UTF-8", func(v *SettlementVerification) { v.EvidenceNote += string([]byte{0xff}) }},
		{"embedded newline", func(v *SettlementVerification) { v.EvidenceNote += "\nMore text" }},
		{"leading newline", func(v *SettlementVerification) { v.EvidenceNote = "\n" + v.EvidenceNote }},
		{"trailing tab", func(v *SettlementVerification) { v.EvidenceNote += "\t" }},
		{"Unicode control", func(v *SettlementVerification) { v.EvidenceNote += "\u0085" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verification := verifiedSettlementFixture()
			tc.change(&verification)
			// A nil pool proves the required verification is checked before any
			// transaction, independent of callers' HTTP/UI validation.
			if _, err := (&Store{}).SettleMarket(context.Background(), 1, 12, verification); !errors.Is(err, ErrInvalid) {
				t.Fatal("incomplete evidence reached database access", err)
			}
		})
	}
	for _, length := range []int{20, 2000} {
		verification := verifiedSettlementFixture()
		verification.EvidenceNote = "  " + strings.Repeat("界", length) + "  "
		normalized, err := normalizeSettlementVerification(verification)
		if err != nil || normalized.EvidenceNote != strings.Repeat("界", length) {
			t.Fatal("valid Unicode boundary note rejected or not trimmed", length, err)
		}
	}
}

func TestSettlementHTTPRejectsMissingFalseAndUnknownVerification(t *testing.T) {
	verification, err := json.Marshal(verifiedSettlementFixture())
	if err != nil {
		t.Fatal(err)
	}
	valid := fmt.Sprintf(`{"actualCount":12,"verification":%s}`, verification)
	cases := []string{
		`{"actualCount":12}`,
		`{"actualCount":12,"verification":null}`,
		`{"actualCount":12,"verification":{}}`,
		strings.Replace(valid, `"captureTimeVerified":true`, `"captureTimeVerified":false`, 1),
		strings.Replace(valid, `"coverageVerified":true,`, ``, 1),
		strings.Replace(valid, `"framingVerified":true`, `"framingVerified":null`, 1),
		strings.Replace(valid, `"framingVerified":true`, `"framingVerified":"true"`, 1),
		strings.Replace(valid, `"verification":{`, `"verification":{"unknown":true,`, 1),
		strings.Replace(valid, `"verification":{`, `"verification":{"framingVerified":true,`, 1),
		strings.Replace(valid, `"verification":{`, `"verification":{"FramingVerified":true,`, 1),
	}
	api := &API{store: &Store{}}
	for i, body := range cases {
		t.Run(fmt.Sprintf("case-%d", i), func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPatch, "/api/admin/markets/1/settle", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			api.handleAdminMarketByID(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatal("invalid settlement verification accepted", w.Code, w.Body.String())
			}
		})
	}
}

func TestPostgresSettlementVerificationAuditAndRollback(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "evidence-admin@example.org", RoleAdmin, 0)
	user := integrationUser(t, s, ctx, "evidence-player@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	bet, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, "evidence-settlement-intent")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	token, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, admin.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	cfg := Config{FrontendOrigin: "http://localhost:4200", WorkerToken: strings.Repeat("w", 64)}
	handler := NewAPI(s, cfg).Routes()
	requestAs := func(body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/admin/markets/%d/settle", market.ID), strings.NewReader(body))
		r.Header.Set("Origin", cfg.FrontendOrigin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	adminCookie := &http.Cookie{Name: sessionCookieName, Value: token}
	request := func(body string) *httptest.ResponseRecorder { return requestAs(body, adminCookie) }
	assertUnchanged := func() {
		t.Helper()
		var marketStatus, betStatus string
		var balance int64
		var payouts, audits, metrics int
		err := s.pool.QueryRow(ctx, `SELECT m.status,b.status,u.balance_credits,
			(SELECT count(*) FROM credit_ledger WHERE market_id=m.id AND reason='payout'),
			(SELECT count(*) FROM audit_events WHERE resource_id=m.id AND action='market.settled'),
			(SELECT count(*) FROM stream_metrics WHERE stream_id=m.stream_id)
			FROM bet_markets m JOIN bets b ON b.market_id=m.id JOIN users u ON u.id=b.user_id
			WHERE m.id=$1 AND b.id=$2`, market.ID, bet.ID).Scan(&marketStatus, &betStatus, &balance, &payouts, &audits, &metrics)
		if err != nil || marketStatus != MarketOpen || betStatus != BetPending || balance != 900 || payouts != 0 || audits != 0 || metrics != 0 {
			t.Fatal("failed verification changed settlement state", marketStatus, betStatus, balance, payouts, audits, metrics, err)
		}
	}
	if response := requestAs(`{"actualCount":12}`, nil); response.Code != http.StatusUnauthorized {
		t.Fatal("anonymous settlement accepted", response.Code, response.Body.String())
	}
	userToken, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, user.ID, sessionHash(userToken), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	if response := requestAs(`{"actualCount":12}`, &http.Cookie{Name: sessionCookieName, Value: userToken}); response.Code != http.StatusForbidden {
		t.Fatal("ordinary account settlement accepted", response.Code, response.Body.String())
	}
	invalidBodies := []string{
		`{"actualCount":12}`,
		`{"actualCount":12,"verification":{"captureTimeVerified":true,"coverageVerified":true,"framingVerified":false,"evidenceNote":"Source changed its counting viewpoint during the interval."}}`,
		`{"actualCount":12,"verification":{"captureTimeVerified":false,"coverageVerified":true,"framingVerified":true,"evidenceNote":"Capture timestamps were unavailable for this interval."}}`,
		`{"actualCount":12,"verification":{"captureTimeVerified":true,"coverageVerified":false,"framingVerified":true,"evidenceNote":"One section of the captured interval is missing."}}`,
		`{"actualCount":12,"verification":{"captureTimeVerified":true,"coverageVerified":true,"framingVerified":true,"evidenceNote":"Synthetic evidence has full interval coverage.","unknown":true}}`,
	}
	for _, body := range invalidBodies {
		if response := request(body); response.Code != http.StatusBadRequest {
			t.Fatal("authenticated settlement bypassed verification", response.Code, response.Body.String())
		}
		assertUnchanged()
	}
	verification := verifiedSettlementFixture()
	verification.FramingVerified = false
	if _, err := s.SettleMarket(ctx, market.ID, 12, verification); !errors.Is(err, ErrInvalid) {
		t.Fatal("direct settlement accepted an unverified counting zone", err)
	}
	assertUnchanged()
	// Force audit persistence to fail after payouts/metrics have been written.
	// The same transaction must roll back every change.
	if _, err := s.pool.Exec(ctx, `CREATE FUNCTION fail_settlement_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
		BEGIN IF NEW.action='market.settled' THEN RAISE EXCEPTION 'test audit rejection'; END IF; RETURN NEW; END;
		$$; CREATE TRIGGER fail_settlement_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_settlement_audit()`); err != nil {
		t.Fatal(err)
	}
	verification = verifiedSettlementFixture()
	verification.EvidenceNote = "  " + verification.EvidenceNote + "  "
	body, err := json.Marshal(struct {
		ActualCount  int                    `json:"actualCount"`
		Verification SettlementVerification `json:"verification"`
	}{12, verification})
	if err != nil {
		t.Fatal(err)
	}
	if response := request(string(body)); response.Code != http.StatusInternalServerError {
		t.Fatal("failed audit was reported as successful settlement", response.Code, response.Body.String())
	}
	assertUnchanged()
	if _, err := s.pool.Exec(ctx, `DROP TRIGGER fail_settlement_audit ON audit_events`); err != nil {
		t.Fatal(err)
	}
	if response := request(string(body)); response.Code != http.StatusOK {
		t.Fatal("verified settlement failed", response.Code, response.Body.String())
	}
	var details []byte
	var actor int64
	if err := s.pool.QueryRow(ctx, `SELECT actor_user_id,details FROM audit_events WHERE resource_id=$1 AND action='market.settled'`, market.ID).Scan(&actor, &details); err != nil {
		t.Fatal(err)
	}
	var audit struct {
		ActualCount        int                    `json:"actualCount"`
		VerificationPolicy string                 `json:"verificationPolicy"`
		Verification       SettlementVerification `json:"verification"`
	}
	if err := json.Unmarshal(details, &audit); err != nil || actor != admin.ID || audit.ActualCount != 12 || audit.VerificationPolicy != settlementVerificationPolicy || audit.Verification != verifiedSettlementFixture() {
		t.Fatal("settlement evidence audit missing or changed", actor, string(details), err)
	}
	updated, err := s.GetUserByID(ctx, user.ID)
	if err != nil || updated.BalanceCredits != 1090 {
		t.Fatal("verified settlement payout incorrect", updated.BalanceCredits, err)
	}
}
