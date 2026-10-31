package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVideoEvidenceDisabledAvoidsDatabaseAndStorage(t *testing.T) {
	api := &API{}
	root := filepath.Join(t.TempDir(), "unused-evidence")
	t.Setenv("EVIDENCE_DIRECTORY", root)
	for _, path := range []string{"/api/admin/video-evidence", "/api/admin/video-evidence/1", "/api/admin/video-evidence/1/clip.mp4", "/api/admin/video-evidence/1/annotation"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			w := httptest.NewRecorder()
			api.handleVideoEvidence(w, httptest.NewRequest(method, path, nil))
			if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "video_evidence_disabled") {
				t.Fatalf("disabled route %s %s returned %d", method, path, w.Code)
			}
		}
	}
	if _, err := api.createVideoEvidence(context.Background(), 1, 1, 30); err == nil {
		t.Fatal("disabled capture was accepted")
	}
	api.ServeEvidenceCapture(context.Background())
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("disabled capture created storage")
	}
}

func TestEvidencePlaylistRejectsAmbiguousAndRemoteInputs(t *testing.T) {
	good := "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:9.9,\n/api/media/streams/1/resource/a\n#EXT-X-DISCONTINUITY\n#EXTINF:10.1,\n/api/media/streams/1/resource/b\n"
	playlist, err := parseEvidencePlaylist([]byte(good))
	if err != nil || len(playlist.segments) != 2 || playlist.segments[0].Sequence != 42 || playlist.segments[1].Sequence != 43 || playlist.segments[0].DurationSeconds != 9.9 || !playlist.segments[1].Discontinuity {
		t.Fatalf("valid retained playlist rejected: %+v %v", playlist, err)
	}
	for _, tt := range []struct{ name, body string }{
		{"remote segment", strings.Replace(good, "/api/media/streams/1/resource/a", "https://example.com/video.ts", 1)},
		{"private segment", strings.Replace(good, "/api/media/streams/1/resource/a", "http://127.0.0.1/private", 1)},
		{"nonfinite duration", strings.Replace(good, "#EXTINF:9.9,", "#EXTINF:NaN,", 1)},
		{"infinite duration", strings.Replace(good, "#EXTINF:9.9,", "#EXTINF:+Inf,", 1)},
		{"zero duration", strings.Replace(good, "#EXTINF:9.9,", "#EXTINF:0,", 1)},
		{"negative sequence", strings.Replace(good, "SEQUENCE:42", "SEQUENCE:-1", 1)},
		{"missing duration", strings.Replace(good, "#EXTINF:9.9,\n", "", 1)},
		{"duplicate duration", strings.Replace(good, "#EXTINF:9.9,", "#EXTINF:9.9,\n#EXTINF:10,", 1)},
		{"dangling duration", good + "#EXTINF:10,\n"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseEvidencePlaylist([]byte(tt.body)); err == nil {
				t.Fatal("ambiguous or unsafe playlist accepted")
			}
		})
	}
}

func TestEvidencePathRefusesIntermediateLinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "camera-evidence")
	if err := os.Symlink(outside, link); err != nil {
		t.Log("Operating system did not allow a symlink fixture; link behavior is not verified on this host.")
		return
	}
	if validateEvidencePath(filepath.Join(link, "123", "clip.mp4")) == nil {
		t.Fatal("intermediate evidence symlink was accepted")
	}
}

type retainedEvidenceTest struct {
	store                                   *Store
	ctx                                     context.Context
	actorCtx                                context.Context
	api                                     *API
	handler                                 http.Handler
	admin, reviewer, member                 User
	adminCookie, reviewCookie, memberCookie *http.Cookie
	stream                                  Stream
	profile                                 CountingProfile
}

