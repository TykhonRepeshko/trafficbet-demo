package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func preparationDefinition() CountingDefinition {
	return CountingDefinition{Label: "Cross the marked line", LineStart: CountingPoint{.1, .5}, LineEnd: CountingPoint{.9, .5}, Directions: []string{"A_to_B", "B_to_A"}, Classes: []string{"car", "truck"}, Anchor: "bottom_center", TimeBasis: "capture_utc", Notes: "Include both lanes; exclude parked vehicles and uncertain crossings."}
}
func preparationPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 64, 40))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestCountingDefinitionRejectsAmbiguousGeometryAndPolicy(t *testing.T) {
	if !validCountingDefinition(preparationDefinition()) {
		t.Fatal("valid rule rejected")
	}
	cases := []func(*CountingDefinition){func(d *CountingDefinition) { d.LineStart.X = math.NaN() }, func(d *CountingDefinition) { d.LineStart.Y = math.Inf(1) }, func(d *CountingDefinition) { d.LineEnd = d.LineStart }, func(d *CountingDefinition) { d.LineEnd.X = 1.1 }, func(d *CountingDefinition) { d.Classes = []string{"car", "car"} }, func(d *CountingDefinition) { d.Directions = []string{"north"} }, func(d *CountingDefinition) { d.TimeBasis = "receipt_utc" }, func(d *CountingDefinition) { d.Anchor = "unspecified" }, func(d *CountingDefinition) { d.Notes = "x\n" + strings.Repeat("a", 30) }}
	for i, change := range cases {
		d := preparationDefinition()
		change(&d)
		if validCountingDefinition(d) {
			t.Errorf("accepted invalid case %d", i)
		}
	}
}
func TestCountingReferenceIsBoundedAndReencoded(t *testing.T) {
	valid := preparationPNG(t)
	valid = append(valid, []byte("trailing private metadata")...)
	result, w, h, err := normalizeReference(valid)
	if err != nil || w != 64 || h != 40 || bytes.Contains(result, []byte("metadata")) {
		t.Fatal("image was not normalized", err)
	}
	for _, body := range [][]byte{[]byte("not a PNG"), bytes.Repeat([]byte("x"), 1<<20+1), valid[:30]} {
		if _, _, _, err := normalizeReference(body); err == nil {
			t.Fatal("invalid reference accepted")
		}
	}
}
func TestObservationParserRequiresBoundedLiveSequences(t *testing.T) {
	good := "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:10,\n/api/media/streams/1/resource/example\n"
	p, err := parseObservedPlaylist([]byte(good))
	if err != nil || p.segments[0].sequence != 12 {
		t.Fatal(p, err)
	}
	for _, body := range []string{strings.ReplaceAll(good, "10\n#EXT-X-MEDIA", "NaN\n#EXT-X-MEDIA"), strings.ReplaceAll(good, "/api/media/streams/1/resource/example", "https://example.com/a.ts"), good + "#EXT-X-MEDIA-SEQUENCE:5\n", good + "#EXT-X-KEY:METHOD=AES-128\n", strings.ReplaceAll(good, "SEQUENCE:12", "SEQUENCE:-1")} {
		if _, err := parseObservedPlaylist([]byte(body)); err == nil {
			t.Fatal("unsafe observer playlist accepted")
		}
	}
}
func TestSourceObserverDetectsGapReplayStallRestartAndRecovery(t *testing.T) {
	seq := 10
	repeat := false
	fail := false
	discont := false
	g, _ := mediaTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".m3u8") {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:%d\n", seq)
			if discont {
				fmt.Fprintln(w, "#EXT-X-DISCONTINUITY")
			}
			for n := seq; n < seq+2; n++ {
				fmt.Fprintf(w, "#EXTINF:10,\ns%d.ts\n", n)
			}
			return
		}
		if fail {
			w.WriteHeader(502)
			return
		}
		w.Header().Set("Content-Type", "video/mp2t")
		if repeat {
			fmt.Fprint(w, "same segment")
		} else {
			fmt.Fprint(w, r.URL.Path)
		}
	}))
	stream := Stream{ID: 7, StreamType: StreamTypeHLS, StreamURL: "https://example.com/index.m3u8"}
	now := time.Now().UTC()
	observe := func(prior *SourceObservation) SourceObservation {
		report := g.observeSource(context.Background(), stream, prior, now)
		if report.CaptureTimeTrusted || report.FullCoverageProven || report.FramesDecoded || report.FramingVerified {
			t.Fatal("transport probe invented frame/timing proof")
		}
		return SourceObservation{SourceFingerprint: sourceFingerprint(stream), ObservedAt: now, Report: report}
	}
	first := observe(nil)
	if first.Report.Status != "advancing" || first.Report.FetchedSegments != 2 {
		t.Fatal(first)
	}
	now = now.Add(60 * time.Second)
	stalled := observe(&first)
	if stalled.Report.Status != "stalled" {
		t.Fatal(stalled)
	}
	seq = 15
	gap := observe(&stalled)
	if gap.Report.MissingSequences != 3 || gap.Report.Status != "degraded" {
		t.Fatal(gap)
	}
	seq = 17
	repeat = true
	replay := observe(&gap)
	if replay.Report.ReplayedSegments != 1 {
		t.Fatal(replay)
	}
	seq = 19
	fail = true
	failed := observe(&replay)
	if failed.Report.LastSequence == nil || *failed.Report.LastSequence != 18 || failed.Report.Status != "degraded" {
		t.Fatal(failed)
	}
	fail = false
	repeat = false
	recovered := observe(&failed)
	if recovered.Report.Status != "advancing" {
		t.Fatal(recovered)
	}
	seq = 1
	discont = true
	restart := observe(&recovered)
	if restart.Report.Status != "degraded" || !restart.Report.Discontinuity {
		t.Fatal(restart)
	}
}
func TestPostgresCountingSnapshotsAndReviewGate(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "prep-admin@example.test", RoleAdmin, 0)
	ctx = context.WithValue(ctx, userContextKey, admin)
	stream := integrationStream(t, s, ctx)
	old := integrationMarket(t, s, ctx, stream.ID)
	ref, err := s.SaveCountingReference(ctx, stream.ID, preparationPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	p1, err := s.SaveCountingProfile(ctx, stream.ID, ref.ID, preparationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApproveCountingProfile(ctx, stream.ID, p1.ID, "Checked the reference image and exact marked road line."); err != nil {
		t.Fatal(err)
	}
	current := integrationMarket(t, s, ctx, stream.ID)
	rule := preparationDefinition()
	rule.Label = "Second version"
	p2, err := s.SaveCountingProfile(ctx, stream.ID, ref.ID, rule)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Version != 2 {
		t.Fatal("versions not serialized")
	}
	if err = s.ApproveCountingProfile(ctx, stream.ID, p2.ID, "Checked the changed counting instructions for future rounds."); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		id      int64
		profile *int64
	}{{old.ID, nil}, {current.ID, &p1.ID}} {
		d, err := s.RoundReviewDetail(ctx, entry.id)
		if err != nil {
			t.Fatal(err)
		}
		if entry.profile == nil {
			if d.Snapshot.ProfileID != nil {
				t.Fatal("historical rules changed")
			}
		} else if d.Snapshot.ProfileID == nil || *d.Snapshot.ProfileID != *entry.profile || d.Snapshot.SourceFingerprint != sourceFingerprint(stream) {
			t.Fatal("published snapshot changed", d.Snapshot)
		}
	}
	for _, query := range []string{`UPDATE counting_profiles SET definition='{}' WHERE id=$1`, `DELETE FROM counting_references WHERE id=$1`, `UPDATE round_counting_snapshots SET snapshot='{}' WHERE market_id=$1`} {
		id := p1.ID
		if strings.Contains(query, "references") {
			id = ref.ID
		}
		if strings.Contains(query, "snapshots") {
			id = current.ID
		}
		if _, err = s.pool.Exec(ctx, query, id); err == nil {
			t.Fatal("mutable counting evidence", query)
		}
	}
	// Advance only the isolated fixture, never the saved application database.
	if _, err = s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, current.ID); err != nil {
		t.Fatal(err)
	}
	count := 12
	verification := SettlementVerification{CaptureTimeVerified: true, CoverageVerified: true, FramingVerified: true, EvidenceNote: "Synthetic isolated fixture with fully checked evidence."}
	if _, err = s.SettleMarket(ctx, current.ID, count, verification); !errors.Is(err, ErrConflict) {
		t.Fatal("unreviewed version settled", err)
	}
	review := RoundReview{Outcome: "verified", ProposedCount: &count, Verification: verification, EvidenceNote: verification.EvidenceNote}
	if _, err = s.SaveRoundReview(ctx, current.ID, review); !errors.Is(err, ErrConflict) {
		t.Fatal("checkbox-only UTC review accepted", err)
	}
	evidenceID := preparationUTCEvidenceFixture(t, s, ctx, current.ID, nil)
	review.EvidenceID = &evidenceID
	if _, err = s.SaveRoundReview(ctx, current.ID, review); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SettleMarket(ctx, current.ID, 13, verification); !errors.Is(err, ErrConflict) {
		t.Fatal("mismatched reviewed count settled", err)
	}
	if _, err = s.SettleMarket(ctx, current.ID, count, verification); err != nil {
		t.Fatal(err)
	}
	stream.StreamURL = "/media/changed/index.m3u8"
	if _, err = s.UpdateStream(ctx, stream); err != nil {
		t.Fatal(err)
	}
	if err = s.ApproveCountingProfile(ctx, stream.ID, p1.ID, "Attempt approval after source identity has changed."); !errors.Is(err, ErrConflict) {
		t.Fatal("stale profile approved", err)
	}
}

