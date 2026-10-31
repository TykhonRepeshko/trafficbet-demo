package app

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestPostgresAutomaticRoundMinuteCadenceKeepsSafetyLead(t *testing.T) {
	for _, lead := range []int{30, 120, 600} {
		t.Run((time.Duration(lead) * time.Second).String(), func(t *testing.T) {
			s, ctx := integrationStore(t, true)
			stream := integrationStream(t, s, ctx)
			p := defaultRoundSchedule(stream)
			p.Enabled, p.LeadSeconds = true, lead
			if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
				t.Fatal(err)
			}
			now := time.Now().Add(time.Second).Truncate(time.Microsecond)
			published := map[int64]string{}
			for cycle := 0; cycle < 8; cycle++ {
				if err := s.runRoundSchedule(ctx, stream.ID, now); err != nil {
					t.Fatal(err)
				}
				markets, err := s.ListMarkets(ctx, &stream.ID, "")
				if err != nil || len(markets) != cycle+2 {
					t.Fatal("queue did not refill exactly once per deadline", len(markets), err)
				}
				accepting := 0
				var nextClose time.Time
				var nearestStart time.Time
				for i, market := range markets {
					if market.WindowStart.Sub(market.BettingClosesAt) != time.Duration(lead)*time.Second || market.WindowEnd.Sub(market.WindowStart) != 30*time.Second {
						t.Fatal("lead or count duration changed", market)
					}
					if i > 0 && market.WindowStart.Sub(markets[i-1].WindowStart) != -time.Minute {
						t.Fatal("counting starts are not one minute apart", markets)
					}
					terms, err := json.Marshal(market)
					if err != nil {
						t.Fatal(err)
					}
					if previous, exists := published[market.ID]; exists {
						if previous != string(terms) {
							t.Fatal("published terms changed", market.ID)
						}
					} else if market.BettingClosesAt.Sub(now) < 30*time.Second {
						t.Fatal("new round published without minimum entry notice", market)
					}
					published[market.ID] = string(terms)
					if market.BettingClosesAt.After(now) {
						accepting++
						if nearestStart.IsZero() || market.WindowStart.Before(nearestStart) {
							nearestStart = market.WindowStart
						}
						if nextClose.IsZero() || market.BettingClosesAt.Before(nextClose) {
							nextClose = market.BettingClosesAt
						}
					}
				}
				if accepting != 2 {
					t.Fatal("two accepting future rounds were not maintained", accepting)
				}
				if lead == 30 && (nearestStart.Sub(now) < 30*time.Second || nearestStart.Sub(now) > 90*time.Second) {
					t.Fatal("nearest accepting count is outside the short waiting window", nearestStart.Sub(now))
				}
				now = nextClose
			}
		})
	}
}

func TestPostgresContinuousSuccessorAcceptsRangeWhileCurrentIsLocked(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	member := integrationUser(t, s, ctx, "continuous-range@example.org", RoleUser, 1000)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	if err := s.RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	markets, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 2 {
		t.Fatal("bounded accepting horizon missing", markets, err)
	}
	current, next := markets[1], markets[0]
	// Only this isolated fixture's entry cutoff is advanced. Counting times and
	// the already published successor remain unchanged, with their safety lead.
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '1 second' WHERE id=$1`, current.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.PlaceBet(ctx, member.ID, current.ID, BetSideOver, 100, "continuous-late-current-intent"); !errors.Is(err, ErrConflict) {
		t.Fatal("locked current accepted a late stake", err)
	}
	if _, err := s.QuoteRange(ctx, current.ID, 12, 25); !errors.Is(err, ErrConflict) {
		t.Fatal("locked current returned fresh quote", err)
	}
	quote, err := s.QuoteRange(ctx, next.ID, 12, 25)
	if err != nil {
		t.Fatal("successor is not accepting while current is locked", err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	ids := make(chan int64, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bet, _, err := s.placePrediction(ctx, member.ID, next.ID, BetSideRange, 100, "continuous-successor-intent", &quote)
			errs <- err
			ids <- bet.ID
		}()
	}
	wg.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var betID int64
	for id := range ids {
		if betID == 0 {
			betID = id
		}
		if id != betID {
			t.Fatal("duplicate successor stake")
		}
	}
	got, _, err := s.GetUserByEmail(ctx, member.Email)
	if err != nil || got.BalanceCredits != 900 {
		t.Fatal("successor stake was not debited exactly once", got, err)
	}
	for i := 0; i < 5; i++ {
		if err := s.RunRoundSchedules(ctx); err != nil {
			t.Fatal(err)
		}
	}
	markets, err = s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 3 {
		t.Fatal("unbounded horizon or missing replenishment", len(markets), err)
	}
	for i := 1; i < len(markets); i++ {
		if markets[i-1].WindowStart.Before(markets[i].WindowEnd) {
			t.Fatal("counting windows overlap", markets)
		}
	}
	history, err := s.ListBetsForUser(ctx, member.ID)
	if err != nil || len(history) != 1 || history[0].MarketID != next.ID || history[0].RangeMin == nil || *history[0].RangeMin != 12 || history[0].RangeMax == nil || *history[0].RangeMax != 25 {
		t.Fatal("prediction was moved or lost its bounds", history, err)
	}
	if _, err := s.VoidMarket(ctx, next.ID, "Synthetic successor refund verification"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VoidMarket(ctx, next.ID, "Synthetic successor refund verification"); err != nil {
		t.Fatal(err)
	}
	got, _, err = s.GetUserByEmail(ctx, member.Email)
	if err != nil || got.BalanceCredits != 1000 {
		t.Fatal("successor cancellation did not refund once", got, err)
	}
	if err := s.RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	var accepting int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM bet_markets WHERE stream_id=$1 AND status='open' AND betting_closes_at>clock_timestamp()`, stream.ID).Scan(&accepting); err != nil || accepting != 2 {
		t.Fatal("cancelled successor was not repaired", accepting, err)
	}
}

func TestPostgresContinuousHorizonRollsBackBothRoundsOnSecondAuditFailure(t *testing.T) {
	s, ctx := integrationStore(t, true)
	stream := integrationStream(t, s, ctx)
	p := defaultRoundSchedule(stream)
	p.Enabled = true
	if err := s.SaveRoundSchedule(ctx, stream.ID, p); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `CREATE FUNCTION fail_second_automatic_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='market.auto_created' AND EXISTS(SELECT 1 FROM audit_events WHERE action='market.auto_created') THEN RAISE EXCEPTION 'synthetic second audit failure'; END IF; RETURN NEW; END; $$;
 CREATE TRIGGER fail_second_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_second_automatic_audit()`); err != nil {
		t.Fatal(err)
	}
	if err := s.RunRoundSchedules(ctx); err == nil {
		t.Fatal("second audit failure was ignored")
	}
	markets, err := s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 0 {
		t.Fatal("partial horizon survived rollback", markets, err)
	}
	snapshot, err := s.ListRoundSchedules(ctx)
	if err != nil || snapshot.Schedules[0].LastMarketID != nil || snapshot.Schedules[0].LastCheckedAt != nil {
		t.Fatal("failed publication advanced schedule", snapshot, err)
	}
	if _, err := s.pool.Exec(ctx, `DROP TRIGGER fail_second_audit ON audit_events`); err != nil {
		t.Fatal(err)
	}
	if err := s.RunRoundSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	markets, err = s.ListMarkets(ctx, &stream.ID, "")
	if err != nil || len(markets) != 2 {
		t.Fatal("publication did not recover", markets, err)
	}
}
