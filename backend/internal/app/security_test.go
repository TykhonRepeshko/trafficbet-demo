package app

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConfigRejectsUnsafeSettings(t *testing.T) {
	base := Config{DatabaseURL: "postgres://user:password@localhost/app?sslmode=disable", WorkerToken: strings.Repeat("a", 64), FrontendOrigin: "http://localhost:4200", AppEnv: "development"}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		change func(*Config)
	}{
		{"database missing", func(c *Config) { c.DatabaseURL = "" }},
		{"worker missing", func(c *Config) { c.WorkerToken = "" }},
		{"wildcard origin", func(c *Config) { c.FrontendOrigin = "*" }},
		{"origin with path", func(c *Config) { c.FrontendOrigin = "http://localhost:4200/" }},
		{"origin credentials", func(c *Config) { c.FrontendOrigin = "http://user:pass@localhost:4200" }},
		{"production http", func(c *Config) { c.AppEnv = "production"; c.CookieSecure = true }},
		{"production insecure cookie", func(c *Config) { c.AppEnv = "production"; c.FrontendOrigin = "https://traffic.example.org" }},
		{"seed without credentials", func(c *Config) { c.SeedDemoData = true }},
		{"seed same credentials", func(c *Config) {
			c.SeedDemoData = true
			c.DemoAdminPassword = "long-random-password"
			c.DemoPlayerPassword = c.DemoAdminPassword
		}},
		{"seed whitespace credentials", func(c *Config) {
			c.SeedDemoData = true
			c.DemoAdminPassword = strings.Repeat(" ", 12)
			c.DemoPlayerPassword = "different-long-password"
		}},
		{"seed short Unicode credentials", func(c *Config) {
			c.SeedDemoData = true
			c.DemoAdminPassword = strings.Repeat("🚗", 3)
			c.DemoPlayerPassword = "different-long-password"
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			tc.change(&c)
			if c.Validate() == nil {
				t.Fatal("unsafe config accepted")
			}
		})
	}
	production := base
	production.AppEnv = "production"
	production.CookieSecure = true
	production.FrontendOrigin = "https://traffic.example.org"
	if err := production.Validate(); err != nil {
		t.Fatal(err)
	}
	production.SeedDemoData = true
	if production.Validate() == nil {
		t.Fatal("production demo seed accepted")
	}
}

func TestLoadConfigFailsClosed(t *testing.T) {
	for _, key := range []string{"DATABASE_URL", "WORKER_TOKEN", "SEED_DEMO_DATA", "COOKIE_SECURE", "APP_ENV", "FRONTEND_ORIGIN", "VIDEO_EVIDENCE_ENABLED"} {
		t.Setenv(key, "")
	}
	cfg := LoadConfig()
	if cfg.SeedDemoData || cfg.CookieSecure || cfg.VideoEvidenceEnabled || cfg.FrontendOrigin != "http://localhost:4200" {
		t.Fatal("unsafe defaults")
	}
	t.Setenv("DATABASE_URL", "postgres://localhost/app")
	t.Setenv("WORKER_TOKEN", strings.Repeat("a", 64))
	t.Setenv("COOKIE_SECURE", "perhaps")
	if LoadConfig().Validate() == nil {
		t.Fatal("malformed boolean silently accepted")
	}
}

func TestOriginPolicy(t *testing.T) {
	api := &API{cfg: Config{FrontendOrigin: "http://localhost:4200"}}
	for _, tc := range []struct {
		method, path, origin string
		want                 int
	}{
		{"POST", "/api/auth/login", "", 403}, {"POST", "/api/auth/login", "https://evil.example", 403},
		{"POST", "/api/auth/login", "http://localhost:4200", 200}, {"GET", "/api/me", "", 200},
		{"GET", "/api/me", "http://localhost:4200.evil.example", 403},
		{"OPTIONS", "/api/auth/login", "http://localhost:4200", 204},
		{"POST", "/api/internal/streams/1/metrics", "", 200}, {"POST", "/api/internal/streams/1/metrics", "http://localhost:4200", 403},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		api.withCORS(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })(w, r)
		if w.Code != tc.want {
			t.Errorf("%s %s origin %q: %d want %d", tc.method, tc.path, tc.origin, w.Code, tc.want)
		}
		if tc.origin != "" && tc.want < 400 && w.Header().Get("Access-Control-Allow-Credentials") != "true" {
			t.Fatal("missing credential CORS")
		}
	}
}

