package app

import (
	"errors"
	"testing"
	"time"
)

func TestRangeOptionsSplitTheModelIntoFourSimilarChoices(t *testing.T) {
	for _, threshold := range []int{0, 3, 8, 25} {
		options, err := rangeOptions(Market{ID: 1, Threshold: threshold})
		if err != nil || len(options) != 4 {
			t.Fatal(threshold, options, err)
		}
		next := 0
		for _, option := range options {
			if option.RangeMin != next || option.RangeMax < option.RangeMin || option.PricingModel != rangePricingModel {
				t.Fatalf("threshold %d: options must be contiguous from zero, got %+v", threshold, options)
			}
			next = option.RangeMax + 1
		}
		if options[3].RangeMax != maxVehicleCount {
			t.Fatalf("threshold %d: the last option must be open-ended", threshold)
		}
		if threshold >= 8 {
			for _, option := range options {
				if option.Odds < 3 || option.Odds > 4.5 {
					t.Fatalf("threshold %d: quartile options should pay similar odds, got %+v", threshold, options)
				}
			}
		}
	}
	options, _ := rangeOptions(Market{ID: 1, Threshold: 8})
	if options[0].RangeMax != 2 || options[1].RangeMax != 6 || options[2].RangeMax != 12 {
		t.Fatalf("unexpected quartile bounds for threshold 8: %+v", options)
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
