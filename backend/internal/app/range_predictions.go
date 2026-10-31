package app

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

const rangePricingModel = "demo_geometric_v1"

type RangeQuote struct {
	MarketID     int64   `json:"marketId"`
	RangeMin     int     `json:"rangeMin"`
	RangeMax     int     `json:"rangeMax"`
	Odds         float64 `json:"odds"`
	PricingModel string  `json:"pricingModel"`
}

func validCountRange(minimum, maximum int) bool {
	return minimum >= 0 && maximum >= minimum && maximum <= maxVehicleCount
}

// This is an explicit simulation rule, NOT an estimate fitted to camera data.
// A geometric count model uses the round threshold + 0.5 as its mean. The
// inclusive probability q^min - q^(max+1) is evaluated with stable log/expm1.
// A 5% model margin and downward rounding set odds; [1,100] caps bound payouts.
// Very broad ranges therefore approach 1x, rather than generating free profit.
func quoteCountRange(market Market, minimum, maximum int) (RangeQuote, error) {
	if !validCountRange(minimum, maximum) || market.Threshold < 0 || market.Threshold > maxVehicleCount {
		return RangeQuote{}, fmt.Errorf("%w: enter whole-number range bounds from 0 to %d, with From no greater than To", ErrInvalid, maxVehicleCount)
	}
	mean := float64(market.Threshold) + 0.5
	logQ := math.Log1p(-1 / (mean + 1))
	probability := math.Exp(float64(minimum)*logQ) * -math.Expm1(float64(maximum-minimum+1)*logQ)
	odds := float64(100)
	if probability > 0 {
		odds = math.Max(1, math.Min(100, math.Floor(95/probability)/100))
	}
	return RangeQuote{MarketID: market.ID, RangeMin: minimum, RangeMax: maximum, Odds: odds, PricingModel: rangePricingModel}, nil
}

func rangeWins(actual, minimum, maximum int) bool { return actual >= minimum && actual <= maximum }

func (s *Store) QuoteRange(ctx context.Context, marketID int64, minimum, maximum int) (RangeQuote, error) {
	if !validCountRange(minimum, maximum) {
		return RangeQuote{}, fmt.Errorf("%w: invalid vehicle-count range", ErrInvalid)
	}
	var market Market
	var active bool
	var streamType string
	err := s.pool.QueryRow(ctx, `SELECT m.id,m.threshold,m.status,m.betting_closes_at,m.window_start,m.window_end,s.is_active,s.stream_type
 FROM bet_markets m JOIN streams s ON s.id=m.stream_id WHERE m.id=$1 AND s.retired_at IS NULL`, marketID).Scan(
		&market.ID, &market.Threshold, &market.Status, &market.BettingClosesAt, &market.WindowStart, &market.WindowEnd, &active, &streamType)
	if errors.Is(err, pgx.ErrNoRows) {
		return RangeQuote{}, ErrNotFound
	}
	if err != nil {
		return RangeQuote{}, err
	}
	if err := checkBettingOpen(market, time.Now()); err != nil {
		return RangeQuote{}, err
	}
	if !active || !supportsLivePredictions(streamType) {
		return RangeQuote{}, fmt.Errorf("%w: this camera is unavailable for predictions", ErrConflict)
	}
	return quoteCountRange(market, minimum, maximum)
}

func (api *API) handleRangeQuote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	values := r.URL.Query()
	numbers := make([]int64, 3)
	for index, key := range []string{"marketId", "from", "to"} {
		raw := values[key]
		if len(raw) != 1 || len(raw[0]) == 0 || len(raw[0]) > 18 {
			writeError(w, 400, "invalid_range", "Supply a round and whole-number From and To bounds.")
			return
		}
		for _, digit := range raw[0] {
			if digit < '0' || digit > '9' {
				writeError(w, 400, "invalid_range", "Range bounds must be nonnegative whole numbers.")
				return
			}
		}
		value, err := strconv.ParseInt(raw[0], 10, 64)
		if err != nil || value < 0 || (index == 0 && value == 0) || (index > 0 && value > maxVehicleCount) {
			writeError(w, 400, "invalid_range", "Range bounds are outside permitted limits.")
			return
		}
		numbers[index] = value
	}
	quote, err := api.store.QuoteRange(r.Context(), numbers[0], int(numbers[1]), int(numbers[2]))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, quote)
}
