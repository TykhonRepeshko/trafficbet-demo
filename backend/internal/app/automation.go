package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Automatic counting. A separate AI worker (counter/) calibrates a counting line
// per camera, counts each finished round against its frozen rule and proposes an
// outcome here. The API validates the proposal and settles (payouts) or voids
// (refunds) the round in the same transaction. A watchdog voids rounds that
// cannot be counted, so no round waits for a human.

const (
	automaticSettlementPolicy = "automatic-ai-v1"
	automaticResultGrace      = 10 * time.Minute
	automaticLegacyGrace      = 30 * time.Second
	automaticDueWindow        = 15 * time.Minute
	automationSystemWorker    = "trafficbet-api"
)

type AutomationProfile struct {
	ID          int64              `json:"id"`
	Version     int                `json:"version"`
	ReferenceID int64              `json:"referenceId"`
	Width       int                `json:"width"`
	Height      int                `json:"height"`
	Automatic   bool               `json:"automatic"`
	Definition  CountingDefinition `json:"definition"`
}

type AutomationStream struct {
	ID                int64              `json:"id"`
	Title             string             `json:"title"`
	StreamType        string             `json:"streamType"`
	MediaPath         string             `json:"mediaPath"`
	SourceFingerprint string             `json:"sourceFingerprint"`
	RoundsEnabled     bool               `json:"roundsEnabled"`
	AutomationNote    string             `json:"automationNote"`
	Profile           *AutomationProfile `json:"profile"`
}

type AutomationRound struct {
	ID            int64             `json:"id"`
	StreamID      int64             `json:"streamId"`
	WindowStart   time.Time         `json:"windowStart"`
	WindowEnd     time.Time         `json:"windowEnd"`
	Threshold     int               `json:"threshold"`
	CountingRules *CountingSnapshot `json:"countingRules"`
}

type AutomaticResultInput struct {
	Outcome      string          `json:"outcome"`
	VehicleCount *int            `json:"vehicleCount"`
	Reason       string          `json:"reason"`
	Worker       string          `json:"worker"`
	Evidence     json.RawMessage `json:"evidence"`
}

type AutomaticResult struct {
	MarketID     int64           `json:"marketId"`
	Outcome      string          `json:"outcome"`
	VehicleCount *int            `json:"vehicleCount,omitempty"`
	Reason       string          `json:"reason"`
	Worker       string          `json:"worker"`
	Evidence     json.RawMessage `json:"evidence"`
	CreatedAt    time.Time       `json:"createdAt"`
}

const marketColumns = `id,stream_id,'',title,threshold,window_start,window_end,betting_closes_at,
       odds_over,odds_under,status,actual_count,created_at,updated_at,void_reason`

func normalizeAutomaticResult(in AutomaticResultInput) (AutomaticResultInput, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	in.Worker = strings.TrimSpace(in.Worker)
	switch in.Outcome {
	case "counted":
		if in.VehicleCount == nil || *in.VehicleCount < 0 || *in.VehicleCount > maxVehicleCount {
			return in, fmt.Errorf("%w: a counted result needs a vehicle count from 0 to %d", ErrInvalid, maxVehicleCount)
		}
	case "invalid":
		if in.VehicleCount != nil {
			return in, fmt.Errorf("%w: an invalid result must not carry a vehicle count", ErrInvalid)
		}
	default:
		return in, fmt.Errorf("%w: outcome must be counted or invalid", ErrInvalid)
	}
	if !validEvidenceText(in.Reason, 3, 500) || !validEvidenceText(in.Worker, 1, 120) {
		return in, fmt.Errorf("%w: reason (3–500) and worker (1–120) must be plain text", ErrInvalid)
	}
	evidence, err := compactEvidence(in.Evidence)
	if err != nil {
		return in, err
	}
	in.Evidence = evidence
	if in.Outcome == "counted" {
		var quality struct {
			Motion *struct {
				Method               string   `json:"method"`
				WarmupFrames         int      `json:"warmupFrames"`
				RequiredWarmupFrames int      `json:"requiredWarmupFrames"`
				Issues               []string `json:"qualityIssues"`
			} `json:"motion"`
			Issues    []string          `json:"qualityIssues"`
			Crossings []json.RawMessage `json:"crossings"`
		}
		if err := json.Unmarshal(evidence, &quality); err != nil {
			return in, fmt.Errorf("%w: invalid counting evidence", ErrInvalid)
		}
		if quality.Motion != nil && quality.Motion.Method == "semantic_pixel_motion_v1" {
			if quality.Issues == nil || quality.Motion.Issues == nil || len(quality.Issues) != 0 || len(quality.Motion.Issues) != 0 ||
				quality.Motion.RequiredWarmupFrames < 1 || quality.Motion.WarmupFrames < quality.Motion.RequiredWarmupFrames ||
				quality.Crossings == nil || len(quality.Crossings) != *in.VehicleCount {
				return in, fmt.Errorf("%w: hybrid results need complete warmup, matching crossings and no quality issues", ErrInvalid)
			}
		}
	}
	return in, nil
}

