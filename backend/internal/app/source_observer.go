package app

// Transport observations are evidence about delivery, never a claim that every
// video frame was decoded, the scene stayed fixed, or capture UTC was trusted.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type SourceQualityReport struct {
	Kind               string     `json:"kind"`
	Status             string     `json:"status"`
	Issues             []string   `json:"issues"`
	FirstSequence      *int64     `json:"firstSequence,omitempty"`
	LastSequence       *int64     `json:"lastSequence,omitempty"`
	LastAdvanceAt      *time.Time `json:"lastAdvanceAt,omitempty"`
	TargetSeconds      float64    `json:"targetSeconds"`
	FetchedSegments    int        `json:"fetchedSegments"`
	MissingSequences   int64      `json:"missingSequences"`
	ReplayedSegments   int        `json:"replayedSegments"`
	Discontinuity      bool       `json:"discontinuity"`
	ProgramDateTime    *time.Time `json:"programDateTime,omitempty"`
	SegmentHashes      []string   `json:"segmentHashes"`
	CaptureTimeTrusted bool       `json:"captureTimeTrusted"`
	FullCoverageProven bool       `json:"fullCoverageProven"`
	FramesDecoded      bool       `json:"framesDecoded"`
	FramingVerified    bool       `json:"framingVerified"`
}
type SourceObservation struct {
	ID                int64               `json:"id"`
	StreamID          int64               `json:"streamId"`
	SourceFingerprint string              `json:"sourceFingerprint"`
	ObservedAt        time.Time           `json:"observedAt"`
	Report            SourceQualityReport `json:"report"`
}
type observedSegment struct {
	sequence int64
	token    string
}
type observedPlaylist struct {
	segments      []observedSegment
	target        float64
	discontinuity bool
	pdt           *time.Time
}

