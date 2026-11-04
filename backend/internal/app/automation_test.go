package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func intPointer(value int) *int { return &value }

func TestAutomaticResultValidation(t *testing.T) {
	valid := AutomaticResultInput{Outcome: "counted", VehicleCount: intPointer(7), Reason: "7 crossings counted", Worker: "trafficbet-counter/1.0", Evidence: json.RawMessage(`{"fps": 6}`)}
	if got, err := normalizeAutomaticResult(valid); err != nil || string(got.Evidence) != `{"fps":6}` {
		t.Fatal("valid counted result rejected or evidence not compacted", err, string(got.Evidence))
	}
	cases := map[string]AutomaticResultInput{
		"counted without count": {Outcome: "counted", Reason: "missing", Worker: "w"},
		"negative count":        {Outcome: "counted", VehicleCount: intPointer(-1), Reason: "negative", Worker: "w"},
		"invalid with count":    {Outcome: "invalid", VehicleCount: intPointer(1), Reason: "camera_moved", Worker: "w"},
		"expired is reserved":   {Outcome: "expired", Reason: "late result", Worker: "w"},
		"short reason":          {Outcome: "invalid", Reason: "no", Worker: "w"},
		"control characters":    {Outcome: "invalid", Reason: "camera\x00moved", Worker: "w"},
		"empty worker":          {Outcome: "invalid", Reason: "camera_moved", Worker: " "},
		"evidence array":        {Outcome: "invalid", Reason: "camera_moved", Worker: "w", Evidence: json.RawMessage(`[1]`)},
		"evidence too large":    {Outcome: "invalid", Reason: "camera_moved", Worker: "w", Evidence: json.RawMessage(`{"x":"` + strings.Repeat("a", 70<<10) + `"}`)},
	}
	for name, input := range cases {
		if _, err := normalizeAutomaticResult(input); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: expected ErrInvalid, got %v", name, err)
		}
	}
	if reason := automaticVoidReason(strings.Repeat("é", 600)); utf8.RuneCountInString(reason) != 500 || !validVoidReason(reason) {
		t.Fatal("void reason was not bounded to a valid 500-character reason")
	}
}

func automationTestPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 36))
	for x := 0; x < 64; x++ {
		img.Set(x, 20, color.White)
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func automationTestDefinition() CountingDefinition {
	return CountingDefinition{Label: "Automatic line v1", LineStart: CountingPoint{X: 0.05, Y: 0.6}, LineEnd: CountingPoint{X: 0.95, Y: 0.6},
		Directions: []string{"A_to_B", "B_to_A"}, Classes: []string{"car", "van", "bus", "truck", "motorcycle"}, Anchor: "bottom_center", TimeBasis: "capture_utc",
		Notes: "Generated automatically from 12 vehicle tracks in the integration test."}
}

func endAutomationWindow(t *testing.T, s *Store, ctx context.Context, marketID int64, ago time.Duration) {
	t.Helper()
	end := time.Now().Add(-ago)
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=$2::timestamptz-interval '2 minutes',window_start=$2::timestamptz-interval '30 seconds',window_end=$2 WHERE id=$1`, marketID, end); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresAutomaticCountingSettlesVoidsAndExpires(t *testing.T) {
	s, ctx := integrationStore(t, true)
	player := integrationUser(t, s, ctx, "auto-player@example.org", RoleUser, 1000)
	stream := integrationStream(t, s, ctx)
	uncalibrated := integrationStream(t, s, ctx)
	legacy := integrationMarket(t, s, ctx, uncalibrated.ID)

	// System calibration: no signed-in actor, recorded with NULL creator/approver.
	profile, err := s.AutoCalibrate(ctx, stream.ID, automationTestPNG(t), automationTestDefinition(), "Automatic calibration from 12 tracked vehicles; line perpendicular to traffic flow.")
	if err != nil {
		t.Fatal(err)
	}
	if !profile.Automatic || profile.Width != 64 || profile.Height != 36 {
		t.Fatalf("unexpected calibrated profile %+v", profile)
	}
	streams, err := s.AutomationStreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range streams {
		if item.ID == stream.ID {
			found = item.Profile != nil && item.Profile.ID == profile.ID && item.Profile.Automatic && item.MediaPath != ""
		}
		if item.ID == uncalibrated.ID && item.Profile != nil {
			t.Fatal("uncalibrated camera reported a profile")
		}
	}
	if !found {
		t.Fatal("calibrated camera missing from automation stream list", streams)
	}
	if image, err := s.AutomationReference(ctx, stream.ID); err != nil || len(image) == 0 {
		t.Fatal("reference image unavailable", err)
	}

	won := integrationMarket(t, s, ctx, stream.ID)
	refunded := integrationMarket(t, s, ctx, stream.ID)
	expired := integrationMarket(t, s, ctx, stream.ID)
	if _, _, err := s.PlaceBet(ctx, player.ID, won.ID, BetSideOver, 100, "automatic-winning-intent"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.PlaceBet(ctx, player.ID, refunded.ID, BetSideUnder, 50, "automatic-refunded-intent"); err != nil {
		t.Fatal(err)
	}
	result := AutomaticResultInput{Outcome: "counted", VehicleCount: intPointer(12), Reason: "12 vehicles crossed the frozen line", Worker: "trafficbet-counter/test", Evidence: json.RawMessage(`{"profileId":1}`)}
	if _, _, err := s.RecordAutomaticResult(ctx, won.ID, result, time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatal("result accepted before the counting window ended", err)
	}
	for _, id := range []int64{won.ID, refunded.ID} {
		endAutomationWindow(t, s, ctx, id, time.Minute)
	}
	endAutomationWindow(t, s, ctx, legacy.ID, time.Minute)

	due, err := s.AutomationDueRounds(ctx, nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 2 || due[0].CountingRules == nil || due[0].CountingRules.Mode != "versioned" || due[0].CountingRules.Definition == nil {
		t.Fatalf("due rounds should be the two recent versioned rounds with a frozen rule (legacy excluded), got %+v", due)
	}
	// Older than the due window: not offered to the worker any more.
	endAutomationWindow(t, s, ctx, expired.ID, 16*time.Minute)
	if due, err = s.AutomationDueRounds(ctx, &stream.ID, time.Now()); err != nil || len(due) != 2 {
		t.Fatal("stale round offered to the worker", due, err)
	}

	settled, recorded, err := s.RecordAutomaticResult(ctx, won.ID, result, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != MarketSettled || settled.ActualCount == nil || *settled.ActualCount != 12 || recorded.Outcome != "counted" {
		t.Fatalf("counted round was not settled: %+v %+v", settled, recorded)
	}
	if _, _, err := s.RecordAutomaticResult(ctx, won.ID, result, time.Now()); err != nil {
		t.Fatal("identical retry must be idempotent", err)
	}
	different := result
	different.VehicleCount = intPointer(13)
	if _, _, err := s.RecordAutomaticResult(ctx, won.ID, different, time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatal("a different result for a resolved round was accepted", err)
	}

	invalid := AutomaticResultInput{Outcome: "invalid", Reason: "camera_moved: framing shifted 9% during the window", Worker: "trafficbet-counter/test"}
	voided, _, err := s.RecordAutomaticResult(ctx, refunded.ID, invalid, time.Now())
	if err != nil || voided.Status != MarketVoid || !strings.HasPrefix(voided.VoidReason, "Automatic count unavailable: camera_moved") {
		t.Fatal("invalid round was not voided with its reason", voided, err)
	}
	if _, _, err := s.RecordAutomaticResult(ctx, legacy.ID, result, time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatal("a round without a calibrated line was settled automatically", err)
	}

	resolved, err := s.ExpireAutomaticRounds(ctx, time.Now())
	if err != nil || resolved != 2 {
		t.Fatal("watchdog should void the legacy and the expired round", resolved, err)
	}
	for id, outcome := range map[int64]string{legacy.ID: "invalid", expired.ID: "expired"} {
		var status, stored string
		if err := s.pool.QueryRow(ctx, `SELECT m.status,r.outcome FROM bet_markets m JOIN automatic_round_results r ON r.market_id=m.id WHERE m.id=$1`, id).Scan(&status, &stored); err != nil || status != MarketVoid || stored != outcome {
			t.Fatal("watchdog outcome mismatch", id, status, stored, err)
		}
	}

	// 1000 - 100 - 50 + 190 (over won at 1.90) + 50 (refund) = 1090.
	var balance int64
	if err := s.pool.QueryRow(ctx, `SELECT balance_credits FROM users WHERE id=$1`, player.ID).Scan(&balance); err != nil || balance != 1090 {
		t.Fatal("ledger balance after automatic settlement and refund", balance, err)
	}
	bets, err := s.ListBetsForUser(ctx, player.ID)
	if err != nil || len(bets) != 2 {
		t.Fatal(err, bets)
	}
	for _, bet := range bets {
		if bet.MarketID == won.ID && (bet.Status != BetWon || bet.ActualCount == nil || *bet.ActualCount != 12) {
			t.Fatal("winning bet lacks status or count", bet)
		}
		if bet.MarketID == refunded.ID && (bet.Status != BetVoid || bet.VoidReason == "") {
			t.Fatal("refunded bet lacks status or reason", bet)
		}
	}
	metrics, err := s.ListStreamMetrics(ctx, stream.ID, 10)
	if err != nil || len(metrics) != 1 || metrics[0].Source != "ai" || metrics[0].VehicleCount != 12 {
		t.Fatal("automatic count was not published as an AI metric", metrics, err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE automatic_round_results SET reason='rewritten' WHERE market_id=$1`, won.ID); err == nil {
		t.Fatal("automatic results must be immutable")
	}
}

