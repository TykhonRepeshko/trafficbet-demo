package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These bytes exercise content binding only. They are deliberately not a real
// MP4, decoded coverage evidence or a labelled example in the application DB.
func retainedHashFixture(t *testing.T) (VideoEvidence, string, []byte) {
	t.Helper()
	t.Setenv("EVIDENCE_DIRECTORY", t.TempDir())
	folder, err := evidenceFolder(1)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	content := []byte("SYNTHETIC-HASH-CONTRACT-FIXTURE-NOT-REAL-VIDEO")
	path := filepath.Join(folder, "clip.mp4")
	if err = os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	digest := retainedFixtureDigest(content)
	return VideoEvidence{ID: 1, Status: "ready", ClipSHA256: &digest}, path, content
}

func TestVerifyRetainedClipBindsActualPrivateFile(t *testing.T) {
	for _, name := range []string{"matching", "same-size corruption", "missing", "empty", "directory", "wrong digest", "missing digest", "not ready", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			evidence, path, content := retainedHashFixture(t)
			ctx := context.Background()
			switch name {
			case "same-size corruption":
				content[0] ^= 1
				if err := os.WriteFile(path, content, 0600); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "empty":
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "wrong digest":
				digest := strings.Repeat("0", 64)
				evidence.ClipSHA256 = &digest
			case "missing digest":
				evidence.ClipSHA256 = nil
			case "not ready":
				evidence.Status = "processing"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			err := verifyRetainedClip(ctx, evidence)
			if name == "matching" {
				if err != nil {
					t.Fatalf("unchanged private clip rejected: %v", err)
				}
				return
			}
			if name == "cancelled" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancelled hash verification returned %v", err)
				}
				return
			}
			if !errors.Is(err, ErrConflict) {
				t.Fatalf("invalid retained content returned %v, want conflict", err)
			}
		})
	}
}

