package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRoundScheduleValidation(t *testing.T) {
	base := defaultRoundSchedule(Stream{})
	if base.EntrySeconds != 30 || base.LeadSeconds != 30 || base.CountingSeconds != 30 {
		t.Fatal("new cameras must default to 30-second entry notice, cutoff lead and count")
	}
	if !validRoundSchedule(base) {
		t.Fatal("default schedule invalid")
	}
	for name, change := range map[string]func(*RoundScheduleSettings){
		"short gap":           func(p *RoundScheduleSettings) { p.LeadSeconds = 29 },
		"long gap":            func(p *RoundScheduleSettings) { p.LeadSeconds = 3601 },
		"entry zero":          func(p *RoundScheduleSettings) { p.EntrySeconds = 0 },
		"entry too short":     func(p *RoundScheduleSettings) { p.EntrySeconds = 29 },
		"entry unbounded":     func(p *RoundScheduleSettings) { p.EntrySeconds = 3601 },
		"count zero":          func(p *RoundScheduleSettings) { p.CountingSeconds = 0 },
		"count too short":     func(p *RoundScheduleSettings) { p.CountingSeconds = 29 },
		"count unbounded":     func(p *RoundScheduleSettings) { p.CountingSeconds = 3601 },
		"threshold negative":  func(p *RoundScheduleSettings) { p.Threshold = -1 },
		"threshold unbounded": func(p *RoundScheduleSettings) { p.Threshold = maxVehicleCount + 1 },
		"odds infinite":       func(p *RoundScheduleSettings) { p.OddsOver = math.Inf(1) },
		"odds nan":            func(p *RoundScheduleSettings) { p.OddsUnder = math.NaN() },
		"odds precision":      func(p *RoundScheduleSettings) { p.OddsUnder = 1.911 },
		"empty rule":          func(p *RoundScheduleSettings) { p.CountingRule = "  " },
		"long rule":           func(p *RoundScheduleSettings) { p.CountingRule = strings.Repeat("x", 161) },
		"control rule":        func(p *RoundScheduleSettings) { p.CountingRule = "line\nother" },
		"invalid utf8":        func(p *RoundScheduleSettings) { p.CountingRule = string([]byte{255}) },
	} {
		t.Run(name, func(t *testing.T) {
			p := base
			change(&p)
			if validRoundSchedule(p) {
				t.Fatal("invalid settings accepted")
			}
		})
	}
}

func TestPostgresAutomaticRoundsFiveCamerasConcurrentRestart(t *testing.T) {
	s, ctx := integrationStore(t, true)
	var ids []int64
	for i := 0; i < 5; i++ {
		stream := integrationStream(t, s, ctx)
		p := defaultRoundSchedule(stream)
		p.Enabled = true
		if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, stream.ID)
	}
	var wg sync.WaitGroup
	failures := make(chan error, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); failures <- NewStore(s.pool).RunRoundSchedules(ctx) }()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range ids {
		markets, err := s.ListMarkets(ctx, &id, "")
		if err != nil || len(markets) != 2 {
			t.Fatal("duplicate or missing scheduled round", id, len(markets), err)
		}
		m := markets[1]
		if m.Status != MarketOpen || !m.BettingClosesAt.After(time.Now()) || m.BettingClosesAt.Sub(m.CreatedAt) < 29*time.Second || m.BettingClosesAt.Sub(m.CreatedAt) > 31*time.Second || m.WindowStart.Sub(m.BettingClosesAt) != 30*time.Second || m.WindowEnd.Sub(m.WindowStart) != 30*time.Second {
			t.Fatal("wrong published terms", m)
		}
		next := markets[0]
		if !next.WindowStart.Equal(m.WindowEnd.Add(30*time.Second)) || next.WindowStart.Sub(m.WindowStart) != time.Minute || next.WindowStart.Sub(next.BettingClosesAt) != 30*time.Second || next.WindowEnd.Sub(next.WindowStart) != 30*time.Second {
			t.Fatal("unsafe successor terms", next)
		}
	}
	if err := NewStore(s.pool).RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ListRoundSchedules(ctx)
	if err != nil || len(snapshot.Schedules) != 5 {
		t.Fatal("missing persistent schedules", err)
	}
	for _, p := range snapshot.Schedules {
		if p.LastMarketID == nil || p.LastCheckedAt == nil || p.NextRunAt == nil || !p.Enabled {
			t.Fatal("restart lost schedule state", p)
		}
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM bet_markets`).Scan(&count); err != nil || count != 10 {
		t.Fatal("restart created duplicates", count, err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='market.auto_created' AND actor_user_id IS NULL`).Scan(&count); err != nil || count != 10 {
		t.Fatal("automatic audit missing", count, err)
	}
}