func TestPostgresAutomationPausesAndResumesUnverifiableCamera(t *testing.T) {
	s, ctx := integrationStore(t, true)
	player := integrationUser(t, s, ctx, "paused-player@example.org", RoleUser, 500)
	stream := integrationStream(t, s, ctx)
	settings := RoundScheduleSettings{Enabled: true, CountingRule: "Automatic test", Threshold: 3, OddsOver: 1.9, OddsUnder: 1.9, EntrySeconds: 30, LeadSeconds: 30, CountingSeconds: 30}
	if err := s.SaveRoundSchedule(ctx, stream.ID, settings); err != nil {
		t.Fatal(err)
	}
	open := integrationMarket(t, s, ctx, stream.ID)
	if _, _, err := s.PlaceBet(ctx, player.ID, open.ID, BetSideOver, 40, "paused-camera-intent"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAutomationAvailability(ctx, stream.ID, false, "x"); !errors.Is(err, ErrInvalid) {
		t.Fatal("pause without a reason accepted", err)
	}
	enabled, err := s.SetAutomationAvailability(ctx, stream.ID, false, "no readable capture clock in the video")
	if err != nil || enabled {
		t.Fatal("camera was not paused", enabled, err)
	}
	var status string
	var balance int64
	if err := s.pool.QueryRow(ctx, `SELECT m.status,u.balance_credits FROM bet_markets m, users u WHERE m.id=$1 AND u.id=$2`, open.ID, player.ID).Scan(&status, &balance); err != nil || status != MarketVoid || balance != 500 {
		t.Fatal("open round of a paused camera was not refunded", status, balance, err)
	}
	paused := []Stream{{ID: stream.ID}}
	if err := s.attachAutomationPauses(ctx, paused); err != nil || paused[0].AutomationPause != "no readable capture clock in the video" {
		t.Fatal("viewers are not told why rounds are paused", paused[0].AutomationPause, err)
	}
	if enabled, err = s.SetAutomationAvailability(ctx, stream.ID, true, ""); err != nil || !enabled {
		t.Fatal("automation could not resume the camera it paused", enabled, err)
	}
	if err := s.attachAutomationPauses(ctx, paused); err != nil || paused[0].AutomationPause != "" {
		t.Fatal("a resumed camera still reports a pause", paused[0].AutomationPause, err)
	}
	// An operator's own decision clears the automation note: automation never
	// re-enables a schedule that an operator switched off.
	settings.Enabled = false
	if err := s.SaveRoundSchedule(ctx, stream.ID, settings); err != nil {
		t.Fatal(err)
	}
	if enabled, err = s.SetAutomationAvailability(ctx, stream.ID, true, ""); err != nil || enabled {
		t.Fatal("automation overrode an operator-disabled schedule", enabled, err)
	}
	// Calibration retitles future rounds after the line that is frozen into them.
	if _, err := s.AutoCalibrate(ctx, stream.ID, automationTestPNG(t), automationTestDefinition(), "Automatic calibration from 12 tracked vehicles; line perpendicular to traffic flow."); err != nil {
		t.Fatal(err)
	}
	var rule string
	if err := s.pool.QueryRow(ctx, `SELECT counting_rule FROM round_schedules WHERE stream_id=$1`, stream.ID).Scan(&rule); err != nil || rule != "Vehicles crossing the AI-calibrated line · both directions" {
		t.Fatal("calibration did not retitle the schedule", rule, err)
	}
}

func TestPostgresAutomaticThresholdFollowsRecentAICounts(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	p.Threshold = 3
	p.CountingSeconds = 60
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Second)
	minute := 0
	addCounts := func(counts ...int) {
		t.Helper()
		for _, count := range counts {
			minute++
			end := now.Add(-time.Duration(minute) * time.Minute)
			// 30-second AI windows; rates are rescaled to the 60-second schedule.
			if _, err := s.pool.Exec(ctx, `INSERT INTO stream_metrics(stream_id,source,vehicle_count,interval_start,interval_end) VALUES($1,'ai',$2,$3::timestamptz-interval '30 seconds',$3)`, stream.ID, count, end); err != nil {
				t.Fatal(err)
			}
		}
	}
	threshold := func() (int, bool) {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		value, automatic, err := automaticThreshold(ctx, tx, stream.ID, p.CountingSeconds, now)
		if err != nil {
			t.Fatal(err)
		}
		return value, automatic
	}
	addCounts(7, 9, 8, 30)
	if _, automatic := threshold(); automatic {
		t.Fatal("threshold automated from fewer than five AI counts")
	}
	// Median of 7,8,8,9,9,30 per 30 s is 8.5, i.e. 17 per 60 s; the outlier does not move it.
	addCounts(8, 9)
	if value, automatic := threshold(); !automatic || value != 17 {
		t.Fatal("threshold does not follow the median AI rate", value, automatic)
	}
	if err := s.runRoundSchedule(ctx, stream.ID, now); err != nil {
		t.Fatal(err)
	}
	var published int
	if err := s.pool.QueryRow(ctx, `SELECT threshold FROM bet_markets WHERE stream_id=$1 ORDER BY id DESC LIMIT 1`, stream.ID).Scan(&published); err != nil || published != 17 {
		t.Fatal("published round ignored the automatic threshold", published, err)
	}
}

