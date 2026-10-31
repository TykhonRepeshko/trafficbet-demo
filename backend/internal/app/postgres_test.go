package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TEST_DATABASE_URL opts into integration tests. A uniquely named schema is
// created and removed; existing application schemas and data are untouched.
func integrationStore(t *testing.T, migrate bool) (*Store, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set; PostgreSQL integration test skipped")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	admin, err := OpenDB(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("tb_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	cfg.MaxConns = 20
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Errorf("test schema cleanup: %v", err)
		}
		admin.Close()
	})
	if migrate {
		if err := RunMigrations(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	return NewStore(pool), ctx
}
func integrationUser(t *testing.T, s *Store, ctx context.Context, email, role string, balance int64) User {
	t.Helper()
	hash, err := HashPassword("integration-random-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateUserIfMissing(ctx, email, hash, "Integration", role, balance); err != nil {
		t.Fatal(err)
	}
	user, _, err := s.GetUserByEmail(ctx, email)
	if err != nil {
		t.Fatal(err)
	}
	return user
}
func integrationStream(t *testing.T, s *Store, ctx context.Context) Stream {
	t.Helper()
	stream, err := s.CreateStream(ctx, Stream{Title: "Test", City: "Test", Country: "Test", LocationLabel: "Test", StreamType: StreamTypeHLS, StreamURL: "/media/test/index.m3u8", IsActive: true})
	if err != nil {
		t.Fatal(err)
	}
	return stream
}
func integrationMarket(t *testing.T, s *Store, ctx context.Context, streamID int64) Market {
	t.Helper()
	now := time.Now()
	market, err := s.CreateMarket(ctx, Market{StreamID: streamID, Title: "Test", Threshold: 10, BettingClosesAt: now.Add(time.Hour - minimumObservationLead), WindowStart: now.Add(time.Hour), WindowEnd: now.Add(2 * time.Hour), OddsOver: 1.9, OddsUnder: 1.9, Status: MarketOpen})
	if err != nil {
		t.Fatal(err)
	}
	return market
}

func TestPostgresConcurrentLedgerAndSettlement(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "player@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	const key = "one-intent-concurrent-requests"
	ids := make(chan int64, 20)
	errs := make(chan error, 20)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bet, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, key)
			if err != nil {
				errs <- err
			} else {
				ids <- bet.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	var firstID int64
	for id := range ids {
		if firstID == 0 {
			firstID = id
		}
		if id != firstID {
			t.Fatal("idempotent retry created another bet")
		}
	}
	updated, err := s.GetUserByID(ctx, user.ID)
	if err != nil || updated.BalanceCredits != 900 {
		t.Fatalf("repeat debit: %+v %v", updated, err)
	}
	if _, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 101, key); !errors.Is(err, ErrConflict) {
		t.Fatalf("reused key should conflict: %v", err)
	}
	outcomes := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 200, fmt.Sprintf("separate-intent-%04d", i))
			outcomes <- err
		}(i)
	}
	wg.Wait()
	close(outcomes)
	successes := 0
	for err := range outcomes {
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if successes != 4 {
		t.Fatalf("concurrent balance expected 4 bets, got %d", successes)
	}
	updated, err = s.GetUserByID(ctx, user.ID)
	if err != nil || updated.BalanceCredits != 100 {
		t.Fatalf("balance conservation failed: %+v %v", updated, err)
	}
	if _, err := s.SettleMarket(ctx, market.ID, 11, verifiedSettlementFixture()); !errors.Is(err, ErrConflict) {
		t.Fatal("premature settlement accepted", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	settlements := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.SettleMarket(ctx, market.ID, 11, verifiedSettlementFixture())
			settlements <- err
		}()
	}
	wg.Wait()
	close(settlements)
	settled := 0
	for err := range settlements {
		if err == nil {
			settled++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if settled != 1 {
		t.Fatal("settlement applied twice")
	}
	updated, err = s.GetUserByID(ctx, user.ID)
	if err != nil || updated.BalanceCredits != 1810 {
		t.Fatalf("payout wrong: %+v %v", updated, err)
	}
	retry, retryUser, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, key)
	if err != nil || retry.ID != firstID || retry.Status != BetWon || retryUser.BalanceCredits != 1810 {
		t.Fatalf("retry after settlement changed balance: %+v %+v %v", retry, retryUser, err)
	}
	var ledgerSum int64
	var ledgerCount int
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(sum(delta_credits),0),count(*) FROM credit_ledger WHERE user_id=$1`, user.ID).Scan(&ledgerSum, &ledgerCount); err != nil {
		t.Fatal(err)
	}
	if ledgerSum != updated.BalanceCredits || ledgerCount != 11 {
		t.Fatalf("ledger does not reconcile: sum=%d count=%d balance=%d", ledgerSum, ledgerCount, updated.BalanceCredits)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE credit_ledger SET delta_credits=0 WHERE user_id=$1`, user.ID); err == nil {
		t.Fatal("ledger history mutable")
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM audit_events`); err == nil {
		t.Fatal("audit history mutable")
	}
	if err := s.DeleteStream(ctx, stream.ID); err != nil {
		t.Fatal(err)
	}
	bets, err := s.ListBetsForUser(ctx, user.ID)
	if err != nil || len(bets) != 5 {
		t.Fatal("archive erased bets", err)
	}
	hidden, err := s.GetStream(ctx, stream.ID)
	if err != nil || hidden.IsActive {
		t.Fatal("archive failed", err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM streams WHERE id=$1`, stream.ID); err == nil {
		t.Fatal("history foreign key allowed cascade")
	}
}