func TestPostgresAutomaticRoundFailureRollsBackPublicationAndRetries(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	// Simulate a publication failure after the INSERT and schedule UPDATE.
	if _, err := s.pool.Exec(ctx, `ALTER TABLE audit_events ADD CONSTRAINT block_auto_test CHECK (action<>'market.auto_created') NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if err := s.RunRoundSchedules(ctx); err == nil {
		t.Fatal("expected publication failure")
	}
	markets, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 0 {
		t.Fatal("failed transaction left a round", err)
	}
	snapshot, err := s.ListRoundSchedules(ctx)
	if err != nil || snapshot.Schedules[0].LastMarketID != nil || snapshot.Schedules[0].LastCheckedAt != nil {
		t.Fatal("failed transaction advanced state", err)
	}
	if _, err := s.pool.Exec(ctx, `ALTER TABLE audit_events DROP CONSTRAINT block_auto_test`); err != nil {
		t.Fatal(err)
	}
	if err := s.RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	markets, err = s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 2 {
		t.Fatal("worker did not recover on next tick", err)
	}
}

func TestPostgresAutomaticRoundsNextCycleDowntimeAndStakes(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	member := integrationUser(t, s, ctx, "schedule-member@example.org", RoleUser, 1000)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	p.LeadSeconds = 120 // An existing installation's longer wait remains published.
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	firstNow := time.Now().Add(time.Second)
	if err := s.runRoundSchedule(ctx, stream.ID, firstNow); err != nil {
		t.Fatal(err)
	}
	markets, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 2 {
		t.Fatal("initial bounded horizon missing", markets, err)
	}
	first, prepublished := markets[1], markets[0]
	bet, _, err := s.PlaceBet(ctx, member.ID, first.ID, BetSideOver, 100, "automatic-cycle-intent")
	if err != nil {
		t.Fatal(err)
	}
	p.Threshold = 999
	p.LeadSeconds = 30
	p.CountingSeconds = 420
	p.OddsOver = 2.25
	p.CountingRule = "Updated counting zone"
	if err = s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	if err = s.runRoundSchedule(ctx, stream.ID, first.BettingClosesAt.Add(-time.Nanosecond)); err != nil {
		t.Fatal(err)
	}
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 2 {
		t.Fatal("horizon grew despite two accepting rounds")
	}
	if err = s.runRoundSchedule(ctx, stream.ID, first.BettingClosesAt); err != nil {
		t.Fatal(err)
	}
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 3 {
		t.Fatal("successor was not replenished at cutoff")
	}
	newest := markets[0]
	if newest.Threshold != 999 || newest.OddsOver != 2.25 || newest.WindowStart.Sub(newest.BettingClosesAt) != 30*time.Second || newest.WindowEnd.Sub(newest.WindowStart) != 7*time.Minute || !strings.HasPrefix(newest.Title, p.CountingRule) {
		t.Fatal("new settings not applied", newest)
	}
	if markets[1].ID != prepublished.ID || markets[1].Threshold != prepublished.Threshold || markets[1].OddsOver != prepublished.OddsOver || markets[1].Title != prepublished.Title || markets[2].ID != first.ID || markets[2].Status != MarketOpen {
		t.Fatal("published terms changed", markets)
	}
	for _, original := range []Market{first, prepublished} {
		var stored Market
		for _, market := range markets {
			if market.ID == original.ID {
				stored = market
			}
		}
		if !stored.BettingClosesAt.Equal(original.BettingClosesAt) || !stored.WindowStart.Equal(original.WindowStart) || !stored.WindowEnd.Equal(original.WindowEnd) || stored.WindowStart.Sub(stored.BettingClosesAt) != 2*time.Minute {
			t.Fatal("shorter lead rewrote an existing round", stored)
		}
	}
	if err = s.runRoundSchedule(ctx, stream.ID, prepublished.BettingClosesAt.Add(-time.Nanosecond)); err != nil {
		t.Fatal(err)
	}
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 3 {
		t.Fatal("worker grew a full horizon")
	}
	resumedAt := newest.WindowEnd.Add(24 * time.Hour)
	if err = NewStore(s.pool).runRoundSchedule(ctx, stream.ID, resumedAt); err != nil {
		t.Fatal(err)
	}
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 5 || !markets[1].BettingClosesAt.After(resumedAt) || !markets[0].BettingClosesAt.After(resumedAt) {
		t.Fatal("downtime created catch-up rounds or insufficient horizon", markets)
	}
	var balance int64
	var status string
	var count int
	if err = s.pool.QueryRow(ctx, `SELECT balance_credits FROM users WHERE id=$1`, member.ID).Scan(&balance); err != nil || balance != 900 {
		t.Fatal("scheduler changed balance", balance, err)
	}
	if err = s.pool.QueryRow(ctx, `SELECT status FROM bets WHERE id=$1`, bet.ID).Scan(&status); err != nil || status != BetPending {
		t.Fatal("scheduler settled prediction", status, err)
	}
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM credit_ledger WHERE user_id=$1`, member.ID).Scan(&count); err != nil || count != 2 {
		t.Fatal("scheduler changed ledger", count, err)
	}
	conflict := markets[0]
	conflict.ID = 0
	if _, err = s.CreateMarket(ctx, conflict); !errors.Is(err, ErrConflict) {
		t.Fatal("manual publication overlapped automatic round", err)
	}
}

