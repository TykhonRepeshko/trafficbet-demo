package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// Bind observations to server-owned retained content and immutable rules.
func (api *API) handleEvidenceAnnotation(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input struct {
		StartOffsetMS  int64            `json:"startOffsetMs,omitempty"`
		EndOffsetMS    *int64           `json:"endOffsetMs,omitempty"`
		Split          string           `json:"split"`
		Condition      string           `json:"condition"`
		TimingEvidence string           `json:"timingEvidence"`
		Note           string           `json:"note"`
		Crossings      []ManualCrossing `json:"crossings"`
		Provenance     string           `json:"provenance,omitempty"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	evidence, err := api.store.VideoEvidence(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if evidence.Status != "ready" || evidence.ClipSHA256 == nil {
		writeError(w, 409, "evidence_not_ready", "Wait for a retained playable clip before adding annotations.")
		return
	}
	end := evidence.DurationMS
	if input.EndOffsetMS != nil {
		end = *input.EndOffsetMS
	}
	if input.StartOffsetMS < 0 || input.StartOffsetMS >= evidence.DurationMS || end <= input.StartOffsetMS || end > evidence.DurationMS || end-input.StartOffsetMS < 1000 {
		writeError(w, 400, "invalid_clip_interval", "Choose at least one second inside the retained clip.")
		return
	}
	value := ManualInterval{EvidenceID: &id, Provenance: input.Provenance, ProfileID: evidence.ProfileID, ClipSHA256: *evidence.ClipSHA256, Split: input.Split, DurationMS: end - input.StartOffsetMS, StartOffsetMS: input.StartOffsetMS, EndOffsetMS: &end, Condition: input.Condition, TimingEvidence: input.TimingEvidence, Note: input.Note, Crossings: input.Crossings}
	body, err := json.Marshal(value)
	if err != nil {
		writeStoreError(w, ErrInvalid)
		return
	}
	clone := r.Clone(r.Context())
	clone.URL.Path = "/api/admin/evaluation"
	clone.Body = io.NopCloser(bytes.NewReader(body))
	clone.ContentLength = int64(len(body))
	api.handleEvaluation(w, clone)
}