func TestStaggeredStartSpreadsCamerasOverPhases(t *testing.T) {
	cadence := time.Minute
	base := time.Date(2026, 11, 1, 18, 0, 7, 0, time.UTC)
	starts := map[int64]time.Time{}
	for _, id := range []int64{3, 1, 2} {
		s := staggeredStart(base, id, cadence)
		if s.Before(base) || s.Sub(base) >= cadence {
			t.Fatalf("camera %d: start moved outside [base, base+cadence): %v", id, s)
		}
		starts[id] = s
	}
	if starts[3].Second() != 0 || starts[1].Second() != 20 || starts[2].Second() != 40 {
		t.Fatalf("cameras should start 20 s apart: %v", starts)
	}
	// A following window one cadence later is already aligned and is not moved.
	if next := staggeredStart(starts[1].Add(cadence), 1, cadence); !next.Equal(starts[1].Add(cadence)) {
		t.Fatal("aligned chain was shifted", next)
	}
	if got := staggeredStart(base, 5, 0); !got.Equal(base) {
		t.Fatal("zero cadence must leave the start unchanged")
	}
}

func TestPostgresStaggeredSchedulesKeepEntryNotice(t *testing.T) {
	s, ctx := integrationStore(t, true)
	s.SetRoundStagger(true)
	stream := integrationStream(t, s, ctx)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Second)
	if err := s.runRoundSchedule(ctx, stream.ID, now); err != nil {
		t.Fatal(err)
	}
	markets, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 2 {
		t.Fatal(markets, err)
	}
	cadence := time.Duration(p.CountingSeconds+p.EntrySeconds) * time.Second
	for _, m := range markets {
		if m.BettingClosesAt.Sub(now) < time.Duration(p.EntrySeconds)*time.Second-time.Millisecond {
			t.Fatal("staggering shortened the entry notice", m.BettingClosesAt.Sub(now))
		}
		if !staggeredStart(m.WindowStart, stream.ID, cadence).Equal(m.WindowStart) {
			t.Fatal("window not on the camera's phase", m.WindowStart)
		}
	}
	if markets[0].WindowStart.Sub(markets[1].WindowStart) != cadence {
		t.Fatal("staggered rounds must keep the cadence", markets[0].WindowStart, markets[1].WindowStart)
	}
}

func TestPostgresAutomaticThresholdDoesNotReuseUnversionedCountsAfterLineApproval(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	now := time.Now()
	for i := 1; i <= 6; i++ {
		end := now.Add(-time.Duration(i) * time.Minute)
		if _, err := s.pool.Exec(ctx, `INSERT INTO stream_metrics(stream_id,source,vehicle_count,interval_start,interval_end) VALUES($1,'ai',100,$2::timestamptz-interval '30 seconds',$2)`, stream.ID, end); err != nil {
			t.Fatal(err)
		}
	}
	check := func(wantAutomatic bool) {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, automatic, err := automaticThreshold(ctx, tx, stream.ID, 30, now)
		if err != nil || automatic != wantAutomatic {
			t.Fatal("incomparable old counts affected new geometry", automatic, err)
		}
	}
	check(true)
	if _, err := s.AutoCalibrate(ctx, stream.ID, automationTestPNG(t), automationTestDefinition(), "New reviewed road geometry; old unversioned counts must not price it."); err != nil {
		t.Fatal(err)
	}
	check(false)
}