func damageRetainedFixture(t *testing.T, evidence VideoEvidence, missing bool) {
	t.Helper()
	folder, err := evidenceFolder(evidence.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "clip.mp4")
	if missing {
		if err = os.Remove(path); err != nil {
			t.Fatal(err)
		}
		return
	}
	content, err := os.ReadFile(path)
	if err != nil || len(content) == 0 {
		t.Fatalf("read synthetic clip: %v", err)
	}
	content[0] ^= 1 // Keep the exact size to rule out size-only verification.
	if err = os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresRetainedIntegrityRequiredForNewAnnotations(t *testing.T) {
	for _, missing := range []bool{true, false} {
		t.Run(fmt.Sprintf("missing=%v", missing), func(t *testing.T) {
			f := newRetainedEvidenceTest(t)
			evidence := f.ready(t, fmt.Sprintf("new-annotation-missing=%v", missing), true)
			damageRetainedFixture(t, evidence, missing)
			evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/video-evidence/%d/annotation", evidence.ID), evidenceTestAnnotation(), f.adminCookie, 409)
			// The older evaluation endpoint must not bypass content verification
			// when a caller supplies server identity fields directly.
			input := evidenceTestAnnotation()
			input["evidenceId"], input["profileId"] = evidence.ID, evidence.ProfileID
			input["clipSha256"], input["durationMs"] = *evidence.ClipSHA256, evidence.DurationMS
			evidenceTestSend(t, f, "POST", "/api/admin/evaluation", input, f.adminCookie, 409)
			var count int
			if err := f.store.pool.QueryRow(f.ctx, `SELECT count(*) FROM evaluation_intervals WHERE evidence_id=$1`, evidence.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("invalid retained file created an annotation: count=%d err=%v", count, err)
			}
		})
	}
}

func TestPostgresRetainedPlaybackRejectsCorruption(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	evidence := f.ready(t, "playback-corruption-fixture", true)
	damageRetainedFixture(t, evidence, false)
	evidenceTestSend(t, f, "GET", fmt.Sprintf("/api/admin/video-evidence/%d/clip.mp4", evidence.ID), nil, f.adminCookie, 409)
}

func TestPostgresRetainedInterruptedStorageReservations(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	// Abruptly interrupted jobs can retain TS/input/partial-output files that
	// were never reflected in progress byte_count. They keep the full peak.
	for index := 0; index < 4; index++ {
		evidence, err := f.api.createVideoEvidence(f.actorCtx, f.stream.ID, f.profile.ID, 30)
		if err != nil {
			t.Fatalf("reservation %d: %v", index, err)
		}
		if _, err := f.store.pool.Exec(f.ctx, `UPDATE video_evidence SET status='interrupted',completed_at=now() WHERE id=$1`, evidence.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.api.createVideoEvidence(f.actorCtx, f.stream.ID, f.profile.ID, 30); !errors.Is(err, ErrConflict) {
		t.Fatalf("crash residuals did not reserve their storage: %v", err)
	}
}

func TestPostgresRetainedIntegrityRecheckedBeforeAcceptance(t *testing.T) {
	for _, missing := range []bool{true, false} {
		t.Run(fmt.Sprintf("missing=%v", missing), func(t *testing.T) {
			f := newRetainedEvidenceTest(t)
			evidence := f.ready(t, fmt.Sprintf("review-missing=%v", missing), true)
			w := evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/video-evidence/%d/annotation", evidence.ID), evidenceTestAnnotation(), f.adminCookie, 201)
			var created struct {
				ID int64 `json:"id"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.ID < 1 {
				t.Fatalf("annotation response invalid: %v", err)
			}
			damageRetainedFixture(t, evidence, missing)
			review := map[string]any{"outcome": "accepted", "note": "A separate synthetic fixture operator must inspect unchanged retained content."}
			evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/evaluation/%d", created.ID), review, f.reviewCookie, 409)
			var count int
			if err := f.store.pool.QueryRow(f.ctx, `SELECT count(*) FROM evaluation_reviews WHERE interval_id=$1`, created.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("damaged retained file received accepted review: count=%d err=%v", count, err)
			}
		})
	}
}

func TestPostgresRetainedSourceSegmentsStayInOneDatasetSplit(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	shared := retainedFixtureDigest([]byte("synthetic-shared-source-segment"))
	first := f.readyWithSegments(t, "first-parent-file", true, []EvidenceSegment{{Sequence: 10, SHA256: shared, DurationSeconds: 4}})
	second := f.readyWithSegments(t, "different-mux-parent-file", true, []EvidenceSegment{{Sequence: 20, SHA256: shared, DurationSeconds: 4}})
	if *first.ClipSHA256 == *second.ClipSHA256 {
		t.Fatal("test requires distinct parent MP4 hashes")
	}
	firstPath := fmt.Sprintf("/api/admin/video-evidence/%d/annotation", first.ID)
	secondPath := fmt.Sprintf("/api/admin/video-evidence/%d/annotation", second.ID)
	evidenceTestSend(t, f, "POST", firstPath, evidenceTestAnnotation(), f.adminCookie, 201)
	testInput := evidenceTestAnnotation()
	testInput["split"] = "test"
	w := evidenceTestSend(t, f, "POST", secondPath, testInput, f.adminCookie, 409)
	if !strings.Contains(w.Body.String(), "dataset_overlap") {
		t.Fatal("cross-parent shared source segment was not the rejection reason")
	}
	evidenceTestSend(t, f, "POST", secondPath, evidenceTestAnnotation(), f.adminCookie, 201)
	disjoint := f.ready(t, "disjoint-source-parent", true)
	evidenceTestSend(t, f, "POST", fmt.Sprintf("/api/admin/video-evidence/%d/annotation", disjoint.ID), testInput, f.adminCookie, 201)
	var splits int
	if err := f.store.pool.QueryRow(f.ctx, `SELECT count(DISTINCT dataset_split) FROM evaluation_intervals WHERE evidence_id=ANY($1)`, []int64{first.ID, second.ID}).Scan(&splits); err != nil || splits != 1 {
		t.Fatalf("shared retained material escaped into separate splits: %d %v", splits, err)
	}
}

func TestPostgresRetainedSharedSegmentsConcurrentSplitClaim(t *testing.T) {
	f := newRetainedEvidenceTest(t)
	shared := retainedFixtureDigest([]byte("synthetic-concurrent-shared-source"))
	first := f.readyWithSegments(t, "concurrent-parent-one", true, []EvidenceSegment{{SHA256: shared, Sequence: 1, DurationSeconds: 4}})
	second := f.readyWithSegments(t, "concurrent-parent-two", true, []EvidenceSegment{{SHA256: shared, Sequence: 2, DurationSeconds: 4}})
	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	for i, evidence := range []VideoEvidence{first, second} {
		input := evidenceTestAnnotation()
		if i == 1 {
			input["split"] = "test"
		}
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		path := fmt.Sprintf("/api/admin/video-evidence/%d/annotation", evidence.ID)
		go func() {
			<-start
			responses <- accountTestRequest(f.handler, "POST", path, string(body), f.adminCookie)
		}()
	}
	close(start)
	statuses := map[int]int{}
	for i := 0; i < 2; i++ {
		w := <-responses
		statuses[w.Code]++
		if w.Code != 201 && w.Code != 409 {
			t.Errorf("concurrent annotation: %d %s", w.Code, w.Body.String())
		}
	}
	if statuses[201] != 1 || statuses[409] != 1 {
		t.Fatalf("concurrent shared segments acquired conflicting dataset splits: %v", statuses)
	}
}