func compactEvidence(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return json.RawMessage(`{}`), nil
	}
	var out bytes.Buffer
	if trimmed[0] != '{' || json.Compact(&out, trimmed) != nil || out.Len() > 64<<10 {
		return nil, fmt.Errorf("%w: evidence must be a JSON object of at most 64 KiB", ErrInvalid)
	}
	return json.RawMessage(out.Bytes()), nil
}

func automaticVoidReason(reason string) string {
	text := "Automatic count unavailable: " + reason
	if utf8.RuneCountInString(text) > 500 {
		text = string([]rune(text)[:500])
	}
	return text
}

func (s *Store) AutomationStreams(ctx context.Context) ([]AutomationStream, error) {
	rows, err := s.pool.Query(ctx, `SELECT s.id,s.title,s.stream_type,s.stream_url,COALESCE(rs.enabled,false),COALESCE(rs.automation_note,''),
 c.id,c.version,c.reference_id,r.width,r.height,c.created_by IS NULL,c.definition
 FROM streams s
 LEFT JOIN round_schedules rs ON rs.stream_id=s.id
 LEFT JOIN counting_selections a ON a.stream_id=s.id
 LEFT JOIN counting_profiles c ON c.id=a.profile_id
  AND c.source_fingerprint=encode(sha256(convert_to(s.stream_type,'UTF8') || decode('00','hex') || convert_to(s.stream_url,'UTF8')),'hex')
 LEFT JOIN counting_references r ON r.id=c.reference_id
 WHERE s.is_active AND s.retired_at IS NULL AND s.stream_type='hls'
 ORDER BY s.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	streams := []AutomationStream{}
	for rows.Next() {
		var item AutomationStream
		var streamURL string
		var profileID, referenceID *int64
		var version, width, height *int
		var automatic *bool
		var raw []byte
		if err := rows.Scan(&item.ID, &item.Title, &item.StreamType, &streamURL, &item.RoundsEnabled, &item.AutomationNote,
			&profileID, &version, &referenceID, &width, &height, &automatic, &raw); err != nil {
			return nil, err
		}
		item.MediaPath = fmt.Sprintf("/api/media/streams/%d/index.m3u8", item.ID)
		item.SourceFingerprint = sourceFingerprint(Stream{StreamType: item.StreamType, StreamURL: streamURL})
		if profileID != nil && version != nil && referenceID != nil && width != nil && height != nil {
			profile := AutomationProfile{ID: *profileID, Version: *version, ReferenceID: *referenceID, Width: *width, Height: *height, Automatic: automatic != nil && *automatic}
			if err := json.Unmarshal(raw, &profile.Definition); err != nil {
				return nil, err
			}
			item.Profile = &profile
		}
		streams = append(streams, item)
	}
	return streams, rows.Err()
}

func (s *Store) AutomationReference(ctx context.Context, streamID int64) ([]byte, error) {
	var image []byte
	err := s.pool.QueryRow(ctx, `SELECT r.image_png FROM counting_selections a
 JOIN counting_profiles c ON c.id=a.profile_id JOIN counting_references r ON r.id=c.reference_id
 JOIN streams s ON s.id=a.stream_id
 WHERE a.stream_id=$1 AND c.source_fingerprint=encode(sha256(convert_to(s.stream_type,'UTF8') || decode('00','hex') || convert_to(s.stream_url,'UTF8')),'hex')`, streamID).Scan(&image)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return image, err
}

// AutoCalibrate stores a worker-generated reference frame and counting line and
// selects it for future publications. Already published rounds keep their rule.
func (s *Store) AutoCalibrate(ctx context.Context, streamID int64, png []byte, definition CountingDefinition, note string) (AutomationProfile, error) {
	if !validCountingDefinition(definition) || !validEvidenceText(note, 20, 2000) {
		return AutomationProfile{}, fmt.Errorf("%w: a valid counting line, 20–1000 character notes and a 20–2000 character approval note are required", ErrInvalid)
	}
	stream, err := s.GetStream(ctx, streamID)
	if err != nil {
		return AutomationProfile{}, err
	}
	if !stream.IsActive || stream.StreamType != StreamTypeHLS {
		return AutomationProfile{}, fmt.Errorf("%w: automatic calibration needs an active HLS camera", ErrConflict)
	}
	reference, err := s.SaveCountingReference(ctx, streamID, png)
	if err != nil {
		return AutomationProfile{}, err
	}
	profile, err := s.SaveCountingProfile(ctx, streamID, reference.ID, definition)
	if err != nil {
		return AutomationProfile{}, err
	}
	if err := s.ApproveCountingProfile(ctx, streamID, profile.ID, note); err != nil {
		return AutomationProfile{}, err
	}
	// New round titles must describe the line that is actually frozen into them.
	if _, err := s.pool.Exec(ctx, `UPDATE round_schedules SET counting_rule=$2, updated_at=now() WHERE stream_id=$1`,
		streamID, automaticRuleTitle(definition)); err != nil {
		return AutomationProfile{}, err
	}
	return AutomationProfile{ID: profile.ID, Version: profile.Version, ReferenceID: reference.ID, Width: reference.Width, Height: reference.Height, Automatic: true, Definition: definition}, nil
}

// attachAutomationPauses tells viewers why a camera has no rounds: the note is
// the worker's public explanation (missing clock, line not yet calibrated).
func (s *Store) attachAutomationPauses(ctx context.Context, streams []Stream) error {
	if len(streams) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT stream_id, automation_note FROM round_schedules WHERE automation_note IS NOT NULL AND NOT enabled`)
	if err != nil {
		return err
	}
	defer rows.Close()
	notes := map[int64]string{}
	for rows.Next() {
		var id int64
		var note string
		if err := rows.Scan(&id, &note); err != nil {
			return err
		}
		notes[id] = note
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range streams {
		streams[i].AutomationPause = notes[streams[i].ID]
	}
	return nil
}

func automaticRuleTitle(definition CountingDefinition) string {
	directions := "both directions"
	if len(definition.Directions) == 1 {
		directions = "one direction"
	}
	return "Vehicles crossing the AI-calibrated line · " + directions
}

// SetAutomationAvailability pauses rounds for a camera the worker cannot verify
// and refunds its open rounds, or resumes a camera that automation paused.
func (s *Store) SetAutomationAvailability(ctx context.Context, streamID int64, available bool, reason string) (bool, error) {
	reason = strings.TrimSpace(reason)
	if !available && !validEvidenceText(reason, 5, 300) {
		return false, fmt.Errorf("%w: a 5–300 character reason is required", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	// Same lock order as the round publisher: source row first.
	var active bool
	if err := tx.QueryRow(ctx, `SELECT is_active FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, streamID).Scan(&active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrNotFound
		}
		return false, err
	}
	if available {
		tag, err := tx.Exec(ctx, `UPDATE round_schedules SET enabled=true,automation_note=NULL,next_run_at=now(),updated_at=now() WHERE stream_id=$1 AND automation_note IS NOT NULL`, streamID)
		if err != nil {
			return false, err
		}
		if tag.RowsAffected() > 0 {
			if err := auditTx(ctx, tx, "automation.camera_resumed", "stream", streamID, nil); err != nil {
				return false, err
			}
		}
	} else {
		tag, err := tx.Exec(ctx, `UPDATE round_schedules SET enabled=false,automation_note=$2,updated_at=now() WHERE stream_id=$1 AND (enabled OR automation_note IS NOT NULL)`, streamID, reason)
		if err != nil {
			return false, err
		}
		rows, err := tx.Query(ctx, `SELECT m.id FROM bet_markets m WHERE m.stream_id=$1 AND m.status='open'
 AND NOT EXISTS(SELECT 1 FROM automatic_round_results r WHERE r.market_id=m.id) ORDER BY m.id`, streamID)
		if err != nil {
			return false, err
		}
		ids := []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return false, err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return false, err
		}
		for _, id := range ids {
			if _, err := resolveLockedBySystem(ctx, tx, id, "invalid", "camera_unavailable: "+reason, map[string]any{"policy": automaticSettlementPolicy}); err != nil {
				return false, err
			}
		}
		if tag.RowsAffected() > 0 || len(ids) > 0 {
			if err := auditTx(ctx, tx, "automation.camera_paused", "stream", streamID, map[string]any{"reason": reason, "voidedRounds": len(ids)}); err != nil {
				return false, err
			}
		}
	}
	var enabled bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT enabled FROM round_schedules WHERE stream_id=$1),false)`, streamID).Scan(&enabled); err != nil {
		return false, err
	}
	return enabled, tx.Commit(ctx)
}

// AutomationDueRounds lists open versioned rounds without a result whose window
// starts within liveRoundLead (so the worker can count them live) and ended no
// longer than automaticDueWindow ago.
func (s *Store) AutomationDueRounds(ctx context.Context, streamID *int64, now time.Time) ([]AutomationRound, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id,m.stream_id,m.window_start,m.window_end,m.threshold,c.snapshot
 FROM bet_markets m JOIN round_counting_snapshots c ON c.market_id=m.id
 WHERE m.status='open' AND c.profile_id IS NOT NULL AND m.window_start<=$1::timestamptz+make_interval(secs=>$4) AND m.window_end>$2
 AND NOT EXISTS(SELECT 1 FROM automatic_round_results r WHERE r.market_id=m.id)
 AND ($3::bigint IS NULL OR m.stream_id=$3)
 ORDER BY m.window_end,m.id LIMIT 200`, now, now.Add(-automaticDueWindow), streamID, liveRoundLead.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rounds := []AutomationRound{}
	for rows.Next() {
		var round AutomationRound
		var raw []byte
		if err := rows.Scan(&round.ID, &round.StreamID, &round.WindowStart, &round.WindowEnd, &round.Threshold, &raw); err != nil {
			return nil, err
		}
		var snapshot CountingSnapshot
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			return nil, err
		}
		round.CountingRules = &snapshot
		rounds = append(rounds, round)
	}
	return rounds, rows.Err()
}

func loadAutomaticResult(ctx context.Context, tx pgx.Tx, marketID int64) (*AutomaticResult, error) {
	result := AutomaticResult{MarketID: marketID}
	var evidence []byte
	err := tx.QueryRow(ctx, `SELECT outcome,vehicle_count,reason,worker,evidence,created_at FROM automatic_round_results WHERE market_id=$1`, marketID).
		Scan(&result.Outcome, &result.VehicleCount, &result.Reason, &result.Worker, &evidence, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result.Evidence = evidence
	return &result, nil
}

func insertAutomaticResult(ctx context.Context, tx pgx.Tx, marketID int64, outcome string, count *int, reason, worker string, evidence json.RawMessage) (AutomaticResult, error) {
	result := AutomaticResult{MarketID: marketID, Outcome: outcome, VehicleCount: count, Reason: reason, Worker: worker, Evidence: evidence}
	err := tx.QueryRow(ctx, `INSERT INTO automatic_round_results(market_id,outcome,vehicle_count,reason,worker,evidence) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at`,
		marketID, outcome, count, reason, worker, string(evidence)).Scan(&result.CreatedAt)
	return result, err
}

// RecordAutomaticResult accepts one worker outcome per round. A counted round is
// settled with payouts; an invalid round is voided with refunds. Repeating the
// identical proposal is idempotent; a different one conflicts.
func (s *Store) RecordAutomaticResult(ctx context.Context, marketID int64, in AutomaticResultInput, now time.Time) (Market, AutomaticResult, error) {
	in, err := normalizeAutomaticResult(in)
	if err != nil {
		return Market{}, AutomaticResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Market{}, AutomaticResult{}, err
	}
	defer tx.Rollback(ctx)
	market, err := scanMarket(tx.QueryRow(ctx, `SELECT `+marketColumns+` FROM bet_markets WHERE id=$1 FOR UPDATE`, marketID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Market{}, AutomaticResult{}, ErrNotFound
	}
	if err != nil {
		return Market{}, AutomaticResult{}, err
	}
	existing, err := loadAutomaticResult(ctx, tx, marketID)
	if err != nil {
		return Market{}, AutomaticResult{}, err
	}
	if existing != nil {
		sameCount := (existing.VehicleCount == nil && in.VehicleCount == nil) || (existing.VehicleCount != nil && in.VehicleCount != nil && *existing.VehicleCount == *in.VehicleCount)
		if existing.Outcome == in.Outcome && sameCount && existing.Reason == in.Reason && existing.Worker == in.Worker {
			return market, *existing, tx.Commit(ctx)
		}
		return Market{}, AutomaticResult{}, fmt.Errorf("%w: this round already has an automatic result", ErrConflict)
	}
	if market.Status != MarketOpen {
		return Market{}, AutomaticResult{}, fmt.Errorf("%w: only an open round can receive an automatic result", ErrConflict)
	}
	if now.Before(market.WindowEnd) {
		return Market{}, AutomaticResult{}, fmt.Errorf("%w: the counting window has not ended", ErrConflict)
	}
	var profileID *int64
	if err := tx.QueryRow(ctx, `SELECT profile_id FROM round_counting_snapshots WHERE market_id=$1`, marketID).Scan(&profileID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Market{}, AutomaticResult{}, err
	}
	if in.Outcome == "counted" && profileID == nil {
		return Market{}, AutomaticResult{}, fmt.Errorf("%w: this round was published without a calibrated counting line", ErrConflict)
	}
	result, err := insertAutomaticResult(ctx, tx, marketID, in.Outcome, in.VehicleCount, in.Reason, in.Worker, in.Evidence)
	if err != nil {
		return Market{}, AutomaticResult{}, err
	}
	var updated Market
	if in.Outcome == "counted" {
		updated, err = settleLockedMarket(ctx, tx, market, *in.VehicleCount, "ai", map[string]any{"verificationPolicy": automaticSettlementPolicy, "worker": in.Worker, "profileId": *profileID})
	} else {
		updated, err = voidLockedMarket(ctx, tx, market, automaticVoidReason(in.Reason))
	}
	if err != nil {
		return Market{}, AutomaticResult{}, err
	}
	return updated, result, tx.Commit(ctx)
}

// resolveLockedBySystem voids a still-open round on behalf of the API (legacy
// rule, expired, paused camera). It locks the market row itself.
func resolveLockedBySystem(ctx context.Context, tx pgx.Tx, marketID int64, outcome, reason string, evidence map[string]any) (bool, error) {
	market, err := scanMarket(tx.QueryRow(ctx, `SELECT `+marketColumns+` FROM bet_markets WHERE id=$1 FOR UPDATE`, marketID))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	existing, err := loadAutomaticResult(ctx, tx, marketID)
	if err != nil {
		return false, err
	}
	if existing != nil || market.Status != MarketOpen {
		return false, nil
	}
	raw, err := json.Marshal(evidence)
	if err != nil {
		return false, err
	}
	if _, err := insertAutomaticResult(ctx, tx, marketID, outcome, nil, reason, automationSystemWorker, raw); err != nil {
		return false, err
	}
	if _, err := voidLockedMarket(ctx, tx, market, automaticVoidReason(reason)); err != nil {
		return false, err
	}
	return true, nil
}

// ExpireAutomaticRounds voids open rounds that will never get a worker result:
// rounds published without a calibrated line once their window ends, and
// versioned rounds still uncounted after the grace period. Bounded per call.
func (s *Store) ExpireAutomaticRounds(ctx context.Context, now time.Time) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id,c.profile_id IS NULL FROM bet_markets m
 LEFT JOIN round_counting_snapshots c ON c.market_id=m.id
 WHERE m.status='open' AND NOT EXISTS(SELECT 1 FROM automatic_round_results r WHERE r.market_id=m.id)
 AND ((c.profile_id IS NULL AND m.window_end<=$1) OR (c.profile_id IS NOT NULL AND m.window_end<=$2))
 ORDER BY m.window_end,m.id LIMIT 100`, now.Add(-automaticLegacyGrace), now.Add(-automaticResultGrace))
	if err != nil {
		return 0, err
	}
	type candidate struct {
		id     int64
		legacy bool
	}
	candidates := []candidate{}
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.legacy); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	resolved := 0
	for _, item := range candidates {
		outcome, reason := "expired", fmt.Sprintf("expired: no automatic count was produced within %d minutes of the window end", int(automaticResultGrace.Minutes()))
		if item.legacy {
			outcome, reason = "invalid", "legacy_round: published before this camera had a calibrated counting line"
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return resolved, err
		}
		done, err := resolveLockedBySystem(ctx, tx, item.id, outcome, reason, map[string]any{"policy": automaticSettlementPolicy})
		if err == nil {
			err = tx.Commit(ctx)
		}
		tx.Rollback(ctx)
		if err != nil {
			return resolved, err
		}
		if done {
			resolved++
		}
	}
	return resolved, nil
}

func (api *API) ServeAutomaticSettlement(ctx context.Context) {
	if !api.cfg.AutomaticSettlement {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		tickCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		resolved, err := api.store.ExpireAutomaticRounds(tickCtx, time.Now())
		cancel()
		if err != nil && ctx.Err() == nil {
			log.Printf("automatic settlement watchdog: %v", err)
		} else if resolved > 0 {
			log.Printf("automatic settlement watchdog: voided %d uncountable rounds", resolved)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (api *API) handleAutomation(w http.ResponseWriter, r *http.Request) {
	if !api.cfg.AutomaticSettlement {
		writeError(w, http.StatusNotFound, "automation_disabled", "Automatic counting is disabled on this server.")
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/internal/automation/"), "/"), "/")
	idAt := func(index int) (int64, bool) {
		if len(parts) <= index {
			return 0, false
		}
		id, err := parseID(parts[index])
		return id, err == nil && strconv.FormatInt(id, 10) == parts[index]
	}
	switch {
	case len(parts) == 1 && parts[0] == "streams":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		streams, err := api.store.AutomationStreams(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"streams": streams})
	case len(parts) == 3 && parts[0] == "streams" && parts[2] == "reference":
		id, ok := idAt(1)
		if !ok || r.Method != http.MethodGet {
			writeStoreError(w, ErrInvalid)
			return
		}
		image, err := api.store.AutomationReference(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(image)
	case len(parts) == 3 && parts[0] == "streams" && parts[2] == "calibration":
		id, ok := idAt(1)
		if !ok || r.Method != http.MethodPost {
			writeStoreError(w, ErrInvalid)
			return
		}
		var input struct {
			ReferencePNG string             `json:"referencePng"`
			Definition   CountingDefinition `json:"definition"`
			Note         string             `json:"note"`
		}
		if !decodeJSONLimit(w, r, &input, 2<<20) {
			return
		}
		image, err := base64.StdEncoding.DecodeString(input.ReferencePNG)
		if err != nil {
			writeStoreError(w, fmt.Errorf("%w: referencePng must be base64-encoded PNG", ErrInvalid))
			return
		}
		profile, err := api.store.AutoCalibrate(r.Context(), id, image, input.Definition, input.Note)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"profile": profile})
	case len(parts) == 3 && parts[0] == "streams" && parts[2] == "availability":
		id, ok := idAt(1)
		if !ok || r.Method != http.MethodPost {
			writeStoreError(w, ErrInvalid)
			return
		}
		var input struct {
			Available *bool  `json:"available"`
			Reason    string `json:"reason"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if input.Available == nil {
			writeStoreError(w, fmt.Errorf("%w: available is required", ErrInvalid))
			return
		}
		enabled, err := api.store.SetAutomationAvailability(r.Context(), id, *input.Available, input.Reason)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"roundsEnabled": enabled})
	case len(parts) == 1 && parts[0] == "rounds":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		query := r.URL.Query()
		var streamID *int64
		for key, values := range query {
			if key != "streamId" || len(values) != 1 {
				writeStoreError(w, ErrInvalid)
				return
			}
			id, err := parseID(values[0])
			if err != nil {
				writeStoreError(w, ErrInvalid)
				return
			}
			streamID = &id
		}
		rounds, err := api.store.AutomationDueRounds(r.Context(), streamID, time.Now())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rounds": rounds})
	case len(parts) == 3 && parts[0] == "rounds" && parts[2] == "progress":
		id, ok := idAt(1)
		if !ok || r.Method != http.MethodPost {
			writeStoreError(w, ErrInvalid)
			return
		}
		var input LiveProgressInput
		if !decodeJSONLimit(w, r, &input, 64<<10) {
			return
		}
		if err := api.store.RecordLiveProgress(r.Context(), id, input, time.Now()); err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"accepted": true})
	case len(parts) == 3 && parts[0] == "rounds" && parts[2] == "result":
		id, ok := idAt(1)
		if !ok || r.Method != http.MethodPost {
			writeStoreError(w, ErrInvalid)
			return
		}
		var input AutomaticResultInput
		if !decodeJSONLimit(w, r, &input, 128<<10) {
			return
		}
		market, result, err := api.store.RecordAutomaticResult(r.Context(), id, input, time.Now())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"market": market, "result": result})
	default:
		writeError(w, http.StatusNotFound, "not_found", "Resource was not found.")
	}
}
