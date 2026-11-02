package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Settings apply only to newly published rounds. Published terms never change.
type RoundScheduleSettings struct {
	Enabled         bool    `json:"enabled"`
	CountingRule    string  `json:"countingRule"`
	Threshold       int     `json:"threshold"`
	OddsOver        float64 `json:"oddsOver"`
	OddsUnder       float64 `json:"oddsUnder"`
	EntrySeconds    int     `json:"entrySeconds"`
	LeadSeconds     int     `json:"leadSeconds"`
	CountingSeconds int     `json:"countingSeconds"`
}

type RoundSchedule struct {
	StreamID    int64  `json:"streamId"`
	StreamTitle string `json:"streamTitle"`
	IsActive    bool   `json:"isActive"`
	Supported   bool   `json:"supported"`
	RoundScheduleSettings
	NextRunAt            *time.Time `json:"nextRunAt"`
	LastCheckedAt        *time.Time `json:"lastCheckedAt"`
	LastMarketID         *int64     `json:"lastMarketId"`
	AwaitingVerification int        `json:"awaitingVerification"`
}

type RoundScheduleSnapshot struct {
	AsOf      time.Time       `json:"asOf"`
	Schedules []RoundSchedule `json:"schedules"`
}

func defaultRoundSchedule(stream Stream) RoundScheduleSettings {
	return RoundScheduleSettings{CountingRule: strings.TrimSuffix(seedCountingTitle(stream), " · 5 min"),
		Threshold: 3, OddsOver: 1.9, OddsUnder: 1.9, EntrySeconds: 30, LeadSeconds: 30, CountingSeconds: 30}
}

func validRoundSchedule(p RoundScheduleSettings) bool {
	return utf8.ValidString(p.CountingRule) && len(p.CountingRule) >= 1 && len(p.CountingRule) <= 160 &&
		strings.TrimSpace(p.CountingRule) != "" && !strings.ContainsFunc(p.CountingRule, unicode.IsControl) &&
		p.Threshold >= 0 && p.Threshold <= maxVehicleCount && validOdds(p.OddsOver) && validOdds(p.OddsUnder) &&
		p.EntrySeconds >= 30 && p.EntrySeconds <= 3600 && p.LeadSeconds >= 30 && p.LeadSeconds <= 3600 &&
		p.CountingSeconds >= 30 && p.CountingSeconds <= 3600
}

func (s *Store) ListRoundSchedules(ctx context.Context) (RoundScheduleSnapshot, error) {
	result := RoundScheduleSnapshot{Schedules: []RoundSchedule{}}
	rows, err := s.pool.Query(ctx, `SELECT statement_timestamp(), s.id,s.title,s.is_active,s.stream_type,
        row_to_json(p), (SELECT count(*) FROM bet_markets m WHERE m.stream_id=s.id AND m.status='open' AND m.window_end<=statement_timestamp())
        FROM streams s LEFT JOIN round_schedules p ON p.stream_id=s.id
        WHERE s.retired_at IS NULL ORDER BY s.id`)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item RoundSchedule
		var streamType string
		var raw []byte
		if err := rows.Scan(&result.AsOf, &item.StreamID, &item.StreamTitle, &item.IsActive, &streamType, &raw, &item.AwaitingVerification); err != nil {
			return result, err
		}
		item.Supported = supportsLivePredictions(streamType)
		item.RoundScheduleSettings = defaultRoundSchedule(Stream{Title: item.StreamTitle})
		if len(raw) > 0 {
			var saved struct {
				Enabled         bool       `json:"enabled"`
				CountingRule    string     `json:"counting_rule"`
				Threshold       int        `json:"threshold"`
				OddsOver        float64    `json:"odds_over"`
				OddsUnder       float64    `json:"odds_under"`
				EntrySeconds    int        `json:"entry_seconds"`
				LeadSeconds     int        `json:"lead_seconds"`
				CountingSeconds int        `json:"counting_seconds"`
				NextRunAt       *time.Time `json:"next_run_at"`
				LastCheckedAt   *time.Time `json:"last_checked_at"`
				LastMarketID    *int64     `json:"last_market_id"`
			}
			if err := json.Unmarshal(raw, &saved); err != nil {
				return result, err
			}
			item.RoundScheduleSettings = RoundScheduleSettings{saved.Enabled, saved.CountingRule, saved.Threshold, saved.OddsOver, saved.OddsUnder, saved.EntrySeconds, saved.LeadSeconds, saved.CountingSeconds}
			item.NextRunAt, item.LastCheckedAt, item.LastMarketID = saved.NextRunAt, saved.LastCheckedAt, saved.LastMarketID
		}
		result.Schedules = append(result.Schedules, item)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	if result.AsOf.IsZero() {
		err = s.pool.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&result.AsOf)
	}
	return result, err
}