func newRetainedEvidenceTest(t *testing.T) retainedEvidenceTest {
	t.Helper()
	s, ctx := integrationStore(t, true)
	f := retainedEvidenceTest{store: s, ctx: ctx}
	f.admin = integrationUser(t, s, ctx, "evidence-author@example.test", RoleAdmin, 1000)
	f.reviewer = integrationUser(t, s, ctx, "evidence-reviewer@example.test", RoleAdmin, 500)
	f.member = integrationUser(t, s, ctx, "evidence-member@example.test", RoleUser, 200)
	f.actorCtx = context.WithValue(ctx, userContextKey, f.admin)
	f.stream = integrationStream(t, s, ctx)
	ref, err := s.SaveCountingReference(f.actorCtx, f.stream.ID, preparationPNG(t))
	if err != nil {
		t.Fatal(err)
	}
	f.profile, err = s.SaveCountingProfile(f.actorCtx, f.stream.ID, ref.ID, preparationDefinition())
	if err != nil {
		t.Fatal(err)
	}
	f.api = NewAPI(s, Config{FrontendOrigin: "http://localhost:4200", VideoEvidenceEnabled: true})
	f.handler = f.api.Routes()
	cookie := func(user User) *http.Cookie {
		token, _ := newSessionToken()
		if err := s.CreateSession(ctx, user.ID, sessionHash(token), time.Now().Add(time.Hour), ""); err != nil {
			t.Fatal(err)
		}
		return &http.Cookie{Name: sessionCookieName, Value: token}
	}
	f.adminCookie, f.reviewCookie, f.memberCookie = cookie(f.admin), cookie(f.reviewer), cookie(f.member)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_DECODER_PATH", executable) // Queue contract only; no decoder or capture worker is started.
	t.Setenv("EVIDENCE_DIRECTORY", t.TempDir())
	return f
}
func retainedFixtureDigest(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}
func (f retainedEvidenceTest) ready(t *testing.T, seed string, complete bool) VideoEvidence {
	return f.readyWithSegments(t, seed, complete, nil)
}
func (f retainedEvidenceTest) readyWithSegments(t *testing.T, seed string, complete bool, segments []EvidenceSegment) VideoEvidence {
	t.Helper()
	quality := EvidenceQuality{FramesDecoded: true, RelativeCoverageComplete: complete, TimingBasis: "media_relative", FramingStatus: "stable_sampled", SegmentCount: 2, DecodedFrames: 100, FirstPTS: 1.4, LastPTS: 5.36, Issues: []string{}}
	if segments == nil {
		segments = []EvidenceSegment{{Sequence: 1, SHA256: retainedFixtureDigest([]byte("synthetic-segment-one:" + seed)), DurationSeconds: 2}, {Sequence: 2, SHA256: retainedFixtureDigest([]byte("synthetic-segment-two:" + seed)), DurationSeconds: 2}}
	}
	quality.Segments = segments
	quality.SegmentCount = len(segments)
	if !complete {
		quality.Issues = []string{"missing_sequences"}
		quality.MissingSequences = []int64{22}
	}
	rule := preparationDefinition()
	version := f.profile.Version
	ref := f.profile.ReferenceID
	profile := f.profile.ID
	snapshot := CountingSnapshot{Mode: "versioned", ProfileID: &profile, Version: &version, ReferenceID: &ref, SourceFingerprint: sourceFingerprint(f.stream), Definition: &rule, PublishedTitle: rule.Label, IntervalConvention: "[start,end)"}
	rules, _ := json.Marshal(snapshot)
	report, _ := json.Marshal(quality)
	// Contract-test bytes only: no real video, decoded evidence or human labels
	// are manufactured. The integrity gate must still bind the actual file.
	content := []byte("SYNTHETIC-CONTRACT-TEST-NOT-REAL-VIDEO\nseed=" + seed + "\n")
	digest := retainedFixtureDigest(content)
	var id int64
	err := f.store.pool.QueryRow(f.ctx, `INSERT INTO video_evidence(stream_id,profile_id,source_fingerprint,counting_rules,status,requested_seconds,duration_ms,clip_sha256,byte_count,quality,created_by,completed_at) VALUES($1,$2,$3,$4,'ready',30,4000,$5,$6,$7,$8,now()) RETURNING id`, f.stream.ID, f.profile.ID, sourceFingerprint(f.stream), rules, digest, len(content), report, f.admin.ID).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
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
	value, err := f.store.VideoEvidence(f.ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func evidenceTestSend(t *testing.T, f retainedEvidenceTest, method, path string, input any, cookie *http.Cookie, status int) *httptest.ResponseRecorder {
	t.Helper()
	body := ""
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		body = string(raw)
	}
	w := accountTestRequest(f.handler, method, path, body, cookie)
	if w.Code != status {
		t.Fatalf("%s %s: got %d want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	return w
}
func evidenceTestAnnotation() map[string]any {
	return map[string]any{"split": "tuning", "condition": "night", "timingEvidence": "Synthetic isolated fixture has relative media time; capture UTC is unknown.", "note": "Synthetic contract test only, not part of the real annotated dataset.", "crossings": []ManualCrossing{{Track: "fixture-car", OffsetMS: 100, Direction: "A_to_B", Class: "car"}}, "provenance": "assistant_assisted"}
}
func TestPostgresRetiredEvidenceStaysHistoricalAndUnavailable(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	evidence := f.ready(t, "retired-fixture", true)
	if _, err := f.store.pool.Exec(f.ctx, `INSERT INTO video_evidence_retirements(evidence_id,reason,retired_by) VALUES($1,'Operator released retained video storage',$2)`, evidence.ID, f.admin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.VideoEvidence(f.ctx, evidence.ID); err != ErrNotFound {
		t.Fatalf("retired capture remained readable: %v", err)
	}
	evidenceTestSend(t, f, "GET", fmt.Sprintf("/api/admin/video-evidence/%d/clip.mp4", evidence.ID), nil, f.adminCookie, 404)
	evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/video-evidence/%d/annotation", evidence.ID), evidenceTestAnnotation(), f.adminCookie, 404)
	page := evidenceTestSend(t, f, "GET", "/api/admin/video-evidence", nil, f.adminCookie, 200)
	var list struct {
		Items []VideoEvidence `json:"items"`
	}
	if err := json.Unmarshal(page.Body.Bytes(), &list); err != nil || len(list.Items) != 0 {
		t.Fatal("retired capture remained in available footage")
	}
	for _, query := range []string{`UPDATE video_evidence_retirements SET reason='Rewritten history' WHERE evidence_id=$1`, `DELETE FROM video_evidence_retirements WHERE evidence_id=$1`, `UPDATE video_evidence SET duration_ms=1 WHERE id=$1`} {
		if _, err := f.store.pool.Exec(f.ctx, query, evidence.ID); err == nil {
			t.Fatal("retirement or capture history was mutable")
		}
	}
	var preserved int
	if err := f.store.pool.QueryRow(f.ctx, `SELECT count(*) FROM video_evidence WHERE id=$1`, evidence.ID).Scan(&preserved); err != nil || preserved != 1 {
		t.Fatal("retirement removed the original evidence record")
	}
	queued, err := f.api.createVideoEvidence(f.actorCtx, f.stream.ID, f.profile.ID, 30)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.pool.Exec(f.ctx, `INSERT INTO video_evidence_retirements(evidence_id,reason) VALUES($1,'Cannot retire an unfinished job')`, queued.ID); err == nil {
		t.Fatal("active capture could be retired")
	}
}

func TestPostgresRetainedEvidenceRolesQueueAndIdentity(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	for _, path := range []string{"/api/admin/video-evidence", "/api/admin/video-evidence/1", "/api/admin/video-evidence/1/clip.mp4"} {
		evidenceTestSend(t, f, "GET", path, nil, nil, 401)
		evidenceTestSend(t, f, "GET", path, nil, f.memberCookie, 403)
	}
	evidenceTestSend(t, f, "GET", "/api/admin/video-evidence", nil, f.adminCookie, 200)
	input := map[string]any{"streamId": f.stream.ID, "profileId": f.profile.ID, "durationSeconds": 30}
	foreign := httptest.NewRequest("POST", "/api/admin/video-evidence", strings.NewReader(`{"streamId":1,"profileId":1,"durationSeconds":30}`))
	foreign.AddCookie(f.adminCookie)
	foreign.Header.Set("Content-Type", "application/json")
	foreign.Header.Set("Origin", "https://foreign.example")
	foreignResponse := httptest.NewRecorder()
	f.handler.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != 403 {
		t.Fatal("foreign-origin capture request was accepted")
	}
	for _, seconds := range []int{0, 29, 901} {
		bad := map[string]any{"streamId": f.stream.ID, "profileId": f.profile.ID, "durationSeconds": seconds}
		evidenceTestSend(t, f, "POST", "/api/admin/video-evidence", bad, f.adminCookie, 400)
	}
	for i := 0; i < 3; i++ {
		w := evidenceTestSend(t, f, "POST", "/api/admin/video-evidence", input, f.adminCookie, 201)
		var value VideoEvidence
		if json.Unmarshal(w.Body.Bytes(), &value) != nil || value.Status != "queued" || value.ProfileID != f.profile.ID || value.CountingRules.ProfileID == nil || *value.CountingRules.ProfileID != f.profile.ID || value.Quality.CaptureTimeTrusted || value.Quality.CaptureStart != nil {
			t.Fatal("queued identity or timing is incorrect")
		}
	}
	evidenceTestSend(t, f, "POST", "/api/admin/video-evidence", input, f.adminCookie, 409)
	if _, err := f.store.pool.Exec(f.ctx, `UPDATE video_evidence SET counting_rules='{}' WHERE status='queued'`); err == nil {
		t.Fatal("queued frozen rules changed")
	}
	if _, err := f.store.pool.Exec(f.ctx, `UPDATE video_evidence SET status='interrupted',completed_at=now() WHERE status='queued'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.pool.Exec(f.ctx, `UPDATE streams SET stream_url='/media/changed/index.m3u8' WHERE id=$1`, f.stream.ID); err != nil {
		t.Fatal(err)
	}
	evidenceTestSend(t, f, "POST", "/api/admin/video-evidence", input, f.adminCookie, 409)
	user, err := f.store.GetUserByID(f.ctx, f.admin.ID)
	if err != nil || user.BalanceCredits != 1000 {
		t.Fatal("capture changed credits")
	}
}
func TestPostgresRetainedAnnotationBindingBoundsAndIndependentReview(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	ready := f.ready(t, strings.Repeat("a", 64), true)
	path := fmt.Sprintf("/api/admin/video-evidence/%d/annotation", ready.ID)
	for _, field := range []string{"profileId", "clipSha256", "captureStart", "durationMs", "evidenceId"} {
		input := evidenceTestAnnotation()
		input[field] = 1
		evidenceTestSend(t, f, "POST", path, input, f.adminCookie, 400)
	}
	for _, bounds := range [][2]int64{{-1, 1000}, {0, 0}, {0, 999}, {4000, 5000}, {0, 4001}, {math.MaxInt64, math.MaxInt64}, {0, math.MaxInt64}} {
		input := evidenceTestAnnotation()
		input["startOffsetMs"], input["endOffsetMs"] = bounds[0], bounds[1]
		evidenceTestSend(t, f, "POST", path, input, f.adminCookie, 400)
	}
	input := evidenceTestAnnotation()
	input["startOffsetMs"], input["endOffsetMs"] = int64(1000), int64(3000)
	w := evidenceTestSend(t, f, "POST", path, input, f.adminCookie, 201)
	var created struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(w.Body.Bytes(), &created) != nil || created.ID < 1 {
		t.Fatal("annotation was not created")
	}
	var raw []byte
	var evidenceID int64
	if err := f.store.pool.QueryRow(f.ctx, `SELECT annotation,evidence_id FROM evaluation_intervals WHERE id=$1`, created.ID).Scan(&raw, &evidenceID); err != nil {
		t.Fatal(err)
	}
	var saved ManualInterval
	if json.Unmarshal(raw, &saved) != nil || evidenceID != ready.ID || saved.EvidenceID == nil || *saved.EvidenceID != ready.ID || saved.ProfileID != ready.ProfileID || saved.ClipSHA256 != *ready.ClipSHA256 || saved.DurationMS != 2000 || saved.StartOffsetMS != 1000 || saved.CaptureStart != nil || saved.Provenance != "assistant_assisted" {
		t.Fatalf("annotation did not bind server-owned identity: %+v", saved)
	}
	review := map[string]any{"outcome": "accepted", "note": "Different fixture operator inspected this synthetic retained media interval."}
	reviewPath := fmt.Sprintf("/api/admin/evaluation/%d", created.ID)
	evidenceTestSend(t, f, "POST", reviewPath, review, f.adminCookie, 409)
	evidenceTestSend(t, f, "POST", reviewPath, review, f.reviewCookie, 201)
	for _, tt := range []struct {
		digest              string
		complete, ambiguous bool
	}{{"b", false, false}, {"c", true, true}} {
		evidence := f.ready(t, strings.Repeat(tt.digest, 64), tt.complete)
		input := evidenceTestAnnotation()
		if tt.ambiguous {
			input["crossings"] = []ManualCrossing{{Track: "uncertain-fixture", OffsetMS: 100, Direction: "A_to_B", Class: "car", Uncertain: true}}
		}
		w := evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/video-evidence/%d/annotation", evidence.ID), input, f.adminCookie, 201)
		if json.Unmarshal(w.Body.Bytes(), &created) != nil {
			t.Fatal("invalid fixture response")
		}
		evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/evaluation/%d", created.ID), review, f.reviewCookie, 409)
	}
	for _, query := range []string{`UPDATE video_evidence SET quality='{}' WHERE id=$1`, `UPDATE video_evidence SET status='processing' WHERE id=$1`, `DELETE FROM video_evidence WHERE id=$1`} {
		if _, err := f.store.pool.Exec(f.ctx, query, ready.ID); err == nil {
			t.Fatal("finalized video evidence changed")
		}
	}
	for _, user := range []User{f.admin, f.reviewer, f.member} {
		current, err := f.store.GetUserByID(f.ctx, user.ID)
		if err != nil || current.BalanceCredits != user.BalanceCredits {
			t.Fatal("annotation changed credits")
		}
	}
}
func TestPostgresRetainedClipAuthenticationRangeAndStorage(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	ready := f.ready(t, strings.Repeat("d", 64), true)
	path := fmt.Sprintf("/api/admin/video-evidence/%d/clip.mp4", ready.ID)
	folder, err := evidenceFolder(ready.ID)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(folder, "clip.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(folder, "clip.mp4")); err != nil {
		t.Fatal(err)
	}
	evidenceTestSend(t, f, "GET", path, nil, f.adminCookie, 404)
	if err = os.WriteFile(filepath.Join(folder, "clip.mp4"), content, 0600); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", path, nil)
	request.AddCookie(f.adminCookie)
	request.Header.Set("Range", "bytes=0-3")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, request)
	if w.Code != 206 || w.Body.String() != string(content[:4]) || w.Header().Get("Content-Type") != "video/mp4" || w.Header().Get("ETag") != `"`+*ready.ClipSHA256+`"` || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("private range response failed: %d %v", w.Code, w.Header())
	}
	evidenceTestSend(t, f, "GET", path, nil, nil, 401)
	evidenceTestSend(t, f, "GET", path, nil, f.memberCookie, 403)
	evidenceTestSend(t, f, "GET", path+"?unrecognized=1", nil, f.adminCookie, 404)
	queued, err := f.api.createVideoEvidence(f.actorCtx, f.stream.ID, f.profile.ID, 30)
	if err != nil {
		t.Fatal(err)
	}
	evidenceTestSend(t, f, "GET", fmt.Sprintf("/api/admin/video-evidence/%d/clip.mp4", queued.ID), nil, f.adminCookie, 409)
	if err = os.Remove(filepath.Join(folder, "clip.mp4")); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "external.mp4")
	if err = os.WriteFile(outside, []byte("must never be served"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, filepath.Join(folder, "clip.mp4")); err == nil {
		evidenceTestSend(t, f, "GET", path, nil, f.adminCookie, 404)
	} else {
		t.Log("Operating system did not allow final-file symlink fixture; HTTP symlink denial was not exercised on this host.")
	}
}