type preparationUTCFixture struct {
	streamID, profileID, durationMS int64
	fingerprint                     string
	snapshot                        CountingSnapshot
	quality                         EvidenceQuality
}

// Explicit synthetic trusted-clock metadata exists only inside isolated test
// schemas. The running public feeds and saved application data are never given
// a fabricated capture-time anchor by this fixture.
func preparationUTCEvidenceFixture(t *testing.T, s *Store, ctx context.Context, marketID int64, change func(*preparationUTCFixture)) int64 {
	t.Helper()
	detail, err := s.RoundReviewDetail(ctx, marketID)
	if err != nil {
		t.Fatal(err)
	}
	start := detail.Market.WindowStart.Add(-time.Second)
	fixture := preparationUTCFixture{streamID: detail.Market.StreamID, profileID: *detail.Snapshot.ProfileID, durationMS: detail.Market.WindowEnd.Sub(start).Milliseconds() + 1000, fingerprint: detail.Snapshot.SourceFingerprint, snapshot: detail.Snapshot, quality: EvidenceQuality{FramesDecoded: true, RelativeCoverageComplete: true, CaptureTimeTrusted: true, CaptureStart: &start, TimingBasis: "media_relative", FramingStatus: "stable_sampled", SegmentCount: 2, DecodedFrames: 100, Issues: []string{}, MissingSequences: []int64{}, PTSGaps: []EvidenceGap{}}}
	if change != nil {
		change(&fixture)
	}
	rules, _ := json.Marshal(fixture.snapshot)
	quality, _ := json.Marshal(fixture.quality)
	actor, _ := currentUser(ctx)
	content := []byte("SYNTHETIC UTC SETTLEMENT HASH CONTRACT ONLY; NOT REAL VIDEO OR CAMERA TRUTH")
	digest := sha256.Sum256(content)
	var id int64
	err = s.pool.QueryRow(ctx, `INSERT INTO video_evidence(stream_id,profile_id,source_fingerprint,counting_rules,status,requested_seconds,duration_ms,clip_sha256,byte_count,quality,created_by,completed_at) VALUES($1,$2,$3,$4,'ready',60,$5,$6,$7,$8,$9,now()) RETURNING id`, fixture.streamID, fixture.profileID, fixture.fingerprint, rules, fixture.durationMS, hex.EncodeToString(digest[:]), len(content), quality, actor.ID).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("EVIDENCE_DIRECTORY", t.TempDir())
	folder, err := evidenceFolder(id)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(folder, "clip.mp4"), content, 0600); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPostgresVersionedUTCRoundRequiresBoundCaptureEvidence(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "utc-round-admin@example.test", RoleAdmin, 500)
	ctx = context.WithValue(ctx, userContextKey, admin)
	stream := integrationStream(t, s, ctx)
	ref, err := s.SaveCountingReference(ctx, stream.ID, preparationPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	profile, err := s.SaveCountingProfile(ctx, stream.ID, ref.ID, preparationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.ApproveCountingProfile(ctx, stream.ID, profile.ID, "Synthetic isolated test approval, never camera calibration."); err != nil {
		t.Fatal(err)
	}
	market := integrationMarket(t, s, ctx, stream.ID)
	if _, err = s.pool.Exec(ctx, `UPDATE bet_markets SET betting_closes_at=now()-interval '3 minutes',window_start=now()-interval '2 minutes',window_end=now()-interval '1 minute' WHERE id=$1`, market.ID); err != nil {
		t.Fatal(err)
	}
	count := 12
	verification := verifiedSettlementFixture()
	review := RoundReview{Outcome: "verified", ProposedCount: &count, Verification: verification, EvidenceNote: "Synthetic isolated UTC evidence review; no actual source clock is asserted."}
	if _, err = s.SaveRoundReview(ctx, market.ID, review); !errors.Is(err, ErrConflict) {
		t.Fatal("unbound versioned review accepted", err)
	}
	// A review written before the stricter evidence gate must not bypass the
	// settlement recheck, even if its booleans and proposed count are complete.
	rawVerification, _ := json.Marshal(verification)
	if _, err = s.pool.Exec(ctx, `INSERT INTO round_reviews(market_id,outcome,proposed_count,verification,evidence_note,created_by) VALUES($1,'verified',$2,$3,$4,$5)`, market.ID, count, rawVerification, review.EvidenceNote, admin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SettleMarket(ctx, market.ID, count, verification); !errors.Is(err, ErrConflict) {
		t.Fatal("historical unbound review bypassed UTC gate", err)
	}
	other, err := s.SaveCountingProfile(ctx, stream.ID, ref.ID, preparationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name   string
		change func(*preparationUTCFixture)
	}{
		{"unknown capture clock", func(f *preparationUTCFixture) { f.quality.CaptureTimeTrusted = false; f.quality.CaptureStart = nil }},
		{"missing UTC anchor", func(f *preparationUTCFixture) { f.quality.CaptureStart = nil }},
		{"incomplete decoded coverage", func(f *preparationUTCFixture) {
			f.quality.RelativeCoverageComplete = false
			f.quality.MissingSequences = []int64{12}
		}},
		{"no decoded frames", func(f *preparationUTCFixture) { f.quality.FramesDecoded = false }},
		{"PTS gap", func(f *preparationUTCFixture) {
			f.quality.PTSGaps = []EvidenceGap{{AfterSequence: 1, BeforeSequence: 2, Seconds: .04}}
		}},
		{"short coverage", func(f *preparationUTCFixture) { f.durationMS = 1000 }},
		{"duration overflow", func(f *preparationUTCFixture) { f.durationMS = math.MaxInt64 }},
		{"wrong rule version", func(f *preparationUTCFixture) { f.profileID = other.ID; f.snapshot.ProfileID = &other.ID }},
		{"wrong source", func(f *preparationUTCFixture) { f.fingerprint = strings.Repeat("b", 64) }},
		{"suspected camera movement", func(f *preparationUTCFixture) { f.quality.FramingStatus = "suspected_change" }},
		{"unknown framing", func(f *preparationUTCFixture) { f.quality.FramingStatus = "unverified" }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			id := preparationUTCEvidenceFixture(t, s, ctx, market.ID, tt.change)
			input := review
			input.EvidenceID = &id
			if _, err := s.SaveRoundReview(ctx, market.ID, input); !errors.Is(err, ErrConflict) {
				t.Fatal("unverified capture evidence accepted", err)
			}
		})
	}
	id := preparationUTCEvidenceFixture(t, s, ctx, market.ID, func(f *preparationUTCFixture) {
		detail, err := s.RoundReviewDetail(ctx, market.ID)
		if err != nil {
			t.Fatal(err)
		}
		start := detail.Market.WindowStart
		f.quality.CaptureStart = &start
		f.durationMS = detail.Market.WindowEnd.Sub(start).Milliseconds()
	})
	review.EvidenceID = &id
	if _, err = s.SaveRoundReview(ctx, market.ID, review); err != nil {
		t.Fatal("exact full UTC coverage refused", err)
	}
	detail, err := s.RoundReviewDetail(ctx, market.ID)
	if err != nil || len(detail.Reviews) < 1 || detail.Reviews[0].EvidenceID == nil || *detail.Reviews[0].EvidenceID != id {
		t.Fatal("retained review binding was not preserved", err)
	}
	folder, err := evidenceFolder(id)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "clip.mp4")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	modified := append([]byte(nil), content...)
	modified[0] ^= 1
	if err = os.WriteFile(path, modified, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SettleMarket(ctx, market.ID, count, verification); !errors.Is(err, ErrConflict) {
		t.Fatal("changed retained bytes bypassed settlement recheck", err)
	}
	if err = os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SettleMarket(ctx, market.ID, count, verification); err != nil {
		t.Fatal("trusted isolated evidence settlement refused", err)
	}
	user, err := s.GetUserByID(ctx, admin.ID)
	if err != nil || user.BalanceCredits != 500 {
		t.Fatal("evidence-only fixture changed credits", err)
	}
}
func TestPostgresPreparationHTTPPermissionsAndPrivacy(t *testing.T) {
	s, ctx := integrationStore(t, true)
	admin := integrationUser(t, s, ctx, "prep-http@example.test", RoleAdmin, 0)
	user := integrationUser(t, s, ctx, "prep-member@example.test", RoleUser, 0)
	stream := integrationStream(t, s, ctx)
	handler := NewAPI(s, Config{FrontendOrigin: "http://localhost:4200"}).Routes()
	cookies := []*http.Cookie{nil, nil, nil}
	for i, actor := range []User{admin, user} {
		token, _ := newSessionToken()
		if err := s.CreateSession(ctx, actor.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
		cookies[i] = &http.Cookie{Name: sessionCookieName, Value: token}
	}
	for _, path := range []string{fmt.Sprintf("/api/admin/preparation/%d", stream.ID), "/api/admin/source-health", "/api/admin/round-review", "/api/admin/audit"} {
		for i, cookie := range cookies {
			w := accountTestRequest(handler, "GET", path, "", cookie)
			want := 200
			if i == 1 {
				want = 403
			}
			if i == 2 {
				want = 401
			}
			if w.Code != want {
				t.Fatalf("%s role %d: %d %s", path, i, w.Code, w.Body.String())
			}
			if i == 0 {
				var data any
				if json.Unmarshal(w.Body.Bytes(), &data) != nil || strings.Contains(w.Body.String(), stream.StreamURL) {
					t.Fatal("private source URL leaked")
				}
			}
		}
	}
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/admin/preparation/%d/profiles", stream.ID), strings.NewReader(`{}`))
	r.AddCookie(cookies[0])
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin mutation permitted", w.Code)
	}
}
