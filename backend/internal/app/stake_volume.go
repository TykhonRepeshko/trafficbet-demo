package app

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"
)

type StakeAmounts struct {
	PendingRangeBetCount int64 `json:"pendingRangeBetCount"`
	PendingRangeCredits  int64 `json:"pendingRangeCredits"`
	TotalBetCount        int64 `json:"totalBetCount"`
	TotalStakeCredits    int64 `json:"totalStakeCredits"`
	PendingBetCount      int64 `json:"pendingBetCount"`
	PendingStakeCredits  int64 `json:"pendingStakeCredits"`
	PendingOverBetCount  int64 `json:"pendingOverBetCount"`
	PendingOverCredits   int64 `json:"pendingOverCredits"`
	PendingUnderBetCount int64 `json:"pendingUnderBetCount"`
	PendingUnderCredits  int64 `json:"pendingUnderCredits"`
	SettledStakeCredits  int64 `json:"settledStakeCredits"`
	RefundedStakeCredits int64 `json:"refundedStakeCredits"`
}

type RoundStakeVolume struct {
	MarketID        int64     `json:"marketId"`
	Title           string    `json:"title"`
	Status          string    `json:"status"`
	Threshold       int       `json:"threshold"`
	BettingClosesAt time.Time `json:"bettingClosesAt"`
	WindowStart     time.Time `json:"windowStart"`
	WindowEnd       time.Time `json:"windowEnd"`
	StakeAmounts
}

type CameraStakeVolume struct {
	StreamID int64              `json:"streamId"`
	Title    string             `json:"title"`
	City     string             `json:"city"`
	IsActive bool               `json:"isActive"`
	Rounds   []RoundStakeVolume `json:"rounds"`
	StakeAmounts
}

type StakeVolumeSnapshot struct {
	AsOf             time.Time           `json:"asOf"`
	Totals           StakeAmounts        `json:"totals"`
	HistoricalTotals StakeAmounts        `json:"historicalTotals"`
	Cameras          []CameraStakeVolume `json:"cameras"`
}

func (total *StakeAmounts) add(value StakeAmounts) error {
	targets := []*int64{&total.TotalBetCount, &total.TotalStakeCredits, &total.PendingBetCount, &total.PendingStakeCredits,
		&total.PendingOverBetCount, &total.PendingOverCredits, &total.PendingUnderBetCount, &total.PendingUnderCredits,
		&total.SettledStakeCredits, &total.RefundedStakeCredits, &total.PendingRangeBetCount, &total.PendingRangeCredits}
	values := []int64{value.TotalBetCount, value.TotalStakeCredits, value.PendingBetCount, value.PendingStakeCredits,
		value.PendingOverBetCount, value.PendingOverCredits, value.PendingUnderBetCount, value.PendingUnderCredits,
		value.SettledStakeCredits, value.RefundedStakeCredits, value.PendingRangeBetCount, value.PendingRangeCredits}
	for i, amount := range values {
		if amount < 0 || *targets[i] > math.MaxInt64-amount {
			return fmt.Errorf("stake volume exceeds supported range")
		}
		*targets[i] += amount
	}
	return nil
}

