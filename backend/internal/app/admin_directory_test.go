package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestDirectoryParametersRejectAmbiguousAndUnboundedInput(t *testing.T) {
	for _, query := range []string{"page=0", "page=-1", "page=1000001", "page=1&page=2", "page=", "page=%2B1", "pageSize=0", "pageSize=201", "pageSize=999999999999999999999999", "pageSize=2&pageSize=3", "q=a&q=b", "q=" + strings.Repeat("x", 255), "q=a%00b", "q=%FF"} {
		t.Run(query[:min(len(query), 60)], func(t *testing.T) {
			api := &API{store: &Store{}}
			w := httptest.NewRecorder()
			api.handleAdminUsers(w, httptest.NewRequest(http.MethodGet, "/api/admin/users?"+query, nil))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("invalid input reached database: %d", w.Code)
			}
		})
	}
}

func TestPostgresAdminDirectoryPagesSearchAndPrivacy(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "directory-admin@example.org", RoleAdmin, 0)
	hash, err := HashPassword("directory-fixture-password")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO users(email,password_hash,display_name,role,balance_credits,created_at)
		SELECT 'member'||lpad(n::text,3,'0')||'@example.test',$1,'Member '||lpad(n::text,3,'0'),'user',0,now() FROM generate_series(1,61) n`, hash)
	if err != nil {
		t.Fatal(err)
	}
	var specialID int64
	if err := s.pool.QueryRow(ctx, `INSERT INTO users(email,password_hash,display_name,role,balance_credits) VALUES ('literal@example.test',$1,$2,'user',0) RETURNING id`, hash, "D'Arcy 100%_Literal").Scan(&specialID); err != nil {
		t.Fatal(err)
	}
	token, err := newSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, admin.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	getPage := func(query string) UserPage {
		t.Helper()
		w := accountTestRequest(handler, "GET", "/api/admin/users?"+query, "", cookie)
		var page UserPage
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &page) != nil {
			t.Fatalf("page failed: %d %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), hash) || strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), "token") {
			t.Fatal("directory exposed authentication data")
		}
		return page
	}
	seen := map[int64]bool{}
	for number := 1; number <= 7; number++ {
		page := getPage(fmt.Sprintf("page=%d&pageSize=10", number))
		if page.Total != 63 || page.TotalPages != 7 || page.Page != number || page.PageSize != 10 {
			t.Fatal("incorrect page metadata", page)
		}
		for _, user := range page.Items {
			if seen[user.ID] {
				t.Fatal("account duplicated across pages", user.ID)
			}
			seen[user.ID] = true
		}
	}
	if len(seen) != 63 {
		t.Fatal("pagination omitted older accounts", len(seen))
	}
	if page := getPage("page=1000000&pageSize=10"); page.Page != 7 || len(page.Items) != 3 {
		t.Fatal("out-of-range page was not clamped", page)
	}
	for _, query := range []string{"MEMBER001@EXAMPLE.TEST", " Member 001 ", "100%_Literal", "%", "_", "D'Arcy", fmt.Sprint(specialID)} {
		if page := getPage("page=1&pageSize=25&q=" + url.QueryEscape(query)); page.Total != 1 || len(page.Items) != 1 {
			t.Fatal("literal or case-insensitive search failed", query, page)
		}
	}
	for _, query := range []string{"' OR 1=1--", "not-a-member"} {
		if page := getPage("page=1&q=" + url.QueryEscape(query)); page.Total != 0 || page.Page != 1 || page.TotalPages != 1 || len(page.Items) != 0 {
			t.Fatal("empty or SQL-like search leaked rows", page)
		}
	}
	legacy := accountTestRequest(handler, "GET", "/api/admin/users", "", cookie)
	var users []User
	if legacy.Code != 200 || json.Unmarshal(legacy.Body.Bytes(), &users) != nil || len(users) != 50 {
		t.Fatal("legacy bounded-array contract changed")
	}
	if w := accountTestRequest(handler, "GET", "/api/admin/users?page=1", "", nil); w.Code != 401 {
		t.Fatal("anonymous directory access allowed", w.Code)
	}
	memberToken, _ := newSessionToken()
	if err := s.CreateSession(ctx, specialID, sessionHash(memberToken), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	if w := accountTestRequest(handler, "GET", "/api/admin/users?page=1&q=member", "", &http.Cookie{Name: sessionCookieName, Value: memberToken}); w.Code != 403 {
		t.Fatal("member directory access allowed", w.Code)
	}
}

func TestPostgresCameraRestorePreservesSourceAndHistory(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "restore-admin@example.org", RoleAdmin, 0)
	member := integrationUser(t, s, ctx, "restore-member@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	bet, _, err := s.PlaceBet(ctx, member.ID, market.ID, BetSideOver, 100, "restore-history-intent")
	if err != nil {
		t.Fatal(err)
	}
	token, _ := newSessionToken()
	if err := s.CreateSession(ctx, admin.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	memberToken, _ := newSessionToken()
	if err := s.CreateSession(ctx, member.ID, sessionHash(memberToken), time.Now().Add(time.Hour), ""); err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	path := fmt.Sprintf("/api/admin/streams/%d", stream.ID)
	if w := accountTestRequest(handler, "DELETE", path, "", cookie); w.Code != 200 {
		t.Fatal("archive failed", w.Code)
	}
	if w := accountTestRequest(handler, "GET", fmt.Sprintf("/api/streams/%d", stream.ID), "", nil); w.Code != 404 {
		t.Fatal("archived camera remained public")
	}
	if w := accountTestRequest(handler, "PATCH", path+"/restore", `{}`, nil); w.Code != 401 {
		t.Fatal("anonymous restoration allowed")
	}
	if w := accountTestRequest(handler, "PATCH", path+"/restore", `{}`, &http.Cookie{Name: sessionCookieName, Value: memberToken}); w.Code != 403 {
		t.Fatal("member restoration allowed")
	}
	if w := accountTestRequest(handler, "PATCH", path+"/restore", `{"streamUrl":"https://example.org/replacement"}`, cookie); w.Code != 400 {
		t.Fatal("restoration accepted source changes")
	}
	var restored Stream
	for i := 0; i < 2; i++ {
		w := accountTestRequest(handler, "PATCH", path+"/restore", `{}`, cookie)
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &restored) != nil || !restored.IsActive || restored.StreamURL != stream.StreamURL || !restored.CreatedAt.Equal(stream.CreatedAt) {
			t.Fatal("restore changed identity or source", w.Code, w.Body.String())
		}
	}
	if w := accountTestRequest(handler, "GET", fmt.Sprintf("/api/streams/%d", stream.ID), "", nil); w.Code != 200 {
		t.Fatal("restored camera missing publicly")
	}
	var audits int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='stream.restored' AND actor_user_id=$2`, stream.ID, admin.ID).Scan(&audits); err != nil || audits != 1 {
		t.Fatal("restore audit duplicated or missing", audits, err)
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM bets WHERE id=$1`, bet.ID).Scan(&status); err != nil || status != BetPending {
		t.Fatal("restoration changed prediction history", status, err)
	}
	user, err := s.GetUserByID(ctx, member.ID)
	if err != nil || user.BalanceCredits != 900 {
		t.Fatal("restoration changed balance", user, err)
	}
}
