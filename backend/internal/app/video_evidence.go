package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const evidenceColumns = `e.id,e.stream_id,s.title,e.profile_id,e.status,e.requested_seconds,e.duration_ms,e.clip_sha256,e.byte_count,e.counting_rules,e.quality,e.error_code,e.created_at,e.completed_at`

type VideoEvidence struct {
	ID               int64            `json:"id"`
	StreamID         int64            `json:"streamId"`
	StreamTitle      string           `json:"streamTitle"`
	ProfileID        int64            `json:"profileId"`
	Status           string           `json:"status"`
	RequestedSeconds int              `json:"requestedSeconds"`
	DurationMS       int64            `json:"durationMs"`
	ClipSHA256       *string          `json:"clipSha256"`
	ByteCount        int64            `json:"byteCount"`
	CountingRules    CountingSnapshot `json:"countingRules"`
	Quality          EvidenceQuality  `json:"quality"`
	ErrorCode        string           `json:"errorCode"`
	CreatedAt        time.Time        `json:"createdAt"`
	CompletedAt      *time.Time       `json:"completedAt"`
}

type EvidenceCaptureDiagnostics struct {
	ManifestPolls    int   `json:"manifestPolls"`
	ManifestFailures int   `json:"manifestFailures"`
	SegmentAttempts  int   `json:"segmentAttempts"`
	SegmentFailures  int   `json:"segmentFailures"`
	InvalidHandles   int   `json:"invalidHandles"`
	CaptureWallMS    int64 `json:"captureWallMs"`
	ProcessingMS     int64 `json:"processingMs"`
}