func parseObservedPlaylist(body []byte) (observedPlaylist, error) {
	p := observedPlaylist{}
	var seq int64
	sequenceSet := false
	for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			if sequenceSet {
				return p, ErrInvalid
			}
			value, err := strconv.ParseInt(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64)
			if err != nil || value < 0 || value > 1<<53 {
				return p, ErrInvalid
			}
			seq = value
			sequenceSet = true
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			value, err := strconv.ParseFloat(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:"), 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 1 || value > 120 {
				return p, ErrInvalid
			}
			p.target = value
		case strings.HasPrefix(line, "#EXT-X-KEY:"), strings.HasPrefix(line, "#EXT-X-MAP:"), strings.HasPrefix(line, "#EXT-X-BYTERANGE:"), strings.HasPrefix(line, "#EXT-X-PART:"):
			return p, fmt.Errorf("unsupported observer packaging")
		case line == "#EXT-X-DISCONTINUITY":
			p.discontinuity = true
		case strings.HasPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:"):
			value, err := time.Parse(time.RFC3339Nano, strings.TrimPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:"))
			if err != nil {
				return p, ErrInvalid
			}
			if p.pdt == nil {
				p.pdt = &value
			}
		case line != "" && !strings.HasPrefix(line, "#"):
			if !sequenceSet || !strings.HasPrefix(line, "/api/media/streams/") || !strings.Contains(line, "/resource/") {
				return p, ErrInvalid
			}
			parts := strings.Split(line, "/")
			p.segments = append(p.segments, observedSegment{sequence: seq, token: parts[len(parts)-1]})
			seq++
		}
	}
	if p.target == 0 || len(p.segments) == 0 || len(p.segments) > 32 {
		return p, ErrInvalid
	}
	return p, nil
}
func (g *MediaGateway) observerManifest(ctx context.Context, stream Stream) ([]byte, error) {
	upstream, err := url.Parse(stream.StreamURL)
	if err != nil {
		return nil, ErrInvalid
	}
	for depth := 0; depth < 3; depth++ {
		response, err := g.fetch(ctx, upstream, "")
		if err != nil {
			return nil, err
		}
		body, err := mediaReadLimit(response.Body, mediaManifestLimit)
		response.Body.Close()
		if err != nil {
			return nil, err
		}
		body, err = g.rewriteManifest(stream, response.Request.URL, body, time.Now())
		if err != nil {
			return nil, err
		}
		if !strings.Contains(string(body), "#EXT-X-STREAM-INF:") {
			return body, nil
		}
		found := false
		for _, line := range strings.Split(string(body), "\n") {
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.Split(line, "/")
			resource, ok := g.resource(stream, parts[len(parts)-1], time.Now())
			if !ok || resource.kind != mediaManifest {
				return nil, ErrInvalid
			}
			upstream = resource.upstream
			found = true
			break
		}
		if !found {
			return nil, ErrInvalid
		}
	}
	return nil, ErrInvalid
}
func (g *MediaGateway) observeSource(ctx context.Context, stream Stream, previous *SourceObservation, now time.Time) SourceQualityReport {
	report := SourceQualityReport{Kind: "hls_transport_v1", Status: "initializing", Issues: []string{"capture_time_unverified", "framing_not_measured", "frames_not_decoded"}, SegmentHashes: []string{}}
	if previous != nil && previous.SourceFingerprint == sourceFingerprint(stream) {
		report.LastSequence = previous.Report.LastSequence
		report.LastAdvanceAt = previous.Report.LastAdvanceAt
		report.SegmentHashes = append(report.SegmentHashes, previous.Report.SegmentHashes...)
	}
	if stream.StreamType != StreamTypeHLS {
		report.Status = "unsupported"
		report.Issues = append(report.Issues, "hls_required")
		return report
	}
	body, err := g.observerManifest(ctx, stream)
	if err != nil {
		report.Status = "unavailable"
		report.Issues = append(report.Issues, "manifest_unavailable_or_invalid")
		return report
	}
	playlist, err := parseObservedPlaylist(body)
	if err != nil {
		report.Status = "unsupported"
		report.Issues = append(report.Issues, "observer_packaging_unsupported")
		return report
	}
	report.TargetSeconds = playlist.target
	report.Discontinuity = playlist.discontinuity
	report.ProgramDateTime = playlist.pdt
	first := playlist.segments[0].sequence
	last := playlist.segments[len(playlist.segments)-1].sequence
	report.FirstSequence = &first
	if playlist.discontinuity {
		report.Issues = append(report.Issues, "media_discontinuity")
	}
	if report.LastSequence != nil && last < *report.LastSequence {
		report.Issues = append(report.Issues, "sequence_regression_or_restart")
		report.LastSequence = nil
		report.SegmentHashes = nil
	}
	if report.LastSequence != nil && first > *report.LastSequence+1 {
		report.MissingSequences = first - *report.LastSequence - 1
		report.Issues = append(report.Issues, "missing_segments")
	}
	hashes := map[string]bool{}
	for _, h := range report.SegmentHashes {
		hashes[h] = true
	}
	for _, segment := range playlist.segments {
		if report.LastSequence != nil && segment.sequence <= *report.LastSequence {
			continue
		}
		if report.FetchedSegments >= 6 {
			report.Issues = append(report.Issues, "observation_budget_exceeded")
			break
		}
		resource, ok := g.resource(stream, segment.token, time.Now())
		if !ok || resource.kind != mediaSegment {
			report.Issues = append(report.Issues, "segment_handle_invalid")
			break
		}
		response, err := g.fetch(ctx, resource.upstream, "")
		if err != nil {
			report.Issues = append(report.Issues, "segment_unavailable")
			break
		}
		payload, err := mediaReadLimit(response.Body, mediaSegmentLimit)
		response.Body.Close()
		if err != nil {
			report.Issues = append(report.Issues, "segment_size_or_read_error")
			break
		}
		hash := sha256.Sum256(payload)
		encoded := hex.EncodeToString(hash[:])
		if hashes[encoded] {
			report.ReplayedSegments++
			report.Issues = append(report.Issues, "repeated_segment_content")
		}
		hashes[encoded] = true
		report.SegmentHashes = append(report.SegmentHashes, encoded)
		if len(report.SegmentHashes) > 64 {
			report.SegmentHashes = report.SegmentHashes[len(report.SegmentHashes)-64:]
		}
		v := segment.sequence
		report.LastSequence = &v
		report.FetchedSegments++
		stamp := now
		report.LastAdvanceAt = &stamp
	}
	report.Status = "advancing"
	if report.FetchedSegments == 0 {
		report.Status = "waiting"
		if report.LastAdvanceAt == nil || now.Sub(*report.LastAdvanceAt) > time.Duration(math.Max(45, 3*playlist.target)*float64(time.Second)) {
			report.Status = "stalled"
			report.Issues = append(report.Issues, "playlist_not_advancing")
		}
	}
	// The first three issues describe limitations of this transport-only probe.
	// Every additional issue is a delivery problem, including a read failure,
	// sequence restart or an exhausted observation budget.
	if len(report.Issues) > 3 && report.Status != "stalled" {
		report.Status = "degraded"
	}
	return report
}
func (s *Store) SourceObservations(ctx context.Context, id int64, start, end time.Time, limit int) ([]SourceObservation, error) {
	if limit < 1 || limit > 120 {
		return nil, ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT id,stream_id,source_fingerprint,observed_at,report FROM source_observations WHERE stream_id=$1 AND observed_at>=$2 AND observed_at<=$3 ORDER BY id DESC LIMIT $4`, id, start, end, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SourceObservation{}
	for rows.Next() {
		var v SourceObservation
		var raw []byte
		if err = rows.Scan(&v.ID, &v.StreamID, &v.SourceFingerprint, &v.ObservedAt, &raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v.Report); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}
func (api *API) observeCamera(ctx context.Context, stream Stream) error {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	tx, err := api.store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('source-observer:'||$1::text,0))`, strconv.FormatInt(stream.ID, 10)).Scan(&locked); err != nil || !locked {
		return err
	}
	select {
	case api.media.slots <- struct{}{}:
		defer func() { <-api.media.slots }()
	default:
		return nil
	}
	var previous SourceObservation
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT source_fingerprint,observed_at,report FROM source_observations WHERE stream_id=$1 ORDER BY id DESC LIMIT 1`, stream.ID).Scan(&previous.SourceFingerprint, &previous.ObservedAt, &raw)
	var prior *SourceObservation
	if err == nil {
		if err = json.Unmarshal(raw, &previous.Report); err != nil {
			return err
		}
		prior = &previous
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	fetchCtx, cancelFetch := context.WithTimeout(ctx, 20*time.Second)
	report := api.media.observeSource(fetchCtx, stream, prior, time.Now().UTC())
	cancelFetch()
	data, _ := json.Marshal(report)
	if _, err = tx.Exec(ctx, `INSERT INTO source_observations(stream_id,source_fingerprint,report) VALUES($1,$2,$3)`, stream.ID, sourceFingerprint(stream), data); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (api *API) ServeSourceObserver(ctx context.Context) {
	if !api.cfg.SourceObserverEnabled {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		streams, err := api.store.ListStreams(ctx, false)
		if err == nil {
			var group sync.WaitGroup
			jobs := make(chan struct{}, 2)
			for i, stream := range streams {
				if i >= 32 || ctx.Err() != nil {
					break
				}
				if stream.IsActive && stream.StreamType == StreamTypeHLS {
					select {
					case jobs <- struct{}{}:
					case <-ctx.Done():
						break
					}
					if ctx.Err() != nil {
						break
					}
					group.Add(1)
					go func(camera Stream) {
						defer group.Done()
						defer func() { <-jobs }()
						if err := api.observeCamera(ctx, camera); err != nil && ctx.Err() == nil {
							api.operations.ObserverFailures.Add(1)
						}
					}(stream)
				}
			}
			group.Wait()
		}
		// Only transient transport summaries expire. Immutable review notes remain.
		if ctx.Err() == nil {
			_, _ = api.store.pool.Exec(ctx, `DELETE FROM source_observations WHERE id IN(SELECT id FROM source_observations WHERE observed_at<now()-interval '7 days' ORDER BY id LIMIT 1000)`)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (api *API) handleSourceHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if r.URL.RawQuery != "" {
		writeStoreError(w, ErrInvalid)
		return
	}
	streams, err := api.store.ListStreams(r.Context(), true)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := []map[string]any{}
	for _, stream := range streams {
		observations, err := api.store.SourceObservations(r.Context(), stream.ID, time.Now().Add(-7*24*time.Hour), time.Now(), 1)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		var observation *SourceObservation
		if len(observations) > 0 {
			observation = &observations[0]
		}
		var profileID *int64
		err = api.store.pool.QueryRow(r.Context(), `SELECT c.profile_id FROM counting_selections c JOIN counting_profiles p ON p.id=c.profile_id WHERE c.stream_id=$1 AND p.source_fingerprint=$2`, stream.ID, sourceFingerprint(stream)).Scan(&profileID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeStoreError(w, err)
			return
		}
		items = append(items, map[string]any{"streamId": stream.ID, "title": stream.Title, "isActive": stream.IsActive, "sourceFingerprint": sourceFingerprint(stream), "profileId": profileID, "observation": observation})
	}
	writeJSON(w, 200, map[string]any{"asOf": time.Now().UTC(), "observerEnabled": api.cfg.SourceObserverEnabled, "cameras": items})
}
