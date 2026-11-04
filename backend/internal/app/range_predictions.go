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

const rangePricingModel = "demo_normal_v2"

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

// Explicit demo pricing: a discretized normal count distribution centred on the
// published threshold, truncated to the accepted count domain. This is not a
// camera forecast. A 15% margin, downward rounding and a 10x cap bound returns.
func quoteCountRange(market Market, minimum, maximum int) (RangeQuote, error) {
	if !validCountRange(minimum, maximum) || market.Threshold < 0 || market.Threshold > maxVehicleCount {
		return RangeQuote{}, fmt.Errorf("%w: enter whole-number range bounds from 0 to %d, with From no greater than To", ErrInvalid, maxVehicleCount)
	}
	mean := float64(market.Threshold) + 0.5
	scale := math.Max(3, math.Sqrt(mean)) * math.Sqrt2
	mass := func(lo, hi float64) float64 {
		return 0.5 * (math.Erfc((lo-mean)/scale) - math.Erfc((hi-mean)/scale))
	}
	probability := mass(float64(minimum)-0.5, float64(maximum)+0.5) / mass(-0.5, float64(maxVehicleCount)+0.5)
	odds := float64(10)
	if probability > 0 {
		odds = math.Max(1, math.Min(10, math.Floor(85/probability)/100))
	}
	return RangeQuote{MarketID: market.ID, RangeMin: minimum, RangeMax: maximum, Odds: odds, PricingModel: rangePricingModel}, nil
}

func rangeWins(actual, minimum, maximum int) bool { return actual >= minimum && actual <= maximum }

func (s *Store) QuoteRange(ctx context.Context, marketID int64, minimum, maximum int) (RangeQuote, error) {
	if !validCountRange(minimum, maximum) {
		return RangeQuote{}, fmt.Errorf("%w: invalid vehicle-count range", ErrInvalid)
	}
	market, err := s.quotableMarket(ctx, marketID)
	if err != nil {
		return RangeQuote{}, err
	}
	return quoteCountRange(market, minimum, maximum)
}

// Four nearby finite bands, each containing at most ten integer counts. Quiet
// cameras get smaller bands. Custom ranges still cover counts outside these choices.
func rangeOptions(market Market) ([]RangeQuote, error) {
	width := min(10, max(2, (market.Threshold+5)/6))
	lower := max(0, (market.Threshold/width-2)*width)
	lower = min(lower, maxVehicleCount-4*width+1)
	options := make([]RangeQuote, 0, 4)
	for i := 0; i < 4; i++ {
		upper := lower + width - 1
		quote, err := quoteCountRange(market, lower, upper)
		if err != nil {
			return nil, err
		}
		options = append(options, quote)
		lower = upper + 1
	}
	return options, nil
}

func (s *Store) RangeOptions(ctx context.Context, marketID int64) ([]RangeQuote, error) {
	market, err := s.quotableMarket(ctx, marketID)
	if err != nil {
		return nil, err
	}
	return rangeOptions(market)
}

// quotableMarket loads a round that is still accepting predictions on an active live camera.
func (s *Store) quotableMarket(ctx context.Context, marketID int64) (Market, error) {
	var market Market
	var active bool
	var streamType string
	err := s.pool.QueryRow(ctx, `SELECT m.id,m.threshold,m.status,m.betting_closes_at,m.window_start,m.window_end,s.is_active,s.stream_type
 FROM bet_markets m JOIN streams s ON s.id=m.stream_id WHERE m.id=$1 AND s.retired_at IS NULL`, marketID).Scan(
		&market.ID, &market.Threshold, &market.Status, &market.BettingClosesAt, &market.WindowStart, &market.WindowEnd, &active, &streamType)
	if errors.Is(err, pgx.ErrNoRows) {
		return Market{}, ErrNotFound
	}
	if err != nil {
		return Market{}, err
	}
	if err := checkBettingOpen(market, time.Now()); err != nil {
		return Market{}, err
	}
	if !active || !supportsLivePredictions(streamType) {
		return Market{}, fmt.Errorf("%w: this camera is unavailable for predictions", ErrConflict)
	}
	return market, nil
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

func (api *API) handleRangeOptions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	values := r.URL.Query()
	raw := values["marketId"]
	if len(values) != 1 || len(raw) != 1 || len(raw[0]) == 0 || len(raw[0]) > 18 {
		writeError(w, 400, "invalid_round", "Supply one round id.")
		return
	}
	id, err := parseID(raw[0])
	if err != nil || strconv.FormatInt(id, 10) != raw[0] {
		writeError(w, 400, "invalid_round", "Round id is invalid.")
		return
	}
	options, err := api.store.RangeOptions(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"options": options})
}