func TestPostgresAutomaticRoundsPauseArchiveRestoreAndManualWindows(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	manual := integrationMarket(t, s, ctx, stream.ID)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	if err := s.RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.ListRoundSchedules(ctx)
	if err != nil || !snapshot.Schedules[0].NextRunAt.Equal(manual.BettingClosesAt) || snapshot.Schedules[0].LastMarketID == nil {
		t.Fatal("manual window ignored", snapshot, err)
	}
	p.Enabled = false
	if err = s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	now := manual.BettingClosesAt.Add(time.Second)
	if err = s.runRoundSchedule(ctx, stream.ID, now); err != nil {
		t.Fatal(err)
	}
	markets, _ := s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 2 {
		t.Fatal("disabled schedule published")
	}
	p.Enabled = true
	if err = s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteStream(ctx, stream.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.runRoundSchedule(ctx, stream.ID, now); err != nil {
		t.Fatal(err)
	}
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 2 {
		t.Fatal("archived source published")
	}
	if err = s.SaveRoundSchedule(ctx, stream.ID, p); !errors.Is(err, ErrConflict) {
		t.Fatal("enabled an archived source", err)
	}
	if _, err = s.RestoreStream(ctx, stream.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.runRoundSchedule(ctx, stream.ID, now); err != nil {
		t.Fatal(err)
	}
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if len(markets) != 3 {
		t.Fatal("restored source did not resume")
	}
	p.Enabled = false
	if err = s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	// Disabling after publication preserves the published round itself.
	markets, _ = s.ListMarkets(ctx, &stream.ID, "")
	if markets[0].Status != MarketOpen {
		t.Fatal("pause mutated existing round")
	}
	for _, sourceType := range []string{StreamTypeImage, StreamTypeMP4, StreamTypeRTSP} {
		other := integrationStream(t, s, ctx)
		p.Enabled = true
		if err = s.SaveRoundSchedule(ctx, other.ID, p); err != nil {
			t.Fatal(err)
		}
		if _, err = s.pool.Exec(ctx, `UPDATE streams SET stream_type=$2 WHERE id=$1`, other.ID, sourceType); err != nil {
			t.Fatal(err)
		}
		if err = s.runRoundSchedule(ctx, other.ID, now); err != nil {
			t.Fatal(err)
		}
		rows, _ := s.ListMarkets(ctx, &other.ID, "")
		if len(rows) != 0 {
			t.Fatal("unsupported source published", sourceType)
		}
	}
	retired := integrationStream(t, s, ctx)
	if err = s.SaveRoundSchedule(ctx, retired.ID, p); err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE streams SET is_active=false,retired_at=now() WHERE id=$1`, retired.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.runRoundSchedule(ctx, retired.ID, now); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.ListMarkets(ctx, &retired.ID, "")
	if len(rows) != 0 {
		t.Fatal("retired source published")
	}
	if err = s.SaveRoundSchedule(ctx, retired.ID, p); !errors.Is(err, ErrNotFound) {
		t.Fatal("retired policy editable", err)
	}
}

func TestPostgresRoundScheduleAPIAuthValidationAndLiteralRules(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	admin := integrationUser(t, s, ctx, "schedule-admin@example.org", RoleAdmin, 0)
	member := integrationUser(t, s, ctx, "schedule-member@example.org", RoleUser, 1000)
	cookieFor := func(id int64) *http.Cookie {
		t.Helper()
		token, _ := newSessionToken()
		if err := s.CreateSession(ctx, id, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
		return &http.Cookie{Name: sessionCookieName, Value: token}
	}
	cookie := cookieFor(admin.ID)
	memberCookie := cookieFor(member.ID)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	initial := accountTestRequest(handler, "GET", "/api/admin/round-schedules", "", cookie)
	var defaults RoundScheduleSnapshot
	if initial.Code != 200 || json.Unmarshal(initial.Body.Bytes(), &defaults) != nil || len(defaults.Schedules) != 1 || defaults.Schedules[0].Enabled || defaults.Schedules[0].NextRunAt != nil || !validRoundSchedule(defaults.Schedules[0].RoundScheduleSettings) {
		t.Fatal("new camera did not start with disabled valid defaults", initial.Body.String())
	}
	path := fmt.Sprintf("/api/admin/round-schedules/%d", stream.ID)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	p.CountingRule = "Vehicle centers; ' OR 1=1 --"
	encoded, _ := json.Marshal(p)
	body := string(encoded)
	for _, methodPath := range [][2]string{{"GET", "/api/admin/round-schedules"}, {"PUT", path}} {
		if w := accountTestRequest(handler, methodPath[0], methodPath[1], body, nil); w.Code != 401 {
			t.Fatal("anonymous schedule access", w.Code)
		}
		if w := accountTestRequest(handler, methodPath[0], methodPath[1], body, memberCookie); w.Code != 403 {
			t.Fatal("member schedule access", w.Code)
		}
	}
	for _, invalid := range []string{`{}`, strings.Replace(body, `"leadSeconds":30`, `"leadSeconds":1`, 1), strings.TrimSuffix(body, "}") + `,"nextRunAt":"2030-01-01T00:00:00Z"}`, strings.TrimSuffix(body, "}") + `,"lastMarketId":1}`} {
		if w := accountTestRequest(handler, "PUT", path, invalid, cookie); w.Code != 400 {
			t.Fatal("invalid schedule accepted", w.Code, w.Body.String())
		}
	}
	if w := accountTestRequest(handler, "PUT", path, body, cookie); w.Code != 200 {
		t.Fatal("save failed", w.Code, w.Body.String())
	}
	if err := s.RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	w := accountTestRequest(handler, "GET", "/api/admin/round-schedules", "", cookie)
	var snapshot RoundScheduleSnapshot
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &snapshot) != nil || len(snapshot.Schedules) != 1 || snapshot.Schedules[0].CountingRule != p.CountingRule {
		t.Fatal("rule not safely stored as literal", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("admin config cached")
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='round_schedule.updated' AND actor_user_id=$1`, admin.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("admin configuration audit missing", count, err)
	}
}

