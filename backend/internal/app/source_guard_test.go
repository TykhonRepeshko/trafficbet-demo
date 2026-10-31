package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPostgresAcceptedStakesFreezeSourceUntilRefund(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "frozen-source@example.org", RoleAdmin, 1000)
	ctx = context.WithValue(ctx, userContextKey, user)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	if _, _, err := s.PlaceBet(ctx, user.ID, market.ID, BetSideOver, 100, "frozen-source-bet-intent"); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Stream){
		"source URL":                      func(item *Stream) { item.StreamURL = "/media/other/index.m3u8" },
		"format":                          func(item *Stream) { item.StreamType = StreamTypeMJPEG },
		"location":                        func(item *Stream) { item.LocationLabel = "Another intersection" },
		"city":                            func(item *Stream) { item.City = "Another city" },
		"country":                         func(item *Stream) { item.Country = "Another country" },
		"description":                     func(item *Stream) { item.Description = "Count only the other lane" },
		"counting notes":                  func(item *Stream) { item.UsageNotes = "Use a different crossing line" },
		"source operator":                 func(item *Stream) { item.SourceOwner = "Another operator" },
		"latitude":                        func(item *Stream) { value := 40.0; item.Latitude = &value },
		"longitude":                       func(item *Stream) { value := -75.0; item.Longitude = &value },
		"archive with source replacement": func(item *Stream) { item.IsActive = false; item.StreamURL = "/media/hidden-replacement/index.m3u8" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := stream
			change(&changed)
			if _, err := s.UpdateStream(ctx, changed); !errors.Is(err, ErrConflict) {
				t.Fatal("accepted stakes did not freeze the source", err)
			}
		})
	}
	stream.Title = "Corrected display title"
	stream.TermsURL = "https://example.org/terms"
	if _, err := s.UpdateStream(ctx, stream); err != nil {
		t.Fatal("non-source metadata edit should remain available", err)
	}
	stream.IsActive = false
	if _, err := s.UpdateStream(ctx, stream); err != nil {
		t.Fatal("archiving should remain available", err)
	}
	changed := stream
	changed.StreamURL = "/media/replacement/index.m3u8"
	if _, err := s.UpdateStream(ctx, changed); !errors.Is(err, ErrConflict) {
		t.Fatal("archiving bypassed the source guard", err)
	}
	if _, err := s.VoidMarket(ctx, market.ID, "Camera source must be replaced safely"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateStream(ctx, changed); err != nil {
		t.Fatal("source replacement after refunds should succeed", err)
	}
	updated, err := s.GetUserByID(ctx, user.ID)
	if err != nil || updated.BalanceCredits != 1000 {
		t.Fatal("source replacement did not preserve the refund", updated, err)
	}
}

func TestPostgresSourceUpdateWaitsForInFlightBet(t *testing.T) {
	s, ctx := integrationStore(t, true)
	user := integrationUser(t, s, ctx, "source-race@example.org", RoleAdmin, 1000)
	ctx = context.WithValue(ctx, userContextKey, user)
	stream := integrationStream(t, s, ctx)
	market := integrationMarket(t, s, ctx, stream.ID)
	operationCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	blocker, err := s.pool.Begin(operationCtx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	var blockerPID int32
	if err := blocker.QueryRow(operationCtx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(operationCtx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, user.ID); err != nil {
		t.Fatal(err)
	}
	betResult := make(chan error, 1)
	go func() {
		_, _, err := s.PlaceBet(operationCtx, user.ID, market.ID, BetSideOver, 100, "source-row-lock-race-bet")
		betResult <- err
	}()
	// Placement has already locked the source and is waiting for this user.
	betPID := waitForBlockedSourceOperation(t, s, operationCtx, blockerPID)
	changed := stream
	changed.StreamURL = "/media/racing-replacement/index.m3u8"
	updateResult := make(chan error, 1)
	go func() { _, err := s.UpdateStream(operationCtx, changed); updateResult <- err }()
	// A replacement must wait for placement, without trying to acquire its
	// already-held market row. This also catches a missing shared source lock.
	waitForBlockedSourceOperation(t, s, operationCtx, betPID)
	if err := blocker.Commit(operationCtx); err != nil {
		t.Fatal(err)
	}
	if err := <-betResult; err != nil {
		t.Fatal("in-flight bet failed", err)
	}
	if err := <-updateResult; !errors.Is(err, ErrConflict) {
		t.Fatal("replacement ignored the newly committed stake", err)
	}
	current, err := s.GetStream(ctx, stream.ID)
	if err != nil || current.StreamURL != stream.StreamURL {
		t.Fatal("race changed the source of an accepted bet", current, err)
	}
}

func waitForBlockedSourceOperation(t *testing.T, s *Store, ctx context.Context, blockerPID int32) int32 {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var pid int32
		err := s.pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1`, blockerPID).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("inspect lock waiter", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected operation did not wait for the source/user row lock")
	return 0
}