// One statement provides a consistent snapshot of every accepted prediction,
// including history and archived sources. No member records or upstream URLs
// are exposed, and totals are independent of the prediction-history UI.
func (s *Store) StakeVolume(ctx context.Context) (StakeVolumeSnapshot, error) {
	snapshot := StakeVolumeSnapshot{AsOf: time.Now().UTC(), Cameras: []CameraStakeVolume{}}
	rows, err := s.pool.Query(ctx, `SELECT s.id,s.title,s.city,s.is_active,s.retired_at IS NOT NULL,
		COALESCE(m.id,0),COALESCE(m.title,''),COALESCE(m.status,''),COALESCE(m.threshold,0),
		COALESCE(m.betting_closes_at,'epoch'::timestamptz),COALESCE(m.window_start,'epoch'::timestamptz),COALESCE(m.window_end,'epoch'::timestamptz),
		count(b.id),COALESCE(sum(b.stake_credits),0),
		count(b.id) FILTER (WHERE b.status='pending'),COALESCE(sum(b.stake_credits) FILTER (WHERE b.status='pending'),0),
		count(b.id) FILTER (WHERE b.status='pending' AND b.side='over'),COALESCE(sum(b.stake_credits) FILTER (WHERE b.status='pending' AND b.side='over'),0),
		count(b.id) FILTER (WHERE b.status='pending' AND b.side='under'),COALESCE(sum(b.stake_credits) FILTER (WHERE b.status='pending' AND b.side='under'),0),
		COALESCE(sum(b.stake_credits) FILTER (WHERE b.status IN ('won','lost')),0),COALESCE(sum(b.stake_credits) FILTER (WHERE b.status='void'),0),
		statement_timestamp(),count(b.id) FILTER (WHERE b.status='pending' AND b.side='range'),COALESCE(sum(b.stake_credits) FILTER (WHERE b.status='pending' AND b.side='range'),0)
		FROM streams s LEFT JOIN bet_markets m ON m.stream_id=s.id LEFT JOIN bets b ON b.market_id=m.id
		GROUP BY s.id,m.id ORDER BY s.id,m.betting_closes_at,m.id`)
	if err != nil {
		return snapshot, err
	}
	defer rows.Close()
	indices := map[int64]int{}
	for rows.Next() {
		var camera CameraStakeVolume
		var retired bool
		var round RoundStakeVolume
		amounts := &round.StakeAmounts
		if err := rows.Scan(&camera.StreamID, &camera.Title, &camera.City, &camera.IsActive, &retired,
			&round.MarketID, &round.Title, &round.Status, &round.Threshold, &round.BettingClosesAt, &round.WindowStart, &round.WindowEnd,
			&amounts.TotalBetCount, &amounts.TotalStakeCredits, &amounts.PendingBetCount, &amounts.PendingStakeCredits,
			&amounts.PendingOverBetCount, &amounts.PendingOverCredits, &amounts.PendingUnderBetCount, &amounts.PendingUnderCredits,
			&amounts.SettledStakeCredits, &amounts.RefundedStakeCredits, &snapshot.AsOf, &amounts.PendingRangeBetCount, &amounts.PendingRangeCredits); err != nil {
			return snapshot, err
		}
		if err := snapshot.Totals.add(*amounts); err != nil {
			return snapshot, err
		}
		if retired {
			if err := snapshot.HistoricalTotals.add(*amounts); err != nil {
				return snapshot, err
			}
			continue
		}
		index, exists := indices[camera.StreamID]
		if !exists {
			index = len(snapshot.Cameras)
			indices[camera.StreamID] = index
			camera.Rounds = []RoundStakeVolume{}
			snapshot.Cameras = append(snapshot.Cameras, camera)
		}
		if err := snapshot.Cameras[index].StakeAmounts.add(*amounts); err != nil {
			return snapshot, err
		}
		if round.MarketID != 0 && (round.PendingBetCount > 0 || (camera.IsActive && round.Status == MarketOpen && round.BettingClosesAt.After(snapshot.AsOf))) {
			snapshot.Cameras[index].Rounds = append(snapshot.Cameras[index].Rounds, round)
		}
	}
	if err := rows.Err(); err != nil {
		return snapshot, err
	}
	sort.SliceStable(snapshot.Cameras, func(i, j int) bool {
		a, b := snapshot.Cameras[i], snapshot.Cameras[j]
		if a.PendingStakeCredits != b.PendingStakeCredits {
			return a.PendingStakeCredits > b.PendingStakeCredits
		}
		if a.IsActive != b.IsActive {
			return a.IsActive
		}
		if a.Title != b.Title {
			return a.Title < b.Title
		}
		return a.StreamID < b.StreamID
	})
	return snapshot, nil
}

func (api *API) handleStakeVolume(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	snapshot, err := api.store.StakeVolume(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "Could not load stake volume.")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}