func TestPostgresRoundPublicationWaitsForOverdueAIWithoutChangingPublishedTerms(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	ref, err := s.SaveCountingReference(ctx, stream.ID, preparationPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	profile, err := s.SaveCountingProfile(ctx, stream.ID, ref.ID, preparationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApproveCountingProfile(ctx, stream.ID, profile.ID, "Synthetic test approval for scheduler backpressure only."); err != nil {
		t.Fatal(err)
	}
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	if err = s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Second)
	if err = s.runRoundSchedule(ctx, stream.ID, now); err != nil {
		t.Fatal(err)
	}
	before, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(before) != 2 {
		t.Fatal(before, err)
	}
	delayedNow := before[1].WindowEnd.Add(31 * time.Second)
	for i := 0; i < 3; i++ {
		if err = s.runRoundSchedule(ctx, stream.ID, delayedNow); err != nil {
			t.Fatal(err)
		}
	}
	after, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(after) != 2 {
		t.Fatal("overdue AI expanded the horizon", len(after), err)
	}
	for i, m := range before {
		if m.ID != after[i].ID || m.Status != after[i].Status || m.Title != after[i].Title || !m.WindowStart.Equal(after[i].WindowStart) || !m.WindowEnd.Equal(after[i].WindowEnd) || m.Threshold != after[i].Threshold {
			t.Fatal("published terms changed")
		}
	}
	if _, err = s.VoidMarket(ctx, before[1].ID, "Synthetic missing footage; release the isolated test backlog."); err != nil {
		t.Fatal(err)
	}
	if err = s.runRoundSchedule(ctx, stream.ID, delayedNow); err != nil {
		t.Fatal(err)
	}
	after, err = s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(after) != 4 {
		t.Fatal("publication did not resume after resolution", len(after), err)
	}
}
