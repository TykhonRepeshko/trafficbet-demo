package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Live progress lets a viewer watch the AI count a round in real time. It is
// display data only: settlement still waits for the worker's final, gated result.

type LiveCrossing struct {
	TrackID   *int64  `json:"trackId,omitempty"`
	At        float64 `json:"at"` // capture UTC, Unix seconds
	Direction string  `json:"direction"`
	Class     string  `json:"class"`
}

// LiveSegment maps an HLS media sequence number to its capture UTC so a player
// showing that segment can tell which crossings have already happened on screen.
type LiveSegment struct {
	Seq      int64   `json:"seq"`
	StartUTC float64 `json:"startUtc"`
	Duration float64 `json:"duration"`
}

type LiveVehicleBox struct {
	TrackID int64   `json:"trackId"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Width   float64 `json:"width"`
	Height  float64 `json:"height"`
}

type LiveHighlightFrame struct {
	At    float64          `json:"at"`
	Boxes []LiveVehicleBox `json:"boxes"`
}

type LiveProgressInput struct {
	Highlights     []LiveHighlightFrame `json:"highlights,omitempty"`
	VehicleCount   int                  `json:"vehicleCount"`
	Crossings      []LiveCrossing       `json:"crossings"`
	Segments       []LiveSegment        `json:"segments"`
	ProcessedUntil float64              `json:"processedUntil"`
}

type LiveProgress struct {
	LiveProgressInput
	UpdatedAt time.Time `json:"updatedAt"`
}

type LiveRound struct {
	MarketID    int64         `json:"marketId"`
	StreamID    int64         `json:"streamId"`
	Status      string        `json:"status"`
	Threshold   int           `json:"threshold"`
	WindowStart time.Time     `json:"windowStart"`
	WindowEnd   time.Time     `json:"windowEnd"`
	ActualCount *int          `json:"actualCount,omitempty"`
	VoidReason  string        `json:"voidReason,omitempty"`
	Live        *LiveProgress `json:"live"`
}

const (
	liveRoundLead      = 30 * time.Second // worker may start tracking just before the window
	liveMaxCrossings   = 500
	liveMaxSegments    = 40
	liveClockTolerance = 15 * time.Minute
)

func unixSeconds(t time.Time) float64 { return float64(t.UnixNano()) / 1e9 }

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func validateLiveProgress(input LiveProgressInput, start, end time.Time) error {
	invalid := func(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }
	if len(input.Crossings) > liveMaxCrossings || len(input.Segments) == 0 || len(input.Segments) > liveMaxSegments {
		return invalid("live progress needs 1–40 segments and at most 500 crossings")
	}
	if input.VehicleCount != len(input.Crossings) {
		return invalid("vehicleCount must equal the number of counted crossings")
	}
	from, to := unixSeconds(start), unixSeconds(end)
	tolerance := liveClockTolerance.Seconds()
	if !finite(input.ProcessedUntil) || input.ProcessedUntil < from-tolerance || input.ProcessedUntil > to+tolerance {
		return invalid("processedUntil is outside the round")
	}
	for _, crossing := range input.Crossings {
		if !finite(crossing.At) || crossing.At < from || crossing.At >= to ||
			(crossing.Direction != "A_to_B" && crossing.Direction != "B_to_A") || !validLiveClass(crossing.Class) {
			return invalid("each crossing needs a time inside the counting window, a direction and a vehicle class")
		}
	}
	if len(input.Highlights) > 80 {
		return invalid("at most 80 highlight frames are accepted")
	}
	countedTracks := make(map[int64]float64)
	for _, crossing := range input.Crossings {
		if crossing.TrackID == nil {
			continue
		}
		if *crossing.TrackID < 0 || *crossing.TrackID > 9007199254740991 {
			return invalid("invalid crossing track id")
		}
		if _, exists := countedTracks[*crossing.TrackID]; exists {
			return invalid("duplicate crossing track id")
		}
		countedTracks[*crossing.TrackID] = crossing.At
	}
	boxes, previousFrame := 0, from-1
	for _, frame := range input.Highlights {
		if !finite(frame.At) || frame.At < from || frame.At >= to || frame.At <= previousFrame || frame.At > input.ProcessedUntil+0.001 {
			return invalid("highlight frames need increasing processed times inside the round")
		}
		previousFrame = frame.At
		seen := make(map[int64]bool)
		for _, box := range frame.Boxes {
			at, counted := countedTracks[box.TrackID]
			if !counted || at > frame.At+0.001 || seen[box.TrackID] || !finite(box.X) || !finite(box.Y) || !finite(box.Width) || !finite(box.Height) ||
				box.X < 0 || box.Y < 0 || box.Width <= 0 || box.Height <= 0 || box.X+box.Width > 1.001 || box.Y+box.Height > 1.001 {
				return invalid("highlights must be bounded boxes of vehicles already counted")
			}
			seen[box.TrackID] = true
			boxes++
		}
	}
	if boxes > 640 {
		return invalid("at most 640 highlight boxes are accepted")
	}
	previous := int64(-1)
	for _, segment := range input.Segments {
		if segment.Seq <= previous || !finite(segment.StartUTC) || !finite(segment.Duration) || segment.Duration <= 0 || segment.Duration > 60 ||
			segment.StartUTC < from-tolerance || segment.StartUTC > to+tolerance {
			return invalid("segments need increasing sequence numbers, capture times near the round and durations up to 60 s")
		}
		previous = segment.Seq
	}
	return nil
}

func validLiveClass(class string) bool {
	switch class {
	case "car", "van", "bus", "truck", "motorcycle", "vehicle":
		return true
	}
	return false
}

// RecordLiveProgress stores the worker's running count for an open, versioned
// round between just before its window and the automatic settlement deadline.
// Out-of-order posts never move the progress backwards.
func (s *Store) RecordLiveProgress(ctx context.Context, marketID int64, input LiveProgressInput, now time.Time) error {
	var status string
	var start, end time.Time
	var versioned, resolved bool
	err := s.pool.QueryRow(ctx, `SELECT m.status,m.window_start,m.window_end,c.profile_id IS NOT NULL,
 EXISTS(SELECT 1 FROM automatic_round_results r WHERE r.market_id=m.id)
 FROM bet_markets m LEFT JOIN round_counting_snapshots c ON c.market_id=m.id WHERE m.id=$1`, marketID).
		Scan(&status, &start, &end, &versioned, &resolved)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status != MarketOpen || !versioned || resolved || now.Before(start.Add(-liveRoundLead)) || now.After(end.Add(automaticResultGrace)) {
		return fmt.Errorf("%w: live progress is accepted only while an open versioned round is being counted", ErrConflict)
	}
	if err := validateLiveProgress(input, start, end); err != nil {
		return err
	}
	progress, err := json.Marshal(map[string]any{"crossings": input.Crossings, "segments": input.Segments, "highlights": input.Highlights})
	if err != nil {
		return err
	}
	if len(progress) > 65536 {
		return fmt.Errorf("%w: live progress exceeds storage limit", ErrInvalid)
	}
	processed := time.Unix(0, int64(input.ProcessedUntil*1e9)).UTC()
	_, err = s.pool.Exec(ctx, `INSERT INTO round_live_counts(market_id,vehicle_count,progress,processed_until) VALUES($1,$2,$3,$4)
 ON CONFLICT (market_id) DO UPDATE SET vehicle_count=EXCLUDED.vehicle_count,progress=EXCLUDED.progress,processed_until=EXCLUDED.processed_until,updated_at=now()
 WHERE round_live_counts.processed_until<=EXCLUDED.processed_until`, marketID, input.VehicleCount, progress, processed)
	return err
}

func (s *Store) GetLiveRound(ctx context.Context, marketID int64) (LiveRound, error) {
	round := LiveRound{MarketID: marketID}
	var count *int
	var progress []byte
	var processed, updated *time.Time
	var voidReason *string
	err := s.pool.QueryRow(ctx, `SELECT m.stream_id,m.status,m.threshold,m.window_start,m.window_end,m.actual_count,m.void_reason,
 l.vehicle_count,l.progress,l.processed_until,l.updated_at
 FROM bet_markets m JOIN streams s ON s.id=m.stream_id AND s.retired_at IS NULL
 LEFT JOIN round_live_counts l ON l.market_id=m.id WHERE m.id=$1`, marketID).
		Scan(&round.StreamID, &round.Status, &round.Threshold, &round.WindowStart, &round.WindowEnd, &round.ActualCount, &voidReason,
			&count, &progress, &processed, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return LiveRound{}, ErrNotFound
	}
	if err != nil {
		return LiveRound{}, err
	}
	if voidReason != nil {
		round.VoidReason = *voidReason
	}
	if count != nil && processed != nil && updated != nil {
		live := LiveProgress{UpdatedAt: *updated}
		if err := json.Unmarshal(progress, &live.LiveProgressInput); err != nil {
			return LiveRound{}, err
		}
		live.VehicleCount, live.ProcessedUntil = *count, unixSeconds(*processed)
		round.Live = &live
	}
	return round, nil
}

// handleMarketByID serves public, read-only round views: /api/markets/{id}/live.
func (api *API) handleMarketByID(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/markets/"), "/"), "/")
	if len(parts) != 2 || parts[1] != "live" {
		writeError(w, http.StatusNotFound, "not_found", "Resource was not found.")
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	id, err := parseID(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_market_id", "Round id is invalid.")
		return
	}
	round, err := api.store.GetLiveRound(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, round)
}