func (s *Store) SaveRoundSchedule(ctx context.Context, streamID int64, settings RoundScheduleSettings) error {
	if !validRoundSchedule(settings) {
		return fmt.Errorf("%w: invalid automatic round settings", ErrInvalid)
	}
	settings.CountingRule = strings.TrimSpace(settings.CountingRule)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var active bool
	var streamType string
	// All publishers and configuration changes take the source lock first.
	err = tx.QueryRow(ctx, `SELECT is_active,stream_type FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, streamID).Scan(&active, &streamType)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if settings.Enabled && (!active || !supportsLivePredictions(streamType)) {
		return fmt.Errorf("%w: enable an active continuous live camera first", ErrConflict)
	}
	_, err = tx.Exec(ctx, `INSERT INTO round_schedules(stream_id,enabled,counting_rule,threshold,odds_over,odds_under,entry_seconds,lead_seconds,counting_seconds)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(stream_id) DO UPDATE SET enabled=EXCLUDED.enabled,counting_rule=EXCLUDED.counting_rule,threshold=EXCLUDED.threshold,
        odds_over=EXCLUDED.odds_over,odds_under=EXCLUDED.odds_under,entry_seconds=EXCLUDED.entry_seconds,lead_seconds=EXCLUDED.lead_seconds,
        counting_seconds=EXCLUDED.counting_seconds,automation_note=NULL,next_run_at=CASE WHEN NOT round_schedules.enabled AND EXCLUDED.enabled THEN now() ELSE round_schedules.next_run_at END,updated_at=now()`,
		streamID, settings.Enabled, settings.CountingRule, settings.Threshold, settings.OddsOver, settings.OddsUnder, settings.EntrySeconds, settings.LeadSeconds, settings.CountingSeconds)
	if err != nil {
		return err
	}
	if err = auditTx(ctx, tx, "round_schedule.updated", "stream", streamID, map[string]any{"settings": settings}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RunRoundSchedules is safe across API replicas and restarts: a source row lock,
// the published round and its next due time are committed in one transaction.
func (s *Store) RunRoundSchedules(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT p.stream_id FROM round_schedules p JOIN streams s ON s.id=p.stream_id
        WHERE p.enabled AND s.is_active AND s.retired_at IS NULL ORDER BY p.stream_id`)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		if err = s.runRoundSchedule(ctx, id, time.Time{}); err != nil {
			failures = append(failures, fmt.Errorf("camera %d: %w", id, err))
		}
		if ctx.Err() != nil {
			break
		}
	}
	return errors.Join(failures...)
}

