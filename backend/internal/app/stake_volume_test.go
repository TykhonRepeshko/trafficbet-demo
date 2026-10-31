package app

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestStakeVolumeRejectsIntegerOverflow(t *testing.T) {
	total := StakeAmounts{PendingStakeCredits: math.MaxInt64}
	if total.add(StakeAmounts{PendingStakeCredits: 1}) == nil {
		t.Fatal("overflow accepted")
	}
	if (&StakeAmounts{}).add(StakeAmounts{TotalStakeCredits: -1}) == nil {
		t.Fatal("negative volume accepted")
	}
}

func TestPostgresStakeVolumeEmptySnapshot(t *testing.T) {
	s, ctx := integrationStore(t, true)
	snapshot, err := s.StakeVolume(ctx)
	if err != nil || snapshot.Cameras == nil || len(snapshot.Cameras) != 0 || snapshot.Totals != (StakeAmounts{}) || snapshot.AsOf.IsZero() {
		t.Fatal("empty snapshot is not a valid zero state", snapshot, err)
	}
}

func TestPostgresStakeVolumeFullHistoryAndLifecycle(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "volume-admin@example.org", RoleAdmin, 0)
	member := integrationUser(t, s, ctx, "volume-member@example.org", RoleUser, 100000)
	a, b, c, d := integrationStream(t, s, ctx), integrationStream(t, s, ctx), integrationStream(t, s, ctx), integrationStream(t, s, ctx)
	liveA, settledA := integrationMarket(t, s, ctx, a.ID), integrationMarket(t, s, ctx, a.ID)
	voidB, lockedB := integrationMarket(t, s, ctx, b.ID), integrationMarket(t, s, ctx, b.ID)
	zeroC := integrationMarket(t, s, ctx, c.ID)
	place := func(market int64, side string, stake int64, key string) Bet {
		t.Helper()
		bet, _, err := s.PlaceBet(ctx, member.ID, market, side, stake, key)
		if err != nil {
			t.Fatal(err)
		}
		return bet
	}
	first := place(liveA.ID, BetSideOver, 100, "volume-first-intent")
	if retry := place(liveA.ID, BetSideOver, 100, "volume-first-intent"); retry.ID != first.ID {
		t.Fatal("retry created another prediction")
	}
	place(liveA.ID, BetSideUnder, 200, "volume-second-intent")
	place(settledA.ID, BetSideOver, 50, "volume-settled-intent")
	place(voidB.ID, BetSideUnder, 70, "volume-voided-intent")
	place(lockedB.ID, BetSideOver, 400, "volume-archived-intent")
	for i := 0; i < 250; i++ {
		place(liveA.ID, BetSideOver, 1, fmt.Sprintf("volume-small-intent-%04d", i))
	}
	for _, id := range []int64{settledA.ID, lockedB.ID} {
		if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.SettleMarket(ctx, settledA.ID, 11, verifiedSettlementFixture()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VoidMarket(ctx, voidB.ID, "Synthetic volume fixture cancellation"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteStream(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteStream(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.StakeVolume(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := StakeAmounts{TotalBetCount: 255, TotalStakeCredits: 1070, PendingBetCount: 253, PendingStakeCredits: 950,
		PendingOverBetCount: 252, PendingOverCredits: 750, PendingUnderBetCount: 1, PendingUnderCredits: 200, SettledStakeCredits: 50, RefundedStakeCredits: 70}
	if snapshot.Totals != want {
		t.Fatal("aggregate is truncated, duplicated or mixes historical stakes into pending volume", snapshot.Totals, want)
	}
	if len(snapshot.Cameras) != 4 || snapshot.Cameras[0].StreamID != a.ID {
		t.Fatal("missing cameras or incorrect volume ordering", snapshot.Cameras)
	}
	cameras := map[int64]CameraStakeVolume{}
	for _, camera := range snapshot.Cameras {
		cameras[camera.StreamID] = camera
		if camera.PendingStakeCredits != camera.PendingOverCredits+camera.PendingUnderCredits || camera.TotalStakeCredits != camera.PendingStakeCredits+camera.SettledStakeCredits+camera.RefundedStakeCredits {
			t.Fatal("camera totals do not reconcile", camera)
		}
	}
	if cameras[a.ID].TotalStakeCredits != 600 || cameras[a.ID].PendingStakeCredits != 550 || len(cameras[a.ID].Rounds) != 1 || cameras[a.ID].Rounds[0].MarketID != liveA.ID {
		t.Fatal("active camera grouping failed", cameras[a.ID])
	}
	if cameras[b.ID].IsActive || cameras[b.ID].PendingStakeCredits != 400 || cameras[b.ID].RefundedStakeCredits != 70 || len(cameras[b.ID].Rounds) != 1 || cameras[b.ID].Rounds[0].MarketID != lockedB.ID {
		t.Fatal("archived or deadline-closed stakes disappeared", cameras[b.ID])
	}
	if cameras[c.ID].TotalStakeCredits != 0 || len(cameras[c.ID].Rounds) != 1 || cameras[c.ID].Rounds[0].MarketID != zeroC.ID || len(cameras[d.ID].Rounds) != 0 {
		t.Fatal("zero-stake camera/round handling failed")
	}

	adminToken, _ := newSessionToken()
	memberToken, _ := newSessionToken()
	for _, session := range []struct {
		user  int64
		token string
	}{{admin.ID, adminToken}, {member.ID, memberToken}} {
		if err := s.CreateSession(ctx, session.user, sessionHash(session.token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
	}
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	for _, test := range []struct {
		cookie *http.Cookie
		status int
	}{{nil, 401}, {&http.Cookie{Name: sessionCookieName, Value: memberToken}, 403}, {&http.Cookie{Name: sessionCookieName, Value: adminToken}, 200}} {
		w := accountTestRequest(handler, "GET", "/api/admin/stake-volume", "", test.cookie)
		if w.Code != test.status {
			t.Fatal("volume authorization failed", w.Code, test.status)
		}
		if w.Code == 200 {
			var response StakeVolumeSnapshot
			if json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Totals != want {
				t.Fatal("HTTP volume differs from database snapshot")
			}
			for _, secret := range []string{"password", "userId", "email", "streamUrl", "token"} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatal("volume leaked member/source details", secret)
				}
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("private volume snapshot is cacheable")
			}
		}
	}
	if w := accountTestRequest(handler, "POST", "/api/admin/stake-volume", `{}`, &http.Cookie{Name: sessionCookieName, Value: adminToken}); w.Code != 405 {
		t.Fatal("volume endpoint accepts mutations", w.Code)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, liveA.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleMarket(ctx, liveA.ID, 5, verifiedSettlementFixture()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.VoidMarket(ctx, lockedB.ID, "Synthetic archived-camera refund"); err != nil {
		t.Fatal(err)
	}
	updated, err := s.StakeVolume(ctx)
	if err != nil || updated.Totals.TotalStakeCredits != 1070 || updated.Totals.PendingStakeCredits != 0 || updated.Totals.SettledStakeCredits != 600 || updated.Totals.RefundedStakeCredits != 470 {
		t.Fatal("settlement/refund did not update volume correctly", updated.Totals, err)
	}
}
