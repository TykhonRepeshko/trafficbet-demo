package app

import (
	"bytes"
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

func TestRegistrationValidation(t *testing.T) {
	valid := registrationInput{Email: "  PLAYER@Example.org  ", DisplayName: "  Игрок  ", Password: "safe-random-password"}
	got, ok := normalizeRegistration(valid)
	if !ok || got.Email != "player@example.org" || got.DisplayName != "Игрок" {
		t.Fatalf("registration was not canonicalized: %+v valid=%v", got, ok)
	}
	for _, tc := range []struct {
		name string
		edit func(*registrationInput)
	}{
		{"missing email", func(v *registrationInput) { v.Email = "" }},
		{"invalid email", func(v *registrationInput) { v.Email = "player@@example.org" }},
		{"email display name", func(v *registrationInput) { v.Email = "Player <player@example.org>" }},
		{"email list", func(v *registrationInput) { v.Email = "a@example.org,b@example.org" }},
		{"long email", func(v *registrationInput) { v.Email = strings.Repeat("a", 255) + "@example.org" }},
		{"short name", func(v *registrationInput) { v.DisplayName = " я " }},
		{"long unicode name", func(v *registrationInput) { v.DisplayName = strings.Repeat("я", 81) }},
		{"control in name", func(v *registrationInput) { v.DisplayName = "Play\ner" }},
		{"short password", func(v *registrationInput) { v.Password = "short" }},
		{"short unicode password", func(v *registrationInput) { v.Password = strings.Repeat("я", 6) }},
		{"short emoji password", func(v *registrationInput) { v.Password = strings.Repeat("🚗", 3) }},
		{"bcrypt truncation", func(v *registrationInput) { v.Password = strings.Repeat("я", 37) }},
		{"blank password", func(v *registrationInput) { v.Password = strings.Repeat(" ", 12) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := valid
			tc.edit(&input)
			if _, ok := normalizeRegistration(input); ok {
				t.Fatal("unsafe registration accepted")
			}
		})
	}
	valid.DisplayName = strings.Repeat("я", 80)
	valid.Password = strings.Repeat("я", 12)
	if _, ok := normalizeRegistration(valid); !ok {
		t.Fatal("valid unicode display name or password counted incorrectly")
	}
}

func TestRegistrationLimiterBudgets(t *testing.T) {
	limiter := &loginLimiter{buckets: make(map[string]loginBucket)}
	now := time.Now()
	for i := 0; i < 5; i++ {
		if !limiter.allowLimited("127.0.0.1:1000", "player@example.org", now, 20, 5) {
			t.Fatal("registration blocked too early")
		}
	}
	if limiter.allowLimited("127.0.0.1:2000", " PLAYER@EXAMPLE.ORG ", now, 20, 5) {
		t.Fatal("source port or email case bypassed registration limit")
	}
	if !limiter.allowLimited("127.0.0.2:1000", "player@example.org", now, 20, 5) {
		t.Fatal("independent peer blocked")
	}
	if !limiter.allowLimited("127.0.0.1:1000", "player@example.org", now.Add(15*time.Minute), 20, 5) {
		t.Fatal("registration budget never expires")
	}
	limiter = &loginLimiter{buckets: make(map[string]loginBucket)}
	for i := 0; i < 20; i++ {
		if !limiter.allowLimited("127.0.0.1:1000", fmt.Sprintf("p%d@example.org", i), now, 20, 5) {
			t.Fatal("peer budget ended early")
		}
	}
	if limiter.allowLimited("127.0.0.1:1001", "next@example.org", now, 20, 5) {
		t.Fatal("varying email bypassed peer budget")
	}
}

func TestRegistrationHTTPRateLimit(t *testing.T) {
	limiter := &loginLimiter{buckets: make(map[string]loginBucket)}
	for i := 0; i < 5; i++ {
		limiter.allowLimited("192.0.2.1:1234", "player@example.org", time.Now(), 20, 5)
	}
	api := &API{cfg: Config{FrontendOrigin: "http://localhost:4200"}, registrations: limiter}
	w := accountTestRequest(api.Routes(), "POST", "/api/auth/register", `{"email":"player@example.org","displayName":"Player","password":"safe-random-password"}`, nil)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "900" || !strings.Contains(w.Body.String(), "registration_rate_limited") {
		t.Fatal("registration budget did not produce retry response", w.Code, w.Body.String())
	}
}

func accountTestRequest(handler http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Origin", "http://localhost:4200")
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestPostgresAccountRegistrationAndLedgerPrivacy(t *testing.T) {
	s, ctx := integrationStore(t, true)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200", CookieSecure: true}).Routes()
	for _, extra := range []string{`,"role":"admin"`, `,"balanceCredits":999999`, `,"email":"replacement@example.org"`} {
		w := accountTestRequest(handler, "POST", "/api/auth/register", `{"email":"injected@example.org","displayName":"Player","password":"safe-random-password"`+extra+`}`, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatal("injected registration fields accepted", w.Code, w.Body.String())
		}
	}
	if _, _, err := s.GetUserByEmail(ctx, "injected@example.org"); !errors.Is(err, ErrNotFound) {
		t.Fatal("rejected registration created account", err)
	}
	w := accountTestRequest(handler, "POST", "/api/auth/register", `{"email":"  PLAYER@Example.org  ","displayName":" Игрок ","password":"safe-random-password"}`, nil)
	if w.Code != http.StatusCreated {
		t.Fatal("registration failed", w.Code, w.Body.String())
	}
	var response struct {
		User User `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	user := response.User
	if user.Email != "player@example.org" || user.DisplayName != "Игрок" || user.Role != RoleUser || user.BalanceCredits != openingVirtualCredits {
		t.Fatalf("registered user wrong: %+v", user)
	}
	if strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "token") {
		t.Fatal("registration response exposed secrets")
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("registration session cookie unsafe", cookies)
	}
	cookie := cookies[0]
	stored, passwordHash, err := s.GetUserByEmail(ctx, " PLAYER@EXAMPLE.ORG ")
	if err != nil || stored.ID != user.ID || passwordHash == "safe-random-password" || !CheckPassword(passwordHash, "safe-random-password") {
		t.Fatal("registration was not persisted with a hash", err)
	}
	var storedToken []byte
	if err := s.pool.QueryRow(ctx, `SELECT token_hash FROM auth_sessions WHERE user_id=$1`, user.ID).Scan(&storedToken); err != nil || !bytes.Equal(storedToken, sessionHash(cookie.Value)) {
		t.Fatal("hashed session was not persisted", err)
	}
	if got := accountTestRequest(handler, "GET", "/api/me", "", cookie); got.Code != http.StatusOK {
		t.Fatal("registration session not usable", got.Code)
	}
	if got := accountTestRequest(handler, "GET", "/api/admin/users", "", cookie); got.Code != http.StatusForbidden {
		t.Fatal("registered user can inspect account directory", got.Code)
	}
	if got := accountTestRequest(handler, "GET", "/api/me/ledger", "", nil); got.Code != http.StatusUnauthorized {
		t.Fatal("unauthenticated ledger access allowed", got.Code)
	}
	other := integrationUser(t, s, ctx, "other@example.org", RoleUser, 123)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	if _, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, "registered-player-intent"); err != nil {
		t.Fatal(err)
	}
	ledger := accountTestRequest(handler, "GET", fmt.Sprintf("/api/me/ledger?userId=%d&limit=200", other.ID), "", cookie)
	var entries []CreditLedgerEntry
	if ledger.Code != http.StatusOK || json.Unmarshal(ledger.Body.Bytes(), &entries) != nil || len(entries) != 2 {
		t.Fatal("ledger unavailable or foreign entries exposed", ledger.Code, ledger.Body.String())
	}
	if entries[0].Reason != "stake" || entries[0].DeltaCredits != -100 || entries[0].BalanceAfter != 9900 || entries[1].Reason != "opening" || entries[1].DeltaCredits != openingVirtualCredits {
		t.Fatal("ledger does not match account mutations", entries)
	}
	duplicate := accountTestRequest(handler, "POST", "/api/auth/register", `{"email":"PLAYER@example.org","displayName":"Another","password":"different-safe-password"}`, nil)
	if duplicate.Code != http.StatusConflict || len(duplicate.Result().Cookies()) != 0 || !strings.Contains(duplicate.Body.String(), "account_unavailable") {
		t.Fatal("duplicate registration not rejected safely", duplicate.Code, duplicate.Body.String())
	}
	var openingCount, auditCount int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM credit_ledger WHERE user_id=$1 AND reason='opening'`, user.ID).Scan(&openingCount); err != nil || openingCount != 1 {
		t.Fatal("duplicate opening balance", openingCount, err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor_user_id=$1 AND action='user.registered'`, user.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatal("registration audit incorrect", auditCount, err)
	}
	if got := accountTestRequest(handler, "POST", "/api/auth/logout", "", cookie); got.Code != http.StatusOK {
		t.Fatal("logout failed", got.Code)
	}
	if got := accountTestRequest(handler, "GET", "/api/me", "", cookie); got.Code != http.StatusUnauthorized {
		t.Fatal("logout did not revoke registration session", got.Code)
	}
	login := accountTestRequest(handler, "POST", "/api/auth/login", `{"email":" PLAYER@example.org ","password":"safe-random-password"}`, nil)
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatal("registered account cannot sign in", login.Code, login.Body.String())
	}
	admin := integrationUser(t, s, ctx, "admin@example.org", RoleAdmin, 0)
	token, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, admin.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	directory := accountTestRequest(handler, "GET", "/api/admin/users", "", &http.Cookie{Name: sessionCookieName, Value: token})
	var users []User
	if directory.Code != http.StatusOK || json.Unmarshal(directory.Body.Bytes(), &users) != nil || len(users) != 3 {
		t.Fatal("admin account list wrong", directory.Code, directory.Body.String())
	}
	if strings.Contains(directory.Body.String(), "password") || strings.Contains(directory.Body.String(), "token") || strings.Contains(directory.Body.String(), passwordHash) {
		t.Fatal("admin account directory exposed secrets")
	}
}

func TestPostgresConcurrentNormalizedRegistration(t *testing.T) {
	s, ctx := integrationStore(t, true)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	emails := []string{"player@example.org", "PLAYER@EXAMPLE.ORG", " player@example.org ", " Player@example.org "}
	results := make(chan int, len(emails))
	var wg sync.WaitGroup
	for _, email := range emails {
		wg.Add(1)
		go func(email string) {
			defer wg.Done()
			body, _ := json.Marshal(registrationInput{Email: email, DisplayName: "Player", Password: "safe-random-password"})
			results <- accountTestRequest(handler, "POST", "/api/auth/register", string(body), nil).Code
		}(email)
	}
	wg.Wait()
	close(results)
	created := 0
	for status := range results {
		if status == http.StatusCreated {
			created++
		} else if status != http.StatusConflict {
			t.Fatal("unexpected concurrent registration result", status)
		}
	}
	if created != 1 {
		t.Fatal("concurrent registration created multiple accounts", created)
	}
	var userCount, ledgerCount, sessionCount, auditCount int
	var balance, ledgerTotal int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*),COALESCE(sum(balance_credits),0) FROM users`).Scan(&userCount, &balance); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*),COALESCE(sum(delta_credits),0) FROM credit_ledger`).Scan(&ledgerCount, &ledgerTotal); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions`).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='user.registered'`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if userCount != 1 || ledgerCount != 1 || sessionCount != 1 || auditCount != 1 || balance != openingVirtualCredits || ledgerTotal != balance {
		t.Fatalf("registration is not atomic: users=%d ledger=%d sessions=%d audit=%d balance=%d ledgerTotal=%d", userCount, ledgerCount, sessionCount, auditCount, balance, ledgerTotal)
	}
}

func TestPostgresRegistrationRollsBackWhenSessionFails(t *testing.T) {
	s, ctx := integrationStore(t, true)
	hash, err := HashPassword("safe-random-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RegisterAccount(ctx, "rollback@example.org", hash, "Player", []byte("invalid session hash"), time.Now().Add(time.Hour), ""); err == nil {
		t.Fatal("invalid session unexpectedly accepted")
	}
	for _, table := range []string{"users", "credit_ledger", "audit_events", "auth_sessions"} {
		var count int
		if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatal("partial account registration survived rollback", table, count, err)
		}
	}
}

func TestPostgresAccountMigrationPreservesCollidingAccounts(t *testing.T) {
	s, ctx := integrationStore(t, false)
	// Recreate an application before the canonical-email upgrade.
	if _, err := s.pool.Exec(ctx, `CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001_init.sql", "002_security.sql"} {
		migration, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
		if _, err := s.pool.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES ($1)`, name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO users(email,password_hash,display_name,role,balance_credits) VALUES ('Player@example.org','unused','First','user',100),('player@example.org','unused','Second','user',200)`); err != nil {
		t.Fatal(err)
	}
	if err := RunMigrations(ctx, s.pool); err == nil {
		t.Fatal("canonical migration silently accepted colliding accounts")
	}
	var count, canonicalUpper int
	var balance int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*),sum(balance_credits),count(*) FILTER (WHERE email='Player@example.org') FROM users`).Scan(&count, &balance, &canonicalUpper); err != nil || count != 2 || balance != 300 || canonicalUpper != 1 {
		t.Fatal("failed migration modified historical accounts", count, balance, canonicalUpper, err)
	}
	var versions int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil || versions != 2 {
		t.Fatal("failed canonical migration was marked applied", versions, err)
	}
}