// now is supplied only by database time in production; tests can advance an
// isolated schema through a complete cycle without changing the machine clock.
func (s *Store) runRoundSchedule(ctx context.Context, id int64, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var active bool
	var streamType string
	err = tx.QueryRow(ctx, `SELECT is_active,stream_type FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE SKIP LOCKED`, id).Scan(&active, &streamType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !active || !supportsLivePredictions(streamType) {
		return nil
	}
	var p RoundScheduleSettings
	err = tx.QueryRow(ctx, `SELECT enabled,counting_rule,threshold,odds_over,odds_under,entry_seconds,lead_seconds,counting_seconds
        FROM round_schedules WHERE stream_id=$1 FOR UPDATE`, id).Scan(&p.Enabled, &p.CountingRule, &p.Threshold, &p.OddsOver, &p.OddsUnder, &p.EntrySeconds, &p.LeadSeconds, &p.CountingSeconds)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !p.Enabled {
		return nil
	}
	if now.IsZero() {
		if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE round_schedules SET last_checked_at=$2 WHERE stream_id=$1`, id, now); err != nil {
		return err
	}
	// next_run_at is a UI/worker hint rather than a publication barrier. Always
	// reconcile the bounded horizon so upgrades, cancellations and restarts can
	// repair a missing successor even when an older hint lies in the future.
	var accepting int
	var earliestClose, existingEnd *time.Time
	if err = tx.QueryRow(ctx, `SELECT
        count(*) FILTER (WHERE status='open' AND betting_closes_at>$2),
        min(betting_closes_at) FILTER (WHERE status='open' AND betting_closes_at>$2),
        max(window_end)
        FROM bet_markets WHERE stream_id=$1 AND status IN ('open','settled') AND window_end>$2`,
		id, now).Scan(&accepting, &earliestClose, &existingEnd); err != nil {
		return err
	}
	threshold, automatic, err := automaticThreshold(ctx, tx, id, p.CountingSeconds, now)
	if err != nil {
		return err
	}
	if !automatic {
		threshold = p.Threshold
	}
	var lastCreated *int64
	for accepting < 2 {
		// Entry notice and the safety lead run before counting. Only the pause
		// between counts affects cadence; the lead must not serialize rounds.
		// Respect every published interval, including manual ones, and leave
		// sufficient entry notice when resuming after downtime or a settings change.
		start := now.Add(time.Duration(p.EntrySeconds+p.LeadSeconds) * time.Second)
		if existingEnd != nil {
			following := existingEnd.Add(time.Duration(p.EntrySeconds) * time.Second)
			if following.After(start) {
				start = following
			}
		}
		if s.staggerRounds {
			start = staggeredStart(start, id, time.Duration(p.CountingSeconds+p.EntrySeconds)*time.Second)
		}
		closes := start.Add(-time.Duration(p.LeadSeconds) * time.Second)
		end := start.Add(time.Duration(p.CountingSeconds) * time.Second)
		var marketID int64
		err = tx.QueryRow(ctx, `INSERT INTO bet_markets(stream_id,title,threshold,window_start,window_end,odds_over,odds_under,status,betting_closes_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8) RETURNING id`, id, fmt.Sprintf("%s · %d sec", p.CountingRule, p.CountingSeconds), threshold, start, end, p.OddsOver, p.OddsUnder, closes).Scan(&marketID)
		if err != nil {
			return err
		}
		if err = auditTx(ctx, tx, "market.auto_created", "market", marketID, map[string]any{"streamId": id, "settings": p, "threshold": threshold, "automaticThreshold": automatic}); err != nil {
			return err
		}
		lastCreated = &marketID
		if earliestClose == nil || closes.Before(*earliestClose) {
			deadline := closes
			earliestClose = &deadline
		}
		accepting++
		existingEnd = &end
	}
	// Keep at least one already-published accepting successor while the
	// earlier round is locked/counting, even between the ten-second ticks.
	if _, err = tx.Exec(ctx, `UPDATE round_schedules SET next_run_at=$2,last_market_id=COALESCE($3,last_market_id) WHERE stream_id=$1`,
		id, earliestClose, lastCreated); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// roundPhases is how many phase groups cameras are spread over: with a 60 s cadence, windows of cameras in
// different groups start 20 s apart, so their AI counting does not compete for the CPU at the same moment.
const roundPhases = 3

// staggeredStart moves a window start forward (never earlier, so entry notice only grows) to the camera's
// phase slot: the next instant t with (t − phase) a multiple of the cadence. Chains then stay aligned because
// each following window starts exactly one cadence later.
func staggeredStart(start time.Time, streamID int64, cadence time.Duration) time.Time {
	if cadence <= 0 {
		return start
	}
	phase := time.Duration(((streamID%roundPhases)+roundPhases)%roundPhases) * cadence / roundPhases
	offset := (start.UnixNano() - int64(phase)) % int64(cadence)
	if offset < 0 {
		offset += int64(cadence)
	}
	if offset == 0 {
		return start
	}
	return start.Add(cadence - time.Duration(offset))
}

// automaticThreshold sets the Over/Under line (and the centre of the range odds)
// to the median of recent AI counts, rescaled to the round's counting length, so
// the reference threshold follows real traffic without an operator. With fewer
// than automaticThresholdMinRounds recent AI counts the configured value stays.
func automaticThreshold(ctx context.Context, tx pgx.Tx, streamID int64, countingSeconds int, now time.Time) (int, bool, error) {
	var rounds int
	var median *float64
	err := tx.QueryRow(ctx, `SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY rate) FROM (
        SELECT vehicle_count::float8 * $2 / EXTRACT(EPOCH FROM interval_end-interval_start) AS rate
        FROM stream_metrics WHERE stream_id=$1 AND source='ai' AND interval_end > $3::timestamptz - interval '2 hours'
        ORDER BY interval_end DESC LIMIT 30) recent`, streamID, countingSeconds, now).Scan(&rounds, &median)
	if err != nil || rounds < automaticThresholdMinRounds || median == nil {
		return 0, false, err
	}
	return min(max(int(math.Round(*median)), 0), 100000000), true, nil
}

const automaticThresholdMinRounds = 5

// The scheduler belongs to the API process, including Docker. It never settles
// predictions or guesses counts. Stale slots are skipped after downtime.
func (s *Store) ServeRoundScheduler(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		tickCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		err := s.RunRoundSchedules(tickCtx)
		cancel()
		if err != nil && ctx.Err() == nil {
			log.Printf("automatic rounds: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (api *API) handleRoundSchedules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	snapshot, err := api.store.ListRoundSchedules(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (api *API) handleRoundScheduleByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		methodNotAllowed(w)
		return
	}
	id, err := parseID(strings.TrimPrefix(r.URL.Path, "/api/admin/round-schedules/"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_stream_id", "Camera id is invalid.")
		return
	}
	var input RoundScheduleSettings
	if !decodeJSON(w, r, &input) {
		return
	}
	if err = api.store.SaveRoundSchedule(r.Context(), id, input); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}
