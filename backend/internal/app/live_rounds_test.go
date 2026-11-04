package app

import (
	"errors"
	"testing"
	"time"
)

func TestRangeOptionsAreNarrowNearbyAndUseServerQuotes(t *testing.T) {
	for _, threshold := range []int{0, 3, 8, 25, 60, 90, maxVehicleCount} {
		market := Market{ID: 1, Threshold: threshold}
		options, err := rangeOptions(market)
		if err != nil || len(options) != 4 {
			t.Fatal(threshold, options, err)
		}
		contains := false
		for i, option := range options {
			if option.RangeMin < 0 || option.RangeMax > maxVehicleCount || option.RangeMax-option.RangeMin > 9 {
				t.Fatal("wide or invalid band", option)
			}
			if i > 0 && option.RangeMin != options[i-1].RangeMax+1 {
				t.Fatal("overlapping or gapped options", options)
			}
			contains = contains || (option.RangeMin <= threshold && threshold <= option.RangeMax)
			quote, _ := quoteCountRange(market, option.RangeMin, option.RangeMax)
			if option != quote || option.Odds < 1 || option.Odds > 10 {
				t.Fatal("option differs from payable server quote", option)
			}
		}
		if !contains {
			t.Fatal("reference missing from nearby bands", threshold, options)
		}
	}
	options, _ := rangeOptions(Market{ID: 1, Threshold: 80})
	if options[0].RangeMin != 60 || options[0].RangeMax != 69 || options[3].RangeMax != 99 {
		t.Fatal(options)
	}
}

func TestPostgresLiveRoundProgress(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	legacyStream := integrationStream(t, s, ctx)
	legacy := integrationMarket(t, s, ctx, legacyStream.ID)
	if _, err := s.AutoCalibrate(ctx, stream.ID, automationTestPNG(t), automationTestDefinition(), "Automatic calibration from 12 tracked vehicles; line perpendicular to traffic flow."); err != nil {
		t.Fatal(err)
	}
	round := integrationMarket(t, s, ctx, stream.ID)
	upcoming := integrationMarket(t, s, ctx, stream.ID)
	// Counting started five seconds ago and runs for another 25 seconds.
	endAutomationWindow(t, s, ctx, round.ID, -25*time.Second)
	endAutomationWindow(t, s, ctx, legacy.ID, -25*time.Second)
	due, err := s.AutomationDueRounds(ctx, &stream.ID, time.Now())
	if err != nil || len(due) != 1 || due[0].ID != round.ID {
		t.Fatal("a round being counted must be offered to the worker for live counting, later ones not", due, err)
	}
	_ = upcoming

	var start, end time.Time
	if err := s.pool.QueryRow(ctx, `SELECT window_start,window_end FROM bet_markets WHERE id=$1`, round.ID).Scan(&start, &end); err != nil {
		t.Fatal(err)
	}
	from := unixSeconds(start)
	progress := func(processed float64, ats ...float64) LiveProgressInput {
		crossings := []LiveCrossing{}
		for _, at := range ats {
			crossings = append(crossings, LiveCrossing{At: at, Direction: "A_to_B", Class: "car"})
		}
		return LiveProgressInput{VehicleCount: len(crossings), Crossings: crossings, ProcessedUntil: processed,
			Segments: []LiveSegment{{Seq: 100, StartUTC: from - 4, Duration: 12}, {Seq: 101, StartUTC: from + 8, Duration: 12}}}
	}
	if err := s.RecordLiveProgress(ctx, round.ID, progress(from+10, from+2, from+7), time.Now()); err != nil {
		t.Fatal(err)
	}
	live, err := s.GetLiveRound(ctx, round.ID)
	if err != nil || live.Live == nil || live.Live.VehicleCount != 2 || len(live.Live.Crossings) != 2 || len(live.Live.Segments) != 2 || live.Status != MarketOpen {
		t.Fatalf("live progress not returned: %+v %v", live, err)
	}
	// A late, older post never moves the visible count backwards.
	if err := s.RecordLiveProgress(ctx, round.ID, progress(from+5, from+2), time.Now()); err != nil {
		t.Fatal(err)
	}
	if live, _ = s.GetLiveRound(ctx, round.ID); live.Live.VehicleCount != 2 {
		t.Fatal("stale progress overwrote newer progress", live.Live.VehicleCount)
	}
	bad := progress(from+12, from+2)
	bad.VehicleCount = 3
	if err := s.RecordLiveProgress(ctx, round.ID, bad, time.Now()); !errors.Is(err, ErrInvalid) {
		t.Fatal("count must match the listed crossings", err)
	}
	if err := s.RecordLiveProgress(ctx, round.ID, progress(from+12, from-1), time.Now()); !errors.Is(err, ErrInvalid) {
		t.Fatal("crossings before the window are not counted", err)
	}
	if err := s.RecordLiveProgress(ctx, legacy.ID, progress(from+12), time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatal("rounds without a frozen line have no live AI count", err)
	}
	if err := s.RecordLiveProgress(ctx, upcoming.ID, progress(from+12), time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatal("progress accepted long before the round starts", err)
	}

	// Once the final result settles the round, the public view carries it and live posts stop.
	endAutomationWindow(t, s, ctx, round.ID, time.Second)
	if _, _, err := s.RecordAutomaticResult(ctx, round.ID, AutomaticResultInput{Outcome: "counted", VehicleCount: intPointer(2), Reason: "2 vehicles crossed the frozen line", Worker: "trafficbet-counter/test", Evidence: []byte(`{"profileId":1}`)}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if live, err = s.GetLiveRound(ctx, round.ID); err != nil || live.Status != MarketSettled || live.ActualCount == nil || *live.ActualCount != 2 {
		t.Fatalf("settled round not visible: %+v %v", live, err)
	}
	if err := s.RecordLiveProgress(ctx, round.ID, progress(from+20, from+2), time.Now()); !errors.Is(err, ErrConflict) {
		t.Fatal("live progress accepted after the result", err)
	}
	if _, err := s.GetLiveRound(ctx, 999999); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing round", err)
	}
}