func TestStrictJSON(t *testing.T) {
	for _, tc := range []struct {
		body, contentType string
		valid             bool
	}{
		{`{"value":1}`, "application/json", true}, {`{"value":1}`, "application/json; charset=utf-8", true},
		{`{"value":1}`, "text/plain", false}, {`{"unknown":1}`, "application/json", false},
		{`{"value":1} {"value":2}`, "application/json", false}, {`{"value":1,"value":2}`, "application/json", false}, {`{"value":1,"Value":2}`, "application/json", false},
		{`null`, "application/json", false}, {`[]`, "application/json", false}, {`{"value":1.5}`, "application/json", false},
		{strings.Repeat(" ", 65<<10) + `{"value":1}`, "application/json", false},
	} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.contentType)
		w := httptest.NewRecorder()
		var v struct {
			Value int `json:"value"`
		}
		if got := decodeJSON(w, r, &v); got != tc.valid {
			t.Errorf("body %.80q: valid=%v want=%v", tc.body, got, tc.valid)
		}
	}
	if uniqueJSONKeys([]byte(`{"outer":{"x":1,"x":2}}`)) {
		t.Fatal("nested duplicates accepted")
	}
	if !uniqueJSONKeys([]byte(`{"outer":[{"x":1},{"x":2}]}`)) {
		t.Fatal("separate object keys rejected")
	}
}

func TestSessionCookieAndHash(t *testing.T) {
	a, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if a == b || len(a) != 43 || len(sessionHash(a)) != 32 || bytes.Equal(sessionHash(a), []byte(a)) {
		t.Fatal("invalid random session material")
	}
	api := &API{cfg: Config{CookieSecure: true}}
	w := httptest.NewRecorder()
	api.setSessionCookie(w, a, time.Now().Add(sessionLifetime))
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("cookie missing")
	}
	c := cookies[0]
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/api" || c.MaxAge != 43200 || c.Domain != "" {
		t.Fatalf("unsafe cookie: %+v", c)
	}
	r := httptest.NewRequest("GET", "/api/me", nil)
	r.AddCookie(c)
	if sessionToken(r) != a {
		t.Fatal("valid session rejected")
	}
	r = httptest.NewRequest("GET", "/api/me", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "forged"})
	if sessionToken(r) != "" {
		t.Fatal("malformed session accepted")
	}
	w = httptest.NewRecorder()
	api.setSessionCookie(w, "", time.Time{})
	if w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout did not expire cookie")
	}
}

func TestLoginLimiter(t *testing.T) {
	limiter := &loginLimiter{buckets: make(map[string]loginBucket)}
	now := time.Now()
	for i := 0; i < 10; i++ {
		if !limiter.allow("127.0.0.1:1234", "admin@example.org", now) {
			t.Fatal("early limit")
		}
	}
	if limiter.allow("127.0.0.1:5678", " ADMIN@example.org ", now) {
		t.Fatal("source-port rotation bypasses limit")
	}
	if !limiter.allow("127.0.0.2:1234", "admin@example.org", now) {
		t.Fatal("independent peer blocked")
	}
	if !limiter.allow("127.0.0.1:1234", "admin@example.org", now.Add(15*time.Minute)) {
		t.Fatal("expired bucket not reset")
	}
	limiter.success("127.0.0.1:9999", "admin@example.org")
	for i := 0; i < 20; i++ {
		if !limiter.allow("127.0.0.1:1234", "admin@example.org", now.Add(15*time.Minute)) {
			t.Fatal("successful logins consumed rate budget")
		}
		limiter.success("127.0.0.1:1234", "admin@example.org")
	}
	limiter = &loginLimiter{buckets: make(map[string]loginBucket)}
	for i := 0; i < 100; i++ {
		if !limiter.allow("127.0.0.1:1234", fmt.Sprintf("random%d@example.org", i), now) {
			t.Fatal("peer budget ended early")
		}
	}
	if limiter.allow("127.0.0.1:5678", "next@example.org", now) {
		t.Fatal("random accounts bypassed peer limit")
	}
}

func TestWorkerToken(t *testing.T) {
	api := &API{cfg: Config{WorkerToken: strings.Repeat("a", 64)}}
	for _, token := range []string{"", strings.Repeat("b", 64), strings.Repeat("a", 64)} {
		r := httptest.NewRequest("POST", "/api/internal/streams/1/metrics", nil)
		r.Header.Set("X-Worker-Token", token)
		w := httptest.NewRecorder()
		api.requireWorker(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })(w, r)
		want := 401
		if token == api.cfg.WorkerToken {
			want = 200
		}
		if w.Code != want {
			t.Fatal("worker auth accepted invalid token")
		}
	}
}