func scanVideoEvidence(row pgx.Row) (VideoEvidence, error) {
	v := VideoEvidence{}
	var rules, quality []byte
	err := row.Scan(&v.ID, &v.StreamID, &v.StreamTitle, &v.ProfileID, &v.Status, &v.RequestedSeconds, &v.DurationMS, &v.ClipSHA256, &v.ByteCount, &rules, &quality, &v.ErrorCode, &v.CreatedAt, &v.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal(rules, &v.CountingRules)
	}
	if err == nil {
		err = json.Unmarshal(quality, &v.Quality)
	}
	return v, err
}
func (s *Store) VideoEvidence(ctx context.Context, id int64) (VideoEvidence, error) {
	return scanVideoEvidence(s.pool.QueryRow(ctx, `SELECT `+evidenceColumns+` FROM video_evidence e JOIN streams s ON s.id=e.stream_id WHERE e.id=$1 AND NOT EXISTS(SELECT 1 FROM video_evidence_retirements r WHERE r.evidence_id=e.id)`, id))
}
func evidenceDirectory() string {
	path := os.Getenv("EVIDENCE_DIRECTORY")
	if path == "" {
		path = filepath.Join(".local-data", "video-evidence")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	return absolute
}
func videoDecoderPath() string {
	if path := os.Getenv("VIDEO_DECODER_PATH"); path != "" {
		if absolute, err := filepath.Abs(path); err == nil {
			return absolute
		}
		return ""
	}
	if path, err := exec.LookPath("ffmpeg"); err == nil {
		return path
	}
	if runtime.GOOS == "windows" {
		paths, _ := filepath.Glob(filepath.Join(".tools", "ffmpeg", "*", "bin", "ffmpeg.exe"))
		if len(paths) == 1 {
			path, _ := filepath.Abs(paths[0])
			return path
		}
	}
	return ""
}
func evidenceFolder(id int64) (string, error) {
	if id < 1 || evidenceDirectory() == "" {
		return "", ErrInvalid
	}
	root := evidenceDirectory()
	folder := filepath.Join(root, strconv.FormatInt(id, 10))
	if filepath.Dir(folder) != root {
		return "", ErrInvalid
	}
	if err := validateEvidencePath(folder); err != nil {
		return "", err
	}
	return folder, nil
}

// Reject intermediate symlinks/junctions as well as a replaced final file.
// Evidence paths are local configuration, never URLs supplied to the decoder.
func validateEvidencePath(path string) error {
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return ErrInvalid
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return nil
}
func emptyEvidenceQuality() EvidenceQuality {
	return EvidenceQuality{TimingBasis: "media_relative", Issues: []string{"capture_time_unverified", "capture_incomplete", "framing_unverified"}, MissingSequences: []int64{}, PTSGaps: []EvidenceGap{}, Segments: []EvidenceSegment{}, FramingStatus: "unverified"}
}

func verifyRetainedClip(ctx context.Context, evidence VideoEvidence) error {
	if evidence.Status != "ready" || evidence.ClipSHA256 == nil {
		return ErrConflict
	}
	folder, err := evidenceFolder(evidence.ID)
	if err != nil {
		return err
	}
	path := filepath.Join(folder, "clip.mp4")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 512<<20 {
		return fmt.Errorf("%w: retained clip is missing or invalid", ErrConflict)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	buffer := make([]byte, 64<<10)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := file.Read(buffer)
		total += int64(n)
		if total > 512<<20 {
			return ErrConflict
		}
		_, _ = hash.Write(buffer[:n])
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if total != info.Size() || hex.EncodeToString(hash.Sum(nil)) != *evidence.ClipSHA256 {
		return fmt.Errorf("%w: retained clip SHA-256 does not match its immutable record", ErrConflict)
	}
	return nil
}
func (api *API) createVideoEvidence(ctx context.Context, streamID, profileID int64, seconds int) (VideoEvidence, error) {
	if !api.cfg.VideoEvidenceEnabled {
		return VideoEvidence{}, fmt.Errorf("%w: retained video capture is disabled", ErrConflict)
	}
	if streamID < 1 || profileID < 1 || seconds < 30 || seconds > 900 {
		return VideoEvidence{}, ErrInvalid
	}
	if videoDecoderPath() == "" {
		return VideoEvidence{}, fmt.Errorf("%w: video decoder is unavailable; prepare the local FFmpeg runtime first", ErrConflict)
	}
	tx, err := api.store.pool.Begin(ctx)
	if err != nil {
		return VideoEvidence{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(93741527)`); err != nil {
		return VideoEvidence{}, err
	}
	var queued int
	var used int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status IN ('queued','capturing','processing')),
 COALESCE(sum(CASE WHEN status='ready' THEN byte_count ELSE 1610612736 END),0) FROM video_evidence e WHERE NOT EXISTS(SELECT 1 FROM video_evidence_retirements r WHERE r.evidence_id=e.id)`).Scan(&queued, &used); err != nil {
		return VideoEvidence{}, err
	}
	// A job can retain 512 MiB of TS plus 512 MiB of MP4; the decoder also
	// needs a temporary TS copy. Reserve that full peak before accepting work.
	// Failed/interrupted jobs retain their full peak reservation: an abrupt
	// process exit can leave input/partial output files beyond byte_count.
	if queued >= 3 || used+(1536<<20) > 6<<30 {
		return VideoEvidence{}, fmt.Errorf("%w: capture queue or 6 GiB evidence storage budget is full", ErrConflict)
	}
	var kind, rawURL string
	var active bool
	if err = tx.QueryRow(ctx, `SELECT stream_type,stream_url,is_active FROM streams WHERE id=$1 AND retired_at IS NULL FOR UPDATE`, streamID).Scan(&kind, &rawURL, &active); errors.Is(err, pgx.ErrNoRows) {
		return VideoEvidence{}, ErrNotFound
	} else if err != nil {
		return VideoEvidence{}, err
	}
	if !active || kind != StreamTypeHLS {
		return VideoEvidence{}, fmt.Errorf("%w: capture requires an active HLS camera", ErrConflict)
	}
	fingerprint := sourceFingerprint(Stream{StreamType: kind, StreamURL: rawURL})
	var version int
	var reference int64
	var raw []byte
	if err = tx.QueryRow(ctx, `SELECT version,reference_id,definition FROM counting_profiles WHERE id=$1 AND stream_id=$2 AND source_fingerprint=$3`, profileID, streamID, fingerprint).Scan(&version, &reference, &raw); errors.Is(err, pgx.ErrNoRows) {
		return VideoEvidence{}, fmt.Errorf("%w: select a rule version for the current source", ErrConflict)
	} else if err != nil {
		return VideoEvidence{}, err
	}
	var definition CountingDefinition
	if err = json.Unmarshal(raw, &definition); err != nil {
		return VideoEvidence{}, err
	}
	snapshot := CountingSnapshot{Mode: "versioned", ProfileID: &profileID, Version: &version, ReferenceID: &reference, SourceFingerprint: fingerprint, Definition: &definition, PublishedTitle: definition.Label, IntervalConvention: "[start,end)"}
	rules, _ := json.Marshal(snapshot)
	quality, _ := json.Marshal(emptyEvidenceQuality())
	actor, _ := currentUser(ctx)
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO video_evidence(stream_id,profile_id,source_fingerprint,counting_rules,status,requested_seconds,quality,created_by) VALUES($1,$2,$3,$4,'queued',$5,$6,$7) RETURNING id`, streamID, profileID, fingerprint, rules, seconds, quality, actor.ID).Scan(&id)
	if err == nil {
		err = auditTx(ctx, tx, "video.capture_queued", "video_evidence", id, map[string]any{"streamId": streamID, "profileId": profileID, "seconds": seconds})
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return VideoEvidence{}, err
	}
	return api.store.VideoEvidence(ctx, id)
}
func (api *API) handleVideoEvidence(w http.ResponseWriter, r *http.Request) {
	if !api.cfg.VideoEvidenceEnabled {
		writeError(w, http.StatusServiceUnavailable, "video_evidence_disabled", "Retained video capture and playback are currently disabled.")
		return
	}
	if r.URL.RawPath != "" {
		writeStoreError(w, ErrInvalid)
		return
	}
	if r.URL.Path == "/api/admin/video-evidence" {
		if r.Method == http.MethodPost {
			if r.URL.RawQuery != "" {
				writeStoreError(w, ErrInvalid)
				return
			}
			var input struct {
				StreamID        int64 `json:"streamId"`
				ProfileID       int64 `json:"profileId"`
				DurationSeconds int   `json:"durationSeconds"`
			}
			if !decodeJSON(w, r, &input) {
				return
			}
			value, err := api.createVideoEvidence(r.Context(), input.StreamID, input.ProfileID, input.DurationSeconds)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, 201, value)
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		before, err := pageBefore(r)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		rows, err := api.store.pool.Query(r.Context(), `SELECT `+evidenceColumns+` FROM video_evidence e JOIN streams s ON s.id=e.stream_id WHERE ($1::bigint=0 OR e.id<$1) AND NOT EXISTS(SELECT 1 FROM video_evidence_retirements r WHERE r.evidence_id=e.id) ORDER BY e.id DESC LIMIT 21`, before)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		defer rows.Close()
		items := []VideoEvidence{}
		for rows.Next() {
			v, err := scanVideoEvidence(rows)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			items = append(items, v)
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
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/video-evidence/"), "/")
	if len(parts) < 1 || len(parts) > 2 || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	id, err := parseID(parts[0])
	if err != nil {
		writeStoreError(w, ErrInvalid)
		return
	}
	if len(parts) == 2 && parts[1] == "annotation" {
		api.handleEvidenceAnnotation(w, r, id)
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	value, err := api.store.VideoEvidence(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if len(parts) == 1 {
		writeJSON(w, 200, value)
		return
	}
	if parts[1] != "clip.mp4" {
		http.NotFound(w, r)
		return
	}
	if value.Status != "ready" || value.ClipSHA256 == nil {
		writeStoreError(w, ErrConflict)
		return
	}
	folder, err := evidenceFolder(id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	path := filepath.Join(folder, "clip.mp4")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		writeStoreError(w, ErrNotFound)
		return
	}
	if err := verifyRetainedClip(r.Context(), value); err != nil {
		writeStoreError(w, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="evidence-%d.mp4"`, id))
	w.Header().Set("ETag", `"`+*value.ClipSHA256+`"`)
	http.ServeContent(w, r, "clip.mp4", info.ModTime(), file)
}
func (api *API) ServeEvidenceCapture(ctx context.Context) {
	if !api.cfg.VideoEvidenceEnabled {
		return
	}
	// Only one owner across API replicas may claim captures or interrupt stale
	// jobs. Holding this session lock also makes crash/restart ownership explicit.
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		conn, err := api.store.pool.Acquire(ctx)
		if err != nil {
			return
		}
		var locked bool
		err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(93741528)`).Scan(&locked)
		if err != nil || !locked {
			if err != nil {
				// A cancelled query may have acquired the session lock before its
				// result was lost. Never return that connection to the pool.
				_ = conn.Conn().Close(context.Background())
			}
			conn.Release()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			}
		}
		_, err = conn.Exec(ctx, `UPDATE video_evidence SET status='interrupted',error_code='capture_process_restarted',completed_at=now() WHERE status IN ('capturing','processing')`)
		if err == nil {
			for ctx.Err() == nil {
				var id int64
				err = conn.QueryRow(ctx, `UPDATE video_evidence SET status='capturing' WHERE id=(SELECT id FROM video_evidence WHERE status='queued' ORDER BY id LIMIT 1) RETURNING id`).Scan(&id)
				if err == nil {
					api.captureVideoEvidence(ctx, id)
					continue
				}
				if !errors.Is(err, pgx.ErrNoRows) {
					break
				}
				select {
				case <-ctx.Done():
				case <-ticker.C:
				}
			}
		}
		// Cleanup uses a short uncancelled context so a pooled connection never
		// carries a session advisory lock into unrelated API requests.
		releaseCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, unlockErr := conn.Exec(releaseCtx, `SELECT pg_advisory_unlock(93741528)`)
		cancel()
		if unlockErr != nil {
			_ = conn.Conn().Close(context.Background())
		}
		conn.Release()
	}
}

type evidencePlaylist struct {
	segments []EvidenceSegment
	tokens   []string
	target   float64
}

func parseEvidencePlaylist(body []byte) (evidencePlaylist, error) {
	observed, err := parseObservedPlaylist(body)
	if err != nil {
		return evidencePlaylist{}, err
	}
	result := evidencePlaylist{target: observed.target}
	var duration float64
	discontinuity := false
	index := 0
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "#EXT-X-DISCONTINUITY" {
			discontinuity = true
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			if duration != 0 {
				return result, ErrInvalid
			}
			value := strings.SplitN(strings.TrimPrefix(line, "#EXTINF:"), ",", 2)[0]
			duration, err = strconv.ParseFloat(value, 64)
			if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > 120 {
				return result, ErrInvalid
			}
		}
		if line != "" && !strings.HasPrefix(line, "#") {
			if index >= len(observed.segments) || duration <= 0 {
				return result, ErrInvalid
			}
			segment := observed.segments[index]
			result.segments = append(result.segments, EvidenceSegment{Sequence: segment.sequence, DurationSeconds: duration, Discontinuity: discontinuity})
			result.tokens = append(result.tokens, segment.token)
			duration = 0
			discontinuity = false
			index++
		}
	}
	if duration != 0 || discontinuity || len(result.segments) == 0 {
		return result, ErrInvalid
	}
	return result, nil
}
func waitEvidence(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (api *API) evidenceManifest(ctx context.Context, stream Stream) ([]byte, error) {
	select {
	case api.media.slots <- struct{}{}:
		defer func() { <-api.media.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return api.media.observerManifest(ctx, stream)
}
func (api *API) evidenceSegment(ctx context.Context, stream Stream, token string) ([]byte, error) {
	select {
	case api.media.slots <- struct{}{}:
		defer func() { <-api.media.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	resource, ok := api.media.resource(stream, token, time.Now())
	if !ok || resource.kind != mediaSegment {
		return nil, ErrInvalid
	}
	response, err := api.media.fetch(ctx, resource.upstream, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return mediaReadLimit(response.Body, mediaSegmentLimit)
}
func (api *API) captureVideoEvidence(parent context.Context, id int64) {
	value, err := api.store.VideoEvidence(parent, id)
	if err != nil {
		return
	}
	folder, err := evidenceFolder(id)
	if err == nil {
		err = os.MkdirAll(folder, 0700)
	}
	if err == nil {
		err = validateEvidencePath(folder)
	}
	if err != nil {
		api.finishEvidence(parent, id, "failed", "evidence_storage_unavailable", emptyEvidenceQuality(), 0, nil, 0)
		return
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(value.RequestedSeconds+90)*time.Second)
	defer cancel()
	segments := []EvidenceSegment{}
	var last *int64
	var receivedBytes int64
	var declared float64
	captureIssue := ""
	diagnostics := EvidenceCaptureDiagnostics{}
	start := time.Now()
	for ctx.Err() == nil && declared < float64(value.RequestedSeconds) && len(segments) < 128 {
		stream, err := api.store.GetStream(ctx, value.StreamID)
		if err != nil || !stream.IsActive || sourceFingerprint(stream) != value.CountingRules.SourceFingerprint {
			captureIssue = "source_changed_or_archived"
			break
		}
		diagnostics.ManifestPolls++
		body, err := api.evidenceManifest(ctx, stream)
		if err != nil {
			diagnostics.ManifestFailures++
			if !waitEvidence(ctx, 2*time.Second) {
				break
			}
			continue
		}
		playlist, err := parseEvidencePlaylist(body)
		if err != nil {
			captureIssue = "unsupported_capture_packaging"
			break
		}
		if last == nil {
			latest := playlist.segments[len(playlist.segments)-1].Sequence - 1
			last = &latest
		}
		if playlist.segments[len(playlist.segments)-1].Sequence < *last {
			captureIssue = "sequence_restart"
			break
		}
		for index, segment := range playlist.segments {
			if segment.Sequence <= *last {
				continue
			}
			var payload []byte
			var fetchErr error
			for retry := 0; retry < 3; retry++ {
				diagnostics.SegmentAttempts++
				payload, fetchErr = api.evidenceSegment(ctx, stream, playlist.tokens[index])
				if fetchErr == nil {
					break
				}
				diagnostics.SegmentFailures++
				if errors.Is(fetchErr, ErrInvalid) {
					diagnostics.InvalidHandles++
				}
				if !waitEvidence(ctx, time.Duration(retry+1)*500*time.Millisecond) {
					break
				}
			}
			if fetchErr != nil {
				break
			}
			if len(payload) == 0 || receivedBytes+int64(len(payload)) > 512<<20 {
				captureIssue = "capture_storage_budget_exceeded"
				break
			}
			name := fmt.Sprintf("%06d.ts", len(segments)+1)
			file, err := os.OpenFile(filepath.Join(folder, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				captureIssue = "capture_file_write_failed"
				break
			}
			_, err = file.Write(payload)
			closeErr := file.Close()
			if err != nil || closeErr != nil {
				captureIssue = "capture_file_write_failed"
				break
			}
			hash := sha256.Sum256(payload)
			segment.File = name
			segment.SHA256 = hex.EncodeToString(hash[:])
			segment.ReceivedAt = time.Now().UTC()
			segments = append(segments, segment)
			receivedBytes += int64(len(payload))
			declared += segment.DurationSeconds
			v := segment.Sequence
			last = &v
			quality := emptyEvidenceQuality()
			diagnostics.CaptureWallMS = time.Since(start).Milliseconds()
			quality.CaptureDiagnostics = &diagnostics
			quality.Segments = segments
			quality.SegmentCount = len(segments)
			raw, _ := json.Marshal(quality)
			_, err = api.store.pool.Exec(ctx, `UPDATE video_evidence SET byte_count=$2,quality=$3 WHERE id=$1 AND status='capturing'`, id, receivedBytes, raw)
			if err != nil {
				captureIssue = "capture_progress_write_failed"
				break
			}
			if declared >= float64(value.RequestedSeconds) {
				break
			}
		}
		if captureIssue != "" {
			break
		}
		if !waitEvidence(ctx, 2*time.Second) {
			break
		}
	}
	if parent.Err() != nil {
		return
	}
	diagnostics.CaptureWallMS = time.Since(start).Milliseconds()
	if len(segments) == 0 {
		quality := emptyEvidenceQuality()
		quality.CaptureDiagnostics = &diagnostics
		api.finishEvidence(parent, id, "failed", "no_video_captured", quality, 0, nil, receivedBytes)
		return
	}
	_, err = api.store.pool.Exec(parent, `UPDATE video_evidence SET status='processing' WHERE id=$1 AND status='capturing'`, id)
	if err != nil {
		return
	}
	decodeCtx, decodeCancel := context.WithTimeout(parent, 5*time.Minute)
	processingStart := time.Now()
	quality, duration, hash, err := analyzeRetainedVideo(decodeCtx, videoDecoderPath(), folder, segments)
	decodeCancel()
	diagnostics.ProcessingMS = time.Since(processingStart).Milliseconds()
	quality.CaptureDiagnostics = &diagnostics
	if captureIssue != "" || declared < float64(value.RequestedSeconds) {
		if captureIssue == "" {
			captureIssue = "capture_window_incomplete"
		}
		quality.Issues = append(quality.Issues, captureIssue)
		quality.RelativeCoverageComplete = false
	}
	if err != nil {
		quality.Issues = append(quality.Issues, "decoder_or_mux_failed")
		api.finishEvidence(parent, id, "failed", "decoder_or_mux_failed", quality, duration, nil, receivedBytes)
		return
	}
	quality.Issues = append(quality.Issues, fmt.Sprintf("capture_job_wall_seconds_%d_not_capture_utc", int(time.Since(start).Seconds())))
	clipInfo, err := os.Stat(filepath.Join(folder, "clip.mp4"))
	if err == nil {
		receivedBytes += clipInfo.Size()
	}
	api.finishEvidence(parent, id, "ready", "", quality, duration, &hash, receivedBytes)
}
func (api *API) finishEvidence(ctx context.Context, id int64, status, code string, quality EvidenceQuality, duration int64, hash *string, bytes int64) {
	raw, _ := json.Marshal(quality)
	_, _ = api.store.pool.Exec(ctx, `UPDATE video_evidence SET status=$2,error_code=$3,quality=$4,duration_ms=$5,clip_sha256=$6,byte_count=$7,completed_at=now() WHERE id=$1 AND status IN ('capturing','processing')`, id, status, code, raw, duration, hash, bytes)
}
