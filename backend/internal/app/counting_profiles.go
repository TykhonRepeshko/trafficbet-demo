package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type CountingPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type CountingDefinition struct {
	Label      string        `json:"label"`
	LineStart  CountingPoint `json:"lineStart"`
	LineEnd    CountingPoint `json:"lineEnd"`
	Directions []string      `json:"directions"`
	Classes    []string      `json:"classes"`
	Anchor     string        `json:"anchor"`
	TimeBasis  string        `json:"timeBasis"`
	Notes      string        `json:"notes"`
}
type CountingReference struct {
	ID                int64     `json:"id"`
	StreamID          int64     `json:"streamId"`
	SourceFingerprint string    `json:"sourceFingerprint"`
	ImageSHA256       string    `json:"imageSha256"`
	Width             int       `json:"width"`
	Height            int       `json:"height"`
	CreatedAt         time.Time `json:"createdAt"`
}
type CountingProfile struct {
	ID                int64              `json:"id"`
	StreamID          int64              `json:"streamId"`
	Version           int                `json:"version"`
	ReferenceID       int64              `json:"referenceId"`
	SourceFingerprint string             `json:"sourceFingerprint"`
	Definition        CountingDefinition `json:"definition"`
	CreatedAt         time.Time          `json:"createdAt"`
	Approved          bool               `json:"approved"`
	SourceMatches     bool               `json:"sourceMatches"`
}
type CountingPreparation struct {
	StreamID          int64               `json:"streamId"`
	SourceFingerprint string              `json:"sourceFingerprint"`
	Profiles          []CountingProfile   `json:"profiles"`
	References        []CountingReference `json:"references"`
}
type CountingSnapshot struct {
	Mode               string              `json:"mode"`
	ProfileID          *int64              `json:"profileId,omitempty"`
	Version            *int                `json:"version,omitempty"`
	ReferenceID        *int64              `json:"referenceId,omitempty"`
	SourceFingerprint  string              `json:"sourceFingerprint,omitempty"`
	Definition         *CountingDefinition `json:"definition,omitempty"`
	PublishedTitle     string              `json:"publishedTitle"`
	IntervalConvention string              `json:"intervalConvention"`
}

// Public geometry only: operator notes, reference images and approval actors
// stay private. A draft guide is never a substitute for published round rules.
type PublicCountingGuide struct {
	ProfileID         int64              `json:"profileId"`
	Version           int                `json:"version"`
	Approved          bool               `json:"approved"`
	SourceFingerprint string             `json:"sourceFingerprint"`
	Width             int                `json:"width"`
	Height            int                `json:"height"`
	Definition        CountingDefinition `json:"definition"`
}

