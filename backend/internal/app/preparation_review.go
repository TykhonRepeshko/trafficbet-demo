package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

func validEvidenceText(value string, min, max int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(strings.TrimSpace(value)) >= min && utf8.RuneCountInString(value) <= max && !strings.ContainsFunc(value, unicode.IsControl)
}

type RoundReview struct {
	ID            int64                  `json:"id"`
	MarketID      int64                  `json:"marketId"`
	Outcome       string                 `json:"outcome"`
	ProposedCount *int                   `json:"proposedCount"`
	Verification  SettlementVerification `json:"verification"`
	EvidenceNote  string                 `json:"evidenceNote"`
	EvidenceID    *int64                 `json:"evidenceId,omitempty"`
	CreatedBy     int64                  `json:"createdBy"`
	CreatedAt     time.Time              `json:"createdAt"`
}
type RoundReviewDetail struct {
	Market       Market              `json:"market"`
	Snapshot     CountingSnapshot    `json:"snapshot"`
	Reviews      []RoundReview       `json:"reviews"`
	Observations []SourceObservation `json:"observations"`
}

func (s *Store) RoundReviewDetail(ctx context.Context, id int64) (RoundReviewDetail, error) {
	result := RoundReviewDetail{Reviews: []RoundReview{}, Observations: []SourceObservation{}}
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT m.id,m.stream_id,s.title,m.title,m.threshold,m.window_start,m.window_end,m.betting_closes_at,m.odds_over,m.odds_under,m.status,m.actual_count,m.created_at,m.updated_at,m.void_reason,c.snapshot
 FROM bet_markets m JOIN streams s ON s.id=m.stream_id JOIN round_counting_snapshots c ON c.market_id=m.id WHERE m.id=$1`, id).Scan(&result.Market.ID, &result.Market.StreamID, &result.Market.StreamTitle, &result.Market.Title, &result.Market.Threshold, &result.Market.WindowStart, &result.Market.WindowEnd, &result.Market.BettingClosesAt, &result.Market.OddsOver, &result.Market.OddsUnder, &result.Market.Status, &result.Market.ActualCount, &result.Market.CreatedAt, &result.Market.UpdatedAt, &result.Market.VoidReason, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if err = json.Unmarshal(raw, &result.Snapshot); err != nil {
		return result, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,market_id,outcome,proposed_count,verification,evidence_note,evidence_id,created_by,created_at FROM round_reviews WHERE market_id=$1 ORDER BY id DESC LIMIT 100`, id)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var v RoundReview
		var raw []byte
		if err = rows.Scan(&v.ID, &v.MarketID, &v.Outcome, &v.ProposedCount, &raw, &v.EvidenceNote, &v.EvidenceID, &v.CreatedBy, &v.CreatedAt); err != nil {
			return result, err
		}
		if err = json.Unmarshal(raw, &v.Verification); err != nil {
			return result, err
		}
		result.Reviews = append(result.Reviews, v)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	rows.Close()
	result.Observations, err = s.SourceObservations(ctx, result.Market.StreamID, result.Market.WindowStart.Add(-2*time.Minute), result.Market.WindowEnd.Add(2*time.Minute), 120)
	return result, err
}
func (s *Store) SaveRoundReview(ctx context.Context, id int64, input RoundReview) (RoundReview, error) {
	if !validEvidenceText(input.EvidenceNote, 20, 2000) || (input.Outcome != "verified" && input.Outcome != "invalid" && input.Outcome != "needs_review") || (input.ProposedCount != nil && (*input.ProposedCount < 0 || *input.ProposedCount > maxVehicleCount)) || input.EvidenceID != nil && *input.EvidenceID < 1 {
		return RoundReview{}, ErrInvalid
	}
	if input.Outcome == "verified" {
		if input.ProposedCount == nil {
			return RoundReview{}, ErrInvalid
		}
		input.Verification.EvidenceNote = input.EvidenceNote
		if _, err := normalizeSettlementVerification(input.Verification); err != nil {
			return RoundReview{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RoundReview{}, err
	}
	defer tx.Rollback(ctx)
	var status string
	var end time.Time
	if err = tx.QueryRow(ctx, `SELECT status,window_end FROM bet_markets WHERE id=$1 FOR UPDATE`, id).Scan(&status, &end); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RoundReview{}, ErrNotFound
		}
		return RoundReview{}, err
	}
	if status != MarketOpen || time.Now().Before(end) {
		return RoundReview{}, fmt.Errorf("%w: review a finished open round; settled history remains immutable", ErrConflict)
	}
	if input.Outcome == "verified" {
		if err = requireUTCRoundEvidence(ctx, tx, id, input.EvidenceID); err != nil {
			return RoundReview{}, err
		}
	} else if input.EvidenceID != nil {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM video_evidence WHERE id=$1)`, *input.EvidenceID).Scan(&exists); err != nil {
			return RoundReview{}, err
		}
		if !exists {
			return RoundReview{}, ErrNotFound
		}
	}
	actor, _ := currentUser(ctx)
	raw, _ := json.Marshal(input.Verification)
	input.MarketID = id
	input.CreatedBy = actor.ID
	err = tx.QueryRow(ctx, `INSERT INTO round_reviews(market_id,outcome,proposed_count,verification,evidence_note,evidence_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`, id, input.Outcome, input.ProposedCount, raw, input.EvidenceNote, input.EvidenceID, actor.ID).Scan(&input.ID, &input.CreatedAt)
	if err != nil {
		return input, err
	}
	if err = auditTx(ctx, tx, "round.reviewed", "market", id, map[string]any{"reviewId": input.ID, "outcome": input.Outcome, "proposedCount": input.ProposedCount, "evidenceId": input.EvidenceID}); err != nil {
		return input, err
	}
	return input, tx.Commit(ctx)
}

// Receipt-time observations, a playable clip, and operator checkboxes do not
// authenticate sensor capture UTC. This server-side gate is also repeated at
// settlement so historical unbound "verified" reviews cannot bypass it.
func requireUTCRoundEvidence(ctx context.Context, tx pgx.Tx, id int64, evidenceID *int64) error {
	var streamID int64
	var profileID *int64
	var start, end time.Time
	var rawSnapshot []byte
	if err := tx.QueryRow(ctx, `SELECT m.stream_id,m.window_start,m.window_end,c.profile_id,c.snapshot FROM bet_markets m JOIN round_counting_snapshots c ON c.market_id=m.id WHERE m.id=$1`, id).Scan(&streamID, &start, &end, &profileID, &rawSnapshot); err != nil {
		return err
	}
	if profileID == nil { // Existing unversioned accepted terms keep their original path.
		return nil
	}
	if evidenceID == nil || *evidenceID < 1 {
		return fmt.Errorf("%w: versioned UTC rounds require a retained evidence ID; checkboxes alone cannot verify capture time", ErrConflict)
	}
	var snapshot, retainedSnapshot CountingSnapshot
	var quality EvidenceQuality
	var evidenceStream, evidenceProfile, durationMS int64
	var fingerprint, status string
	var clipHash *string
	var rawRules, rawQuality []byte
	err := tx.QueryRow(ctx, `SELECT stream_id,profile_id,source_fingerprint,status,duration_ms,clip_sha256,counting_rules,quality FROM video_evidence e WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM video_evidence_retirements r WHERE r.evidence_id=e.id)`, *evidenceID).Scan(&evidenceStream, &evidenceProfile, &fingerprint, &status, &durationMS, &clipHash, &rawRules, &rawQuality)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: retained video evidence was not found", ErrConflict)
	}
	if err != nil {
		return err
	}
	if json.Unmarshal(rawSnapshot, &snapshot) != nil || json.Unmarshal(rawRules, &retainedSnapshot) != nil || json.Unmarshal(rawQuality, &quality) != nil {
		return fmt.Errorf("%w: retained evidence or published rules are invalid", ErrConflict)
	}
	if status != "ready" || clipHash == nil || !evidenceDigest.MatchString(*clipHash) || evidenceStream != streamID || evidenceProfile != *profileID || snapshot.ProfileID == nil || *snapshot.ProfileID != *profileID || retainedSnapshot.ProfileID == nil || *retainedSnapshot.ProfileID != *profileID || fingerprint != snapshot.SourceFingerprint || retainedSnapshot.SourceFingerprint != snapshot.SourceFingerprint || snapshot.Mode != "versioned" || retainedSnapshot.Mode != "versioned" || !reflect.DeepEqual(snapshot.Version, retainedSnapshot.Version) || !reflect.DeepEqual(snapshot.ReferenceID, retainedSnapshot.ReferenceID) || snapshot.Definition == nil || !reflect.DeepEqual(snapshot.Definition, retainedSnapshot.Definition) {
		return fmt.Errorf("%w: retained evidence must match this round's frozen camera, source and rule version", ErrConflict)
	}
	if !quality.FramesDecoded || !quality.RelativeCoverageComplete || quality.DecodedFrames < 1 || quality.SegmentCount < 1 || len(quality.MissingSequences) > 0 || len(quality.PTSGaps) > 0 {
		return fmt.Errorf("%w: retained evidence has no complete decoded media coverage", ErrConflict)
	}
	if !quality.CaptureTimeTrusted || quality.CaptureStart == nil {
		return fmt.Errorf("%w: trusted capture UTC is unavailable; relative media time and receipt time cannot settle a UTC round", ErrConflict)
	}
	if quality.FramingStatus != "stable_sampled" {
		return fmt.Errorf("%w: retained evidence has unverified or suspected changed framing; independent zone review is still required", ErrConflict)
	}
	// Bound the conversion before multiplying milliseconds into time.Duration.
	if durationMS < 1 || durationMS > 1_900_000 || !end.After(start) || start.Before(*quality.CaptureStart) || end.After(quality.CaptureStart.Add(time.Duration(durationMS)*time.Millisecond)) {
		return fmt.Errorf("%w: trusted retained capture coverage must include the entire round interval", ErrConflict)
	}
	return verifyRetainedClip(ctx, VideoEvidence{ID: *evidenceID, Status: status, ClipSHA256: clipHash})
}
func requireVersionedRoundReview(ctx context.Context, tx pgx.Tx, id int64, count int) error {
	var profileID *int64
	if err := tx.QueryRow(ctx, `SELECT profile_id FROM round_counting_snapshots WHERE market_id=$1`, id).Scan(&profileID); err != nil {
		return err
	}
	if profileID == nil {
		return nil
	}
	var outcome string
	var proposed *int
	var evidenceID *int64
	err := tx.QueryRow(ctx, `SELECT outcome,proposed_count,evidence_id FROM round_reviews WHERE market_id=$1 ORDER BY id DESC LIMIT 1`, id).Scan(&outcome, &proposed, &evidenceID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (outcome != "verified" || proposed == nil || *proposed != count) {
		return fmt.Errorf("%w: verify this versioned round in Round review before confirming its matching count", ErrConflict)
	}
	if err != nil {
		return err
	}
	return requireUTCRoundEvidence(ctx, tx, id, evidenceID)
}
func (api *API) handleRoundReview(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(strings.TrimPrefix(r.URL.Path, "/api/admin/round-review/"))
	if err != nil || r.URL.RawQuery != "" || r.URL.RawPath != "" {
		writeStoreError(w, ErrInvalid)
		return
	}
	if r.Method == http.MethodGet {
		data, err := api.store.RoundReviewDetail(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 200, data)
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Outcome       string                 `json:"outcome"`
			ProposedCount *int                   `json:"proposedCount"`
			Verification  SettlementVerification `json:"verification"`
			EvidenceNote  string                 `json:"evidenceNote"`
			EvidenceID    *int64                 `json:"evidenceId,omitempty"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		data, err := api.store.SaveRoundReview(r.Context(), id, RoundReview{Outcome: input.Outcome, ProposedCount: input.ProposedCount, Verification: input.Verification, EvidenceNote: input.EvidenceNote, EvidenceID: input.EvidenceID})
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 201, data)
		return
	}
	methodNotAllowed(w)
}
func pageBefore(r *http.Request) (int64, error) {
	if len(r.URL.Query()) > 1 {
		return 0, ErrInvalid
	}
	for k := range r.URL.Query() {
		if k != "before" {
			return 0, ErrInvalid
		}
	}
	values, ok := r.URL.Query()["before"]
	if !ok {
		return 0, nil
	}
	if len(values) != 1 {
		return 0, ErrInvalid
	}
	v, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || v < 1 {
		return 0, ErrInvalid
	}
	return v, nil
}
func (api *API) handleReviewQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	before, err := pageBefore(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rows, err := api.store.pool.Query(r.Context(), `SELECT m.id,m.stream_id,s.title,m.title,m.window_start,m.window_end,m.status,c.snapshot,
 COALESCE((SELECT outcome FROM round_reviews v WHERE v.market_id=m.id ORDER BY v.id DESC LIMIT 1),'needs_review')
 FROM bet_markets m JOIN streams s ON s.id=m.stream_id JOIN round_counting_snapshots c ON c.market_id=m.id
 WHERE m.status='open' AND m.window_end<=now() AND ($1::bigint=0 OR m.id<$1) ORDER BY m.id DESC LIMIT 51`, before)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, sid int64
		var title, stream, status, outcome string
		var start, end time.Time
		var raw json.RawMessage
		if err = rows.Scan(&id, &sid, &stream, &title, &start, &end, &status, &raw, &outcome); err != nil {
			writeStoreError(w, err)
			return
		}
		items = append(items, map[string]any{"id": id, "streamId": sid, "streamTitle": stream, "title": title, "windowStart": start, "windowEnd": end, "status": status, "countingRules": raw, "reviewOutcome": outcome})
	}
	if err = rows.Err(); err != nil {
		writeStoreError(w, err)
		return
	}
	more := len(items) > 50
	if more {
		items = items[:50]
	}
	writeJSON(w, 200, map[string]any{"items": items, "hasMore": more})
}
func (api *API) handleAuditDirectory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	before, err := pageBefore(r)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	rows, err := api.store.pool.Query(r.Context(), `SELECT id,actor_user_id,action,resource_type,resource_id,created_at FROM audit_events WHERE ($1::bigint=0 OR id<$1) ORDER BY id DESC LIMIT 51`, before)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var actor, resource *int64
		var action, kind string
		var at time.Time
		if err = rows.Scan(&id, &actor, &action, &kind, &resource, &at); err != nil {
			writeStoreError(w, err)
			return
		}
		items = append(items, map[string]any{"id": id, "actorUserId": actor, "action": action, "resourceType": kind, "resourceId": resource, "createdAt": at})
	}
	if err = rows.Err(); err != nil {
		writeStoreError(w, err)
		return
	}
	more := len(items) > 50
	if more {
		items = items[:50]
	}
	writeJSON(w, 200, map[string]any{"items": items, "hasMore": more})
}
