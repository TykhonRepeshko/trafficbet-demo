package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPostgresSessionDirectoryPasswordAndRemovedSecondFactor(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "security-owner@example.test", RoleUser, 1000)
	other := integrationUser(t, s, ctx, "security-other@example.test", RoleUser, 0)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	cookieFor := func(id int64) *http.Cookie {
		token, _ := newSessionToken()
		if err := s.CreateSession(ctx, id, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
		return &http.Cookie{Name: sessionCookieName, Value: token}
	}
	current, old, foreign := cookieFor(user.ID), cookieFor(user.ID), cookieFor(other.ID)
	post := func(path string, input any, cookie *http.Cookie, status int) {
		t.Helper()
		body, _ := json.Marshal(input)
		w := accountTestRequest(handler, "POST", path, string(body), cookie)
		if w.Code != status {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	w := accountTestRequest(handler, "GET", "/api/me/security", "", current)
	if w.Code != 200 || strings.Contains(w.Body.String(), current.Value) || strings.Contains(w.Body.String(), "token_hash") || strings.Contains(w.Body.String(), "mfa") {
		t.Fatal("security directory leaked authentication state")
	}
	var page struct {
		Sessions []struct {
			ID      int64 `json:"id"`
			Current bool  `json:"current"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Sessions) != 2 {
		t.Fatal("directory ownership failed")
	}
	var oldID, foreignID int64
	for _, v := range page.Sessions {
		if !v.Current {
			oldID = v.ID
		}
	}
	if err := s.pool.QueryRow(ctx, `SELECT id FROM auth_sessions WHERE token_hash=$1`, sessionHash(foreign.Value)).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}
	post("/api/me/security/revoke", map[string]any{"password": "wrong password", "sessionId": oldID}, current, 400)
	if w := accountTestRequest(handler, "GET", "/api/me", "", old); w.Code != 200 {
		t.Fatal("bad credentials changed another session")
	}
	post("/api/me/security/revoke", map[string]any{"password": "integration-random-password", "sessionId": foreignID}, current, 200)
	if w := accountTestRequest(handler, "GET", "/api/me", "", foreign); w.Code != 200 {
		t.Fatal("foreign session revoked")
	}
	post("/api/me/security/revoke", map[string]any{"password": "integration-random-password", "sessionId": oldID}, current, 200)
	if w := accountTestRequest(handler, "GET", "/api/me", "", old); w.Code != 401 {
		t.Fatal("revocation did not persist")
	}
	another := cookieFor(user.ID)
	_, oldHash, _ := s.GetUserByEmail(ctx, user.Email)
	post("/api/me/security/password", map[string]any{"password": "integration-random-password", "newPassword": "updated-secure-password-2026"}, current, 200)
	if w := accountTestRequest(handler, "GET", "/api/me", "", another); w.Code != 401 {
		t.Fatal("password change did not revoke other sessions")
	}
	if w := accountTestRequest(handler, "GET", "/api/me", "", current); w.Code != 200 {
		t.Fatal("current session unexpectedly lost")
	}
	token, _ := newSessionToken()
	if err := s.authenticatedSession(ctx, user, oldHash, sessionHash(token), time.Now().Add(time.Hour), ""); !errors.Is(err, errUnauthorized) {
		t.Fatal("stale password issued a session", err)
	}
	post("/api/auth/login", map[string]any{"email": user.Email, "password": "updated-secure-password-2026"}, nil, 200)
	post("/api/auth/login", map[string]any{"email": user.Email, "password": "updated-secure-password-2026", "code": "123456"}, nil, 400)
	for _, path := range []string{"setup", "enable", "disable"} {
		post("/api/me/security/"+path, map[string]any{}, current, 404)
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT to_regclass('auth_mfa') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatal("discarded second-factor state retained", err)
	}
	fresh, _ := s.GetUserByID(ctx, user.ID)
	if fresh.BalanceCredits != 1000 {
		t.Fatal("account security changed credits")
	}
}