func (s *Store) attachPublicCountingGuides(ctx context.Context, streams []Stream) error {
	if len(streams) == 0 {
		return nil
	}
	ids := make([]int64, len(streams))
	positions := map[int64]int{}
	for i, stream := range streams {
		ids[i] = stream.ID
		positions[stream.ID] = i
	}
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT ON (c.stream_id) c.stream_id,c.id,c.version,
 COALESCE(a.profile_id=c.id,false),c.source_fingerprint,r.width,r.height,c.definition
 FROM counting_profiles c JOIN streams s ON s.id=c.stream_id
 JOIN counting_references r ON r.id=c.reference_id
 LEFT JOIN counting_selections a ON a.stream_id=c.stream_id
 WHERE c.stream_id=ANY($1) AND s.is_active AND s.retired_at IS NULL
 AND c.source_fingerprint=encode(sha256(convert_to(s.stream_type,'UTF8') || decode('00','hex') || convert_to(s.stream_url,'UTF8')),'hex')
 ORDER BY c.stream_id,COALESCE(a.profile_id=c.id,false) DESC,c.version DESC`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var raw []byte
		var guide PublicCountingGuide
		if err = rows.Scan(&id, &guide.ProfileID, &guide.Version, &guide.Approved, &guide.SourceFingerprint, &guide.Width, &guide.Height, &raw); err != nil {
			return err
		}
		if err = json.Unmarshal(raw, &guide.Definition); err != nil {
			return err
		}
		guide.Definition.Notes = ""
		streams[positions[id]].CountingGuide = &guide
	}
	return rows.Err()
}

func (s *Store) attachCountingSnapshots(ctx context.Context, markets []Market) error {
	if len(markets) == 0 {
		return nil
	}
	ids := make([]int64, len(markets))
	positions := map[int64]int{}
	for i, m := range markets {
		ids[i] = m.ID
		positions[m.ID] = i
	}
	rows, err := s.pool.Query(ctx, `SELECT market_id,snapshot FROM round_counting_snapshots WHERE market_id=ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var raw []byte
		var snapshot CountingSnapshot
		if err = rows.Scan(&id, &raw); err != nil {
			return err
		}
		if err = json.Unmarshal(raw, &snapshot); err != nil {
			return err
		}
		markets[positions[id]].CountingRules = &snapshot
	}
	return rows.Err()
}
func validCountingDefinition(d CountingDefinition) bool {
	point := func(p CountingPoint) bool {
		return !math.IsNaN(p.X) && !math.IsNaN(p.Y) && !math.IsInf(p.X, 0) && !math.IsInf(p.Y, 0) && p.X >= 0 && p.X <= 1 && p.Y >= 0 && p.Y <= 1
	}
	if !validEvidenceText(d.Label, 1, 160) || !validEvidenceText(d.Notes, 20, 1000) || !point(d.LineStart) || !point(d.LineEnd) || math.Hypot(d.LineStart.X-d.LineEnd.X, d.LineStart.Y-d.LineEnd.Y) < 0.05 || d.Anchor != "bottom_center" || d.TimeBasis != "capture_utc" {
		return false
	}
	validList := func(values []string, allowed map[string]bool) bool {
		if len(values) == 0 || len(values) > len(allowed) {
			return false
		}
		seen := map[string]bool{}
		for _, v := range values {
			if !allowed[v] || seen[v] {
				return false
			}
			seen[v] = true
		}
		return true
	}
	return validList(d.Directions, map[string]bool{"A_to_B": true, "B_to_A": true}) && validList(d.Classes, map[string]bool{"car": true, "van": true, "bus": true, "truck": true, "motorcycle": true})
}
func sourceFingerprint(s Stream) string { v := mediaFingerprint(s); return hex.EncodeToString(v[:]) }
func (s *Store) CountingPreparation(ctx context.Context, id int64) (CountingPreparation, error) {
	stream, err := s.GetStream(ctx, id)
	if err != nil {
		return CountingPreparation{}, err
	}
	result := CountingPreparation{StreamID: id, SourceFingerprint: sourceFingerprint(stream), Profiles: []CountingProfile{}, References: []CountingReference{}}
	rows, err := s.pool.Query(ctx, `SELECT c.id,c.stream_id,c.version,c.reference_id,c.source_fingerprint,c.definition,c.created_at,
 EXISTS(SELECT 1 FROM counting_selections a WHERE a.profile_id=c.id) FROM counting_profiles c WHERE c.stream_id=$1 ORDER BY c.version DESC LIMIT 100`, id)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var p CountingProfile
		var raw []byte
		if err = rows.Scan(&p.ID, &p.StreamID, &p.Version, &p.ReferenceID, &p.SourceFingerprint, &raw, &p.CreatedAt, &p.Approved); err != nil {
			return result, err
		}
		if err = json.Unmarshal(raw, &p.Definition); err != nil {
			return result, err
		}
		p.SourceMatches = p.SourceFingerprint == result.SourceFingerprint
		result.Profiles = append(result.Profiles, p)
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	rows.Close()
	refs, err := s.pool.Query(ctx, `SELECT id,stream_id,source_fingerprint,image_sha256,width,height,created_at FROM counting_references WHERE stream_id=$1 ORDER BY id DESC LIMIT 100`, id)
	if err != nil {
		return result, err
	}
	defer refs.Close()
	for refs.Next() {
		var r CountingReference
		if err = refs.Scan(&r.ID, &r.StreamID, &r.SourceFingerprint, &r.ImageSHA256, &r.Width, &r.Height, &r.CreatedAt); err != nil {
			return result, err
		}
		result.References = append(result.References, r)
	}
	return result, refs.Err()
}
func normalizeReference(body []byte) ([]byte, int, int, error) {
	cfg, err := png.DecodeConfig(bytes.NewReader(body))
	if err != nil || len(body) > 1<<20 || cfg.Width < 32 || cfg.Height < 32 || cfg.Width > 1920 || cfg.Height > 1080 || cfg.Width*cfg.Height > 1920*1080 {
		return nil, 0, 0, ErrInvalid
	}
	img, err := png.Decode(bytes.NewReader(body))
	if err != nil {
		return nil, 0, 0, ErrInvalid
	}
	var out bytes.Buffer
	if err = png.Encode(&out, img); err != nil || out.Len() > 1<<20 {
		return nil, 0, 0, ErrInvalid
	}
	return out.Bytes(), cfg.Width, cfg.Height, nil
}
func (s *Store) SaveCountingReference(ctx context.Context, id int64, body []byte) (CountingReference, error) {
	data, w, h, err := normalizeReference(body)
	if err != nil {
		return CountingReference{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CountingReference{}, err
	}
	defer tx.Rollback(ctx)
	var stream Stream
	stream.ID = id
	if err = tx.QueryRow(ctx, `SELECT stream_type,stream_url FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, id).Scan(&stream.StreamType, &stream.StreamURL); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CountingReference{}, ErrNotFound
		}
		return CountingReference{}, err
	}
	actor, _ := currentUser(ctx)
	hash := sha256.Sum256(data)
	var referenceCount int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM counting_references WHERE stream_id=$1`, id).Scan(&referenceCount); err != nil {
		return CountingReference{}, err
	}
	if referenceCount >= 100 {
		return CountingReference{}, fmt.Errorf("%w: this camera reached its 100-reference storage limit; preserve historical evidence and review retention before adding more", ErrConflict)
	}
	r := CountingReference{StreamID: id, SourceFingerprint: sourceFingerprint(stream), ImageSHA256: hex.EncodeToString(hash[:]), Width: w, Height: h}
	err = tx.QueryRow(ctx, `INSERT INTO counting_references(stream_id,source_fingerprint,image_sha256,image_png,width,height,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`, id, r.SourceFingerprint, r.ImageSHA256, data, w, h, actor.ID).Scan(&r.ID, &r.CreatedAt)
	if err != nil {
		return r, err
	}
	if err = auditTx(ctx, tx, "counting.reference_uploaded", "stream", id, map[string]any{"referenceId": r.ID, "imageSha256": r.ImageSHA256, "provenance": "operator_upload_not_capture_time_proof"}); err != nil {
		return r, err
	}
	return r, tx.Commit(ctx)
}
func (s *Store) SaveCountingProfile(ctx context.Context, id, referenceID int64, d CountingDefinition) (CountingProfile, error) {
	if !validCountingDefinition(d) {
		return CountingProfile{}, fmt.Errorf("%w: select a valid line, directions, classes and 20–1000 character notes", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CountingProfile{}, err
	}
	defer tx.Rollback(ctx)
	stream := Stream{ID: id}
	if err = tx.QueryRow(ctx, `SELECT stream_type,stream_url FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, id).Scan(&stream.StreamType, &stream.StreamURL); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CountingProfile{}, ErrNotFound
		}
		return CountingProfile{}, err
	}
	fingerprint := sourceFingerprint(stream)
	var profileCount int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM counting_profiles WHERE stream_id=$1`, id).Scan(&profileCount); err != nil {
		return CountingProfile{}, err
	}
	if profileCount >= 1000 {
		return CountingProfile{}, fmt.Errorf("%w: this camera reached its 1000-version limit", ErrConflict)
	}
	var referenceMatches bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM counting_references WHERE id=$1 AND stream_id=$2 AND source_fingerprint=$3)`, referenceID, id, fingerprint).Scan(&referenceMatches); err != nil {
		return CountingProfile{}, err
	}
	if !referenceMatches {
		return CountingProfile{}, fmt.Errorf("%w: upload a reference for the current camera source first", ErrConflict)
	}
	actor, _ := currentUser(ctx)
	raw, _ := json.Marshal(d)
	p := CountingProfile{StreamID: id, ReferenceID: referenceID, SourceFingerprint: fingerprint, Definition: d, SourceMatches: true}
	err = tx.QueryRow(ctx, `INSERT INTO counting_profiles(stream_id,version,reference_id,source_fingerprint,definition,created_by)
 SELECT $1,COALESCE(max(version),0)+1,$2,$3,$4,$5 FROM counting_profiles WHERE stream_id=$1 RETURNING id,version,created_at`, id, referenceID, fingerprint, raw, actor.ID).Scan(&p.ID, &p.Version, &p.CreatedAt)
	if err != nil {
		return p, err
	}
	if err = auditTx(ctx, tx, "counting.profile_created", "stream", id, map[string]any{"profileId": p.ID, "version": p.Version}); err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}
func (s *Store) ApproveCountingProfile(ctx context.Context, id, profileID int64, note string) error {
	if !validEvidenceText(note, 20, 2000) {
		return fmt.Errorf("%w: describe the reference and rule verification in 20–2000 characters", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	stream := Stream{ID: id}
	if err = tx.QueryRow(ctx, `SELECT stream_type,stream_url FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, id).Scan(&stream.StreamType, &stream.StreamURL); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	var matches bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM counting_profiles WHERE id=$1 AND stream_id=$2 AND source_fingerprint=$3)`, profileID, id, sourceFingerprint(stream)).Scan(&matches); err != nil {
		return err
	}
	if !matches {
		return fmt.Errorf("%w: profile is missing or belongs to an older source", ErrConflict)
	}
	actor, _ := currentUser(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO counting_selections(stream_id,profile_id,approved_by,approval_note) VALUES($1,$2,$3,$4) ON CONFLICT(stream_id) DO UPDATE SET profile_id=EXCLUDED.profile_id,approved_by=EXCLUDED.approved_by,approval_note=EXCLUDED.approval_note,approved_at=now()`, id, profileID, actor.ID, note)
	if err != nil {
		return err
	}
	if err = auditTx(ctx, tx, "counting.profile_approved", "stream", id, map[string]any{"profileId": profileID, "note": note, "appliesTo": "future_publications"}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (api *API) handleCountingPreparation(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/preparation/"), "/")
	if r.URL.RawQuery != "" || r.URL.RawPath != "" || len(parts) < 1 || len(parts) > 3 {
		http.NotFound(w, r)
		return
	}
	id, err := parseID(parts[0])
	if err != nil {
		writeStoreError(w, ErrInvalid)
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		data, err := api.store.CountingPreparation(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 200, data)
		return
	}
	if len(parts) == 3 && parts[1] == "references" && r.Method == http.MethodGet {
		ref, err := parseID(parts[2])
		if err != nil {
			writeStoreError(w, ErrInvalid)
			return
		}
		var body []byte
		err = api.store.pool.QueryRow(r.Context(), `SELECT image_png FROM counting_references WHERE id=$1 AND stream_id=$2`, ref, id).Scan(&body)
		if errors.Is(err, pgx.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			writeStoreError(w, err)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		_, _ = w.Write(body)
		return
	}
	if len(parts) == 2 && parts[1] == "references" && r.Method == http.MethodPost {
		if r.Header.Get("Content-Type") != "image/png" {
			writeError(w, 415, "png_required", "Upload a PNG reference image.")
			return
		}
		defer r.Body.Close()
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeError(w, 413, "image_too_large", "Reference images are limited to 1 MiB.")
			return
		}
		data, err := api.store.SaveCountingReference(r.Context(), id, body)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 201, data)
		return
	}
	if len(parts) == 2 && parts[1] == "profiles" && r.Method == http.MethodPost {
		var input struct {
			ReferenceID int64              `json:"referenceId"`
			Definition  CountingDefinition `json:"definition"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		data, err := api.store.SaveCountingProfile(r.Context(), id, input.ReferenceID, input.Definition)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 201, data)
		return
	}
	if len(parts) == 3 && parts[1] == "approve" && r.Method == http.MethodPost {
		profileID, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil || profileID < 1 {
			writeStoreError(w, ErrInvalid)
			return
		}
		var input struct {
			Note string `json:"note"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if err = api.store.ApproveCountingProfile(r.Context(), id, profileID, input.Note); err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"approved": true})
		return
	}
	methodNotAllowed(w)
}
