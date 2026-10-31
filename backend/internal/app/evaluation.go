package app

import (
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type ManualCrossing struct {
	Track     string `json:"track"`
	OffsetMS  int64  `json:"offsetMs"`
	Direction string `json:"direction"`
	Class     string `json:"class"`
	Uncertain bool   `json:"uncertain"`
}
type ManualInterval struct {
	StartOffsetMS  int64            `json:"startOffsetMs,omitempty"`
	EndOffsetMS    *int64           `json:"endOffsetMs,omitempty"`
	EvidenceID     *int64           `json:"evidenceId,omitempty"`
	Provenance     string           `json:"provenance,omitempty"`
	ProfileID      int64            `json:"profileId"`
	ClipSHA256     string           `json:"clipSha256"`
	Split          string           `json:"split"`
	DurationMS     int64            `json:"durationMs"`
	Condition      string           `json:"condition"`
	CaptureStart   *time.Time       `json:"captureStart"`
	TimingEvidence string           `json:"timingEvidence"`
	Note           string           `json:"note"`
	Crossings      []ManualCrossing `json:"crossings"`
}

func validManualInterval(v ManualInterval) bool {
	if v.StartOffsetMS < 0 || v.StartOffsetMS > 3600000 || v.EndOffsetMS != nil && (*v.EndOffsetMS <= v.StartOffsetMS || *v.EndOffsetMS > 3600000) {
		return false
	}
	if v.EvidenceID != nil && *v.EvidenceID < 1 || v.Provenance != "" && v.Provenance != "manual" && v.Provenance != "assistant_assisted" {
		return false
	}
	if v.ProfileID < 1 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(v.ClipSHA256) || (v.Split != "tuning" && v.Split != "test") || v.DurationMS < 1000 || v.DurationMS > 3600000 || len(v.Crossings) > 500 || !validEvidenceText(v.Note, 20, 2000) || !validEvidenceText(v.TimingEvidence, 20, 2000) {
		return false
	}
	if v.Condition != "day" && v.Condition != "night" && v.Condition != "glare" && v.Condition != "rain" && v.Condition != "snow" && v.Condition != "occluded" && v.Condition != "unknown" {
		return false
	}
	seen := map[string]bool{}
	for _, event := range v.Crossings {
		if !validEvidenceText(event.Track, 1, 80) || event.OffsetMS < 0 || event.OffsetMS >= v.DurationMS || (event.Direction != "A_to_B" && event.Direction != "B_to_A") || (event.Class != "car" && event.Class != "van" && event.Class != "bus" && event.Class != "truck" && event.Class != "motorcycle" && event.Class != "unknown") || seen[event.Track] {
			return false
		}
		seen[event.Track] = true
	}
	return true
}
func (api *API) handleEvaluation(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawPath != "" {
		writeStoreError(w, ErrInvalid)
		return
	}
	user, _ := currentUser(r.Context())
	if r.URL.Path == "/api/admin/evaluation" && r.Method == http.MethodGet {
		before, err := pageBefore(r)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		rows, err := api.store.pool.Query(r.Context(), `SELECT i.id,i.annotation,i.created_by,i.created_at,COALESCE((SELECT outcome FROM evaluation_reviews WHERE interval_id=i.id ORDER BY id DESC LIMIT 1),'needs_review') FROM evaluation_intervals i WHERE ($1::bigint=0 OR i.id<$1) ORDER BY i.id DESC LIMIT 21`, before)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id, actor int64
			var annotation json.RawMessage
			var at time.Time
			var status string
			if err = rows.Scan(&id, &annotation, &actor, &at, &status); err != nil {
				writeStoreError(w, err)
				return
			}
			items = append(items, map[string]any{"id": id, "annotation": annotation, "createdBy": actor, "createdAt": at, "reviewOutcome": status})
		}
		if err = rows.Err(); err != nil {
			writeStoreError(w, err)
			return
		}
		more := len(items) > 20
		if more {
			items = items[:20]
		}
		writeJSON(w, 200, map[string]any{"items": items, "hasMore": more})
		return
	}
	if r.Method != http.MethodPost || r.URL.RawQuery != "" {
		methodNotAllowed(w)
		return
	}
	if r.URL.Path == "/api/admin/evaluation" {
		var input ManualInterval
		if !decodeJSON(w, r, &input) {
			return
		}
		if !validManualInterval(input) {
			writeStoreError(w, ErrInvalid)
			return
		}
		if input.Provenance == "" {
			input.Provenance = "manual"
		}
		if input.EvidenceID != nil {
			evidence, err := api.store.VideoEvidence(r.Context(), *input.EvidenceID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			if evidence.Status != "ready" || evidence.ClipSHA256 == nil || input.ProfileID != evidence.ProfileID || input.ClipSHA256 != *evidence.ClipSHA256 || input.StartOffsetMS < 0 || input.DurationMS < 1000 || input.StartOffsetMS+input.DurationMS > evidence.DurationMS || (input.EndOffsetMS != nil && *input.EndOffsetMS != input.StartOffsetMS+input.DurationMS) {
				writeError(w, 409, "evidence_mismatch", "Annotation must match the retained clip and frozen rule version.")
				return
			}
			if err := verifyRetainedClip(r.Context(), evidence); err != nil {
				writeStoreError(w, err)
				return
			}
			input.CaptureStart = nil
			if evidence.Quality.CaptureTimeTrusted {
				if evidence.Quality.CaptureStart != nil {
					v := evidence.Quality.CaptureStart.Add(time.Duration(input.StartOffsetMS) * time.Millisecond)
					input.CaptureStart = &v
				}
			}
		}
		tx, err := api.store.pool.Begin(r.Context())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		defer tx.Rollback(r.Context())
		ctx := r.Context()
		// Serialize split assignment across parent clips too: independently
		// captured files can still contain identical source segments.
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(93741529)`); err != nil {
			writeStoreError(w, err)
			return
		}
		var conflict bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM evaluation_intervals WHERE clip_sha256=$1 AND dataset_split<>$2)`, input.ClipSHA256, input.Split).Scan(&conflict); err != nil {
			writeStoreError(w, err)
			return
		}
		if conflict {
			writeError(w, 409, "dataset_overlap", "The same clip must stay in one dataset split.")
			return
		}
		if input.EvidenceID != nil {
			if err = tx.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM evaluation_intervals i JOIN video_evidence old ON old.id=i.evidence_id
 JOIN video_evidence current ON current.id=$1
 WHERE i.dataset_split<>$2 AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(COALESCE(old.quality->'segments','[]'::jsonb)) a,
 jsonb_array_elements(COALESCE(current.quality->'segments','[]'::jsonb)) b
 WHERE a->>'sha256'=b->>'sha256' AND a->>'sha256' ~ '^[a-f0-9]{64}$'))`, *input.EvidenceID, input.Split).Scan(&conflict); err != nil {
				writeStoreError(w, err)
				return
			}
			if conflict {
				writeError(w, 409, "dataset_overlap", "Clips sharing retained source segments must stay in one dataset split.")
				return
			}
		}
		var rawRule []byte
		err = tx.QueryRow(ctx, `SELECT definition FROM counting_profiles WHERE id=$1`, input.ProfileID).Scan(&rawRule)
		if errors.Is(err, pgx.ErrNoRows) {
			writeStoreError(w, ErrNotFound)
			return
		}
		if err != nil {
			writeStoreError(w, err)
			return
		}
		var rule CountingDefinition
		if json.Unmarshal(rawRule, &rule) != nil {
			writeStoreError(w, ErrInvalid)
			return
		}
		for _, event := range input.Crossings {
			if event.Uncertain {
				continue
			}
			if !containsString(rule.Directions, event.Direction) || !containsString(rule.Classes, event.Class) {
				writeError(w, 400, "rule_mismatch", "Certain events must follow the selected direction and class rules.")
				return
			}
		}
		raw, _ := json.Marshal(input)
		var id int64
		if err = tx.QueryRow(ctx, `INSERT INTO evaluation_intervals(profile_id,clip_sha256,dataset_split,annotation,created_by,evidence_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, input.ProfileID, input.ClipSHA256, input.Split, raw, user.ID, input.EvidenceID).Scan(&id); err == nil {
			err = auditTx(ctx, tx, "evaluation.annotated", "evaluation", id, map[string]any{"profileId": input.ProfileID, "split": input.Split})
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"id": id, "status": "needs_review"})
		return
	}
	id, err := parseID(strings.TrimPrefix(r.URL.Path, "/api/admin/evaluation/"))
	if err != nil {
		writeStoreError(w, ErrInvalid)
		return
	}
	var input struct {
		Outcome string `json:"outcome"`
		Note    string `json:"note"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if !validEvidenceText(input.Note, 20, 2000) || (input.Outcome != "accepted" && input.Outcome != "disputed" && input.Outcome != "unverifiable") {
		writeStoreError(w, ErrInvalid)
		return
	}
	tx, err := api.store.pool.Begin(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var author int64
	var raw []byte
	if err = tx.QueryRow(r.Context(), `SELECT created_by,annotation FROM evaluation_intervals WHERE id=$1 FOR UPDATE`, id).Scan(&author, &raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeStoreError(w, ErrNotFound)
		} else {
			writeStoreError(w, err)
		}
		return
	}
	var annotation ManualInterval
	if err = json.Unmarshal(raw, &annotation); err != nil {
		writeStoreError(w, err)
		return
	}
	if input.Outcome == "accepted" {
		uncertain := false
		for _, event := range annotation.Crossings {
			uncertain = uncertain || event.Uncertain
		}
		if author == user.ID || annotation.EvidenceID == nil || uncertain {
			writeError(w, 409, "independent_review_required", "Benchmark acceptance requires another operator, retained video and no unresolved crossing ambiguity; it does not certify capture UTC.")
			return
		}
		evidence, err := api.store.VideoEvidence(r.Context(), *annotation.EvidenceID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if evidence.Status != "ready" || !evidence.Quality.RelativeCoverageComplete || !evidence.Quality.FramesDecoded {
			writeError(w, 409, "incomplete_evidence", "Benchmark acceptance requires complete decoded coverage of the retained clip.")
			return
		}
		if err := verifyRetainedClip(r.Context(), evidence); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO evaluation_reviews(interval_id,outcome,note,created_by) VALUES($1,$2,$3,$4)`, id, input.Outcome, input.Note, user.ID)
	if err == nil {
		err = auditTx(r.Context(), tx, "evaluation.reviewed", "evaluation", id, map[string]any{"outcome": input.Outcome})
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 201, map[string]bool{"reviewed": true})
}
func containsString(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