func TestLiveHighlightValidation(t *testing.T) {
	start := time.Unix(1700000000, 0).UTC()
	end := start.Add(30 * time.Second)
	from := unixSeconds(start)
	id := int64(7)
	valid := func() LiveProgressInput {
		return LiveProgressInput{VehicleCount: 1, ProcessedUntil: from + 10,
			Crossings:  []LiveCrossing{{TrackID: &id, At: from + 4, Direction: "A_to_B", Class: "car"}},
			Segments:   []LiveSegment{{Seq: 1, StartUTC: from, Duration: 10}},
			Highlights: []LiveHighlightFrame{{At: from + 5, Boxes: []LiveVehicleBox{{TrackID: 7, X: .1, Y: .2, Width: .1, Height: .2}}}},
		}
	}
	if err := validateLiveProgress(valid(), start, end); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*LiveProgressInput){
		"unknown track":       func(p *LiveProgressInput) { p.Highlights[0].Boxes[0].TrackID = 99 },
		"before count":        func(p *LiveProgressInput) { p.Highlights[0].At = from + 3 },
		"future crossing":     func(p *LiveProgressInput) { p.Crossings[0].At = from + 11; p.Highlights = nil },
		"unprocessed frame":   func(p *LiveProgressInput) { p.Highlights[0].At = from + 11 },
		"outside image":       func(p *LiveProgressInput) { p.Highlights[0].Boxes[0].Width = 2 },
		"negative coordinate": func(p *LiveProgressInput) { p.Highlights[0].Boxes[0].X = -.1 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			p := valid()
			change(&p)
			if err := validateLiveProgress(p, start, end); !errors.Is(err, ErrInvalid) {
				t.Fatal("invalid highlights accepted", err)
			}
		})
	}
}

func TestPostgresLiveRoundDoesNotExposeDraftRules(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET status='draft' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetLiveRound(ctx, market.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("draft threshold/window exposed publicly", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET status='open' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := s.GetLiveRound(ctx, market.ID); err != nil || got.MarketID != market.ID {
		t.Fatal("published round missing", got, err)
	}
}