func TestBettingAndSettlementBoundaries(t *testing.T) {
	now := time.Now()
	market := Market{Status: MarketOpen, BettingClosesAt: now.Add(time.Hour - minimumObservationLead), WindowStart: now.Add(time.Hour), WindowEnd: now.Add(2 * time.Hour)}
	if err := checkBettingOpen(market, now); err != nil {
		t.Fatal("pre-observation bet rejected:", err)
	}
	if !errors.Is(checkBettingOpen(market, market.BettingClosesAt), ErrConflict) {
		t.Fatal("bet accepted at close")
	}
	unsafe := market
	unsafe.BettingClosesAt = unsafe.WindowStart.Add(-minimumObservationLead + time.Nanosecond)
	if !errors.Is(checkBettingOpen(unsafe, now), ErrConflict) {
		t.Fatal("legacy market without the safety gap accepted a fresh bet")
	}
	if !errors.Is(checkSettlementAllowed(market, 0, now), ErrConflict) {
		t.Fatal("premature settlement accepted")
	}
	if err := checkSettlementAllowed(market, 0, market.WindowEnd); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{MarketDraft, MarketVoid, MarketSettled} {
		market.Status = status
		if checkSettlementAllowed(market, 10, market.WindowEnd) == nil {
			t.Fatal("invalid state settled")
		}
	}
	for _, tc := range []struct {
		stake int64
		odds  float64
		want  int64
	}{{1, 1.5, 2}, {3, 1.9, 6}, {100000, 100, 10000000}} {
		got, err := payoutCredits(tc.stake, tc.odds)
		if err != nil || got != tc.want {
			t.Fatalf("payout got %d,%v want %d", got, err, tc.want)
		}
	}
	for _, tc := range []struct {
		stake int64
		odds  float64
	}{{0, 1.9}, {100001, 1.9}, {1, 100.01}, {1, 1.999}} {
		if _, err := payoutCredits(tc.stake, tc.odds); err == nil {
			t.Fatal("unsafe payout accepted")
		}
	}
}

func TestStreamURLValidation(t *testing.T) {
	for _, value := range []string{"https://camera.example.org/feed.m3u8", "/media/camera-01/index.m3u8"} {
		if err := validateStreamURL(value); err != nil {
			t.Errorf("valid URL %q: %v", value, err)
		}
	}
	for _, value := range []string{"http://camera.example.org/a", "https://user:pass@camera.example.org/a", "https://127.0.0.1/a", "https://[::1]/a", "https://127.1/a", "https://localhost/a", "https://camera.local/a", "https://camera.example.org:8080/a", "javascript:alert(1)", "//evil.example/a", "/media/../secret", "/media/%2e%2e/secret", "/media//secret", "/media/file?token=secret", "/media/a\\b"} {
		if validateStreamURL(value) == nil {
			t.Errorf("unsafe URL accepted: %q", value)
		}
	}
}

func TestInternalErrorsAreGeneric(t *testing.T) {
	var logs bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousOutput) })
	w := httptest.NewRecorder()
	writeStoreError(w, errors.New("postgres://admin:synthetic-secret@db/private?sslmode=disable"))
	if w.Code != 500 || strings.Contains(w.Body.String(), "synthetic-secret") {
		t.Fatal("internal details exposed")
	}
	if strings.Contains(logs.String(), "synthetic-secret") || strings.Contains(logs.String(), "postgres://") {
		t.Fatal("internal details exposed in application logs")
	}
	if !strings.Contains(logs.String(), "status=500 code=server_error") {
		t.Fatal("safe failure classification missing from logs")
	}
}

func TestPublicStreamRedactsUpstreamCredentials(t *testing.T) {
	upstream := Stream{StreamURL: "https://camera.example.org/feed?api_key=private", ThumbnailURL: "https://camera.example.org/image?token=private"}
	public := publicStream(upstream)
	if public.StreamURL != "" || public.ThumbnailURL != "" {
		t.Fatal("upstream credentials exposed")
	}
	if upstream.StreamURL == "" {
		t.Fatal("admin source was mutated")
	}
	media := publicStream(Stream{StreamURL: "/media/camera-01/index.m3u8"})
	if media.StreamURL != "/media/camera-01/index.m3u8" {
		t.Fatal("safe media path hidden")
	}
}