func TestPostgresSessionHTTPAndRoleRevocation(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "admin@example.org", RoleAdmin, 0)
	stream := integrationStream(t, s, ctx)
	cfg := Config{FrontendOrigin: "http://localhost:4200", WorkerToken: strings.Repeat("a", 64)}
	handler := NewAPI(s, cfg).Routes()
	request := func(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Origin", cfg.FrontendOrigin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	login := request("POST", "/api/auth/login", `{"email":"admin@example.org","password":"integration-random-password"}`, nil)
	if login.Code != 200 {
		t.Fatal("login failed", login.Code, login.Body.String())
	}
	if strings.Contains(login.Body.String(), `"token"`) {
		t.Fatal("session leaked to JS")
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("login cookie missing")
	}
	cookie := cookies[0]
	var storedHash []byte
	if err := s.pool.QueryRow(ctx, `SELECT token_hash FROM auth_sessions WHERE user_id=$1`, admin.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if string(storedHash) == cookie.Value || len(storedHash) != 32 {
		t.Fatal("raw session persisted")
	}
	if got := request("GET", "/api/admin/streams", "", cookie); got.Code != 200 {
		t.Fatal("admin denied", got.Body.String())
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET role='user' WHERE id=$1`, admin.ID); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", "/api/admin/streams", "", cookie); got.Code != 403 {
		t.Fatal("session retained revoked admin role", got.Code)
	}
	if got := request("POST", "/api/auth/logout", "", cookie); got.Code != 200 || got.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout failed")
	}
	if got := request("GET", "/api/me", "", cookie); got.Code != 401 {
		t.Fatal("revoked cookie still valid")
	}
	token, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, admin.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=created_at+interval '1 microsecond'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSessionUser(ctx, sessionHash(token)); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired session accepted", err)
	}
	if err := s.DeleteStream(ctx, stream.ID); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", fmt.Sprintf("/api/streams/%d/markets", stream.ID), "", nil); got.Code != 404 {
		t.Fatal("hidden stream nested resource exposed", got.Code)
	}
	got := request("GET", "/api/streams?active=false", "", nil)
	var streams []Stream
	if err := json.Unmarshal(got.Body.Bytes(), &streams); err != nil || len(streams) != 0 {
		t.Fatal("public inactive filter exposed streams")
	}
	if got := request("GET", "/api/health", "", nil); got.Code != 200 {
		t.Fatal("database health failed")
	}
}

func TestPostgresWorkerMetricRetries(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	now := time.Now()
	metric := StreamMetric{StreamID: stream.ID, Source: "ai", VehicleCount: 42, IntervalStart: now.Add(-2 * time.Minute), IntervalEnd: now.Add(-time.Minute)}
	first, err := s.CreateStreamMetric(ctx, metric)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateStreamMetric(ctx, metric)
	if err != nil || first.ID != second.ID {
		t.Fatal("worker retry duplicated metric", err)
	}
	metric.VehicleCount = 43
	if _, err := s.CreateStreamMetric(ctx, metric); !errors.Is(err, ErrConflict) {
		t.Fatal("conflicting retry overwrote count", err)
	}
	rows, err := s.ListStreamMetrics(ctx, stream.ID, 50)
	if err != nil || len(rows) != 1 || rows[0].VehicleCount != 42 {
		t.Fatal("worker retry corrupted metric", err)
	}
}

func TestPostgresStartupMigrationsSerialize(t *testing.T) {
	s, ctx := integrationStore(t, false)
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { results <- RunMigrations(ctx, s.pool) }()
	}
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal("concurrent startup migrations failed", err)
		}
	}
	var versions int
	files, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil || versions != len(files) {
		t.Fatal("migration versions incorrect", versions, err)
	}
}

func TestPostgresSharedSettlementIntervalAndAudit(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "settler@example.org", RoleAdmin, 0)
	ctx = context.WithValue(ctx, userContextKey, admin)
	stream := integrationStream(t, s, ctx)
	first := integrationMarket(t, s, ctx, stream.ID)
	second := integrationMarket(t, s, ctx, stream.ID)
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id IN ($1,$2)`, first.ID, second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleMarket(ctx, first.ID, 42, verifiedSettlementFixture()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleMarket(ctx, second.ID, 43, verifiedSettlementFixture()); !errors.Is(err, ErrConflict) {
		t.Fatal("conflicting count for same interval accepted", err)
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM bet_markets WHERE id=$1`, second.ID).Scan(&status); err != nil || status != MarketOpen {
		t.Fatal("conflicting settlement changed market", status, err)
	}
	if _, err := s.SettleMarket(ctx, second.ID, 42, verifiedSettlementFixture()); err != nil {
		t.Fatal("same count could not reuse interval metric", err)
	}
	metrics, err := s.ListStreamMetrics(ctx, stream.ID, 50)
	if err != nil || len(metrics) != 1 {
		t.Fatal("duplicate manual interval metric", err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='market.settled' AND actor_user_id=$1`, admin.ID).Scan(&count); err != nil || count != 2 {
		t.Fatal("settlement audit missing or attributed incorrectly", count, err)
	}
}

func TestPostgresExplicitDemoSeed(t *testing.T) {
	s, ctx := integrationStore(t, true)
	cfg := Config{DemoAdminPassword: "demo-admin-random-password", DemoPlayerPassword: "demo-player-random-password"}
	if err := SeedDemoData(ctx, s, cfg); err != nil {
		t.Fatal(err)
	}
	streams, err := s.ListStreams(ctx, false)
	if err != nil || len(streams) != 6 {
		t.Fatal("seed camera catalog missing", err)
	}
	for _, stream := range streams {
		if stream.StreamType != StreamTypeHLS || (stream.SourceOwner != "Norwegian Public Roads Administration (Statens vegvesen)" && stream.SourceOwner != "California Department of Transportation (Caltrans)") || publicStream(stream).StreamURL != "" {
			t.Fatal("seed source metadata or upstream redaction invalid")
		}
	}
	admin, hash, err := s.GetUserByEmail(ctx, "admin@example.com")
	if err != nil || admin.Role != RoleAdmin || !CheckPassword(hash, cfg.DemoAdminPassword) {
		t.Fatal("configured demo admin credentials not applied", err)
	}
	if err := SeedDemoData(ctx, s, cfg); err != nil {
		t.Fatal(err)
	}
	markets, err := s.ListMarkets(ctx, &streams[0].ID, "")
	if err != nil || len(markets) != 1 || !markets[0].BettingClosesAt.After(time.Now()) {
		t.Fatal("seed is not idempotent or betting window invalid", err)
	}
}
