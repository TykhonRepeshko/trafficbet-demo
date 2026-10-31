package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func probeFixture(timestamps []string, width int) []byte {
	frames := []map[string]any{}
	for _, pts := range timestamps {
		frames = append(frames, map[string]any{"best_effort_timestamp_time": pts, "width": width, "height": 96})
	}
	data, _ := json.Marshal(map[string]any{"streams": []map[string]any{{"codec_name": "h264", "width": width, "height": 96}}, "frames": frames})
	return data
}
func TestDecodedVideoTiming(t *testing.T) {
	segment := EvidenceSegment{Sequence: 10, DurationSeconds: .12}
	valid := probeFixture([]string{"1.00", "1.04", "1.08"}, 128)
	decoded, issues, err := inspectDecodedProbe(valid, segment)
	if err != nil || len(issues) != 0 || decoded.Frames != 3 || decoded.Width != 128 || decoded.FramePeriod < .039 || decoded.FramePeriod > .041 {
		t.Fatalf("valid frames rejected: %+v %v %v", decoded, issues, err)
	}
	tests := []struct {
		name    string
		pts     []string
		width   int
		failure bool
		issue   string
	}{
		{"missing timestamp", []string{"1.00", "", "1.08"}, 128, true, ""},
		{"nonfinite timestamp", []string{"1.00", "NaN", "1.08"}, 128, true, ""},
		{"duplicate timestamp", []string{"1.00", "1.04", "1.04"}, 128, true, "non_monotonic_frame_pts"},
		{"timestamp regression", []string{"1.00", "1.04", "0.08"}, 128, true, "non_monotonic_frame_pts"},
		{"resolution bound", []string{"1.00", "1.04", "1.08"}, 4096, true, ""},
		{"cadence loss", []string{"1.00", "1.04", "1.08", "1.20"}, 128, false, "irregular_frame_cadence"},
		{"duration mismatch", []string{"1.00", "1.12", "1.24"}, 128, false, "declared_decoded_duration_mismatch"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, issues, err := inspectDecodedProbe(probeFixture(tt.pts, tt.width), segment)
			if (err != nil) != tt.failure {
				t.Fatalf("failure=%v err=%v", tt.failure, err)
			}
			if tt.issue != "" && !containsEvidenceIssue(issues, tt.issue) {
				t.Fatalf("missing issue %q: %v", tt.issue, issues)
			}
		})
	}
}
func containsEvidenceIssue(issues []string, wanted string) bool {
	for _, value := range issues {
		if value == wanted {
			return true
		}
	}
	return false
}

func TestReviewClipTimeOriginRequiresFiniteMetadata(t *testing.T) {
	for _, tt := range []struct {
		name, duration, start string
		valid                 bool
	}{
		{"zero origin", "4", "0", true},
		{"positive boundary", "4", "0.002", true},
		{"negative boundary", "4", "-0.002", true},
		{"maximum duration", "1900", "0", true},
		{"positive offset outside tolerance", "4", "0.002001", false},
		{"negative offset outside tolerance", "4", "-0.002001", false},
		{"unknown origin", "4", "N/A", false},
		{"missing origin", "4", "", false},
		{"NaN origin", "4", "NaN", false},
		{"positive infinite origin", "4", "+Inf", false},
		{"negative infinite origin", "4", "-Inf", false},
		{"NaN duration", "NaN", "0", false},
		{"positive infinite duration", "+Inf", "0", false},
		{"negative infinite duration", "-Inf", "0", false},
		{"zero duration", "0", "0", false},
		{"negative duration", "-1", "0", false},
		{"unbounded duration", "1900.001", "0", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			duration, err := parseReviewClipDuration(tt.duration, tt.start)
			if (err == nil) != tt.valid || tt.valid && duration <= 0 {
				t.Fatalf("review timing accepted=%v duration=%v err=%v", tt.valid, duration, err)
			}
		})
	}
}
func TestDecodedSegmentBoundaryCoverage(t *testing.T) {
	for _, tt := range []struct {
		name  string
		start float64
		gap   bool
	}{
		{"contiguous", 12, false}, {"small rounding", 12.000001, false}, {"missing frame", 12.04, true}, {"overlap", 11.96, true}, {"timestamp reset", 0, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			q := EvidenceQuality{}
			appendDecodedEvidence(&q, EvidenceSegment{}, EvidenceDecodedSegment{Sequence: 1, Frames: 50, FirstPTS: 10, LastPTS: 11.96, FramePeriod: .04, Width: 128, Height: 96})
			appendDecodedEvidence(&q, EvidenceSegment{}, EvidenceDecodedSegment{Sequence: 2, Frames: 50, FirstPTS: tt.start, LastPTS: tt.start + 1.96, FramePeriod: .04, Width: 128, Height: 96})
			if (len(q.PTSGaps) > 0) != tt.gap || q.DecodedFrames != 100 {
				t.Fatalf("unexpected boundary: %+v", q)
			}
			if q.CaptureTimeTrusted || q.CaptureStart != nil {
				t.Fatal("local timing invented capture UTC")
			}
		})
	}
}
func TestRetainedVideoLocalInputBounds(t *testing.T) {
	folder := t.TempDir()
	bytes := make([]byte, 188)
	hash := sha256.Sum256(bytes)
	name := "000001.ts"
	if err := os.WriteFile(filepath.Join(folder, name), bytes, 0600); err != nil {
		t.Fatal(err)
	}
	segment := EvidenceSegment{Sequence: 1, SHA256: hex.EncodeToString(hash[:]), File: name, DurationSeconds: 2, ReceivedAt: time.Now()}
	if err := validateRetainedSegments(folder, []EvidenceSegment{segment}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../000001.ts", "https://example.com/a.ts", "file:000001.ts", "-i.ts", "000001.ts\n", "sub/000001.ts"} {
		bad := segment
		bad.File = name
		if validateRetainedSegments(folder, []EvidenceSegment{bad}) == nil {
			t.Fatalf("unsafe name accepted: %q", name)
		}
	}
	bad := segment
	bad.SHA256 = strings.Repeat("a", 64)
	if validateRetainedSegments(folder, []EvidenceSegment{bad}) == nil {
		t.Fatal("corrupt segment hash accepted")
	}
	if validateRetainedSegments(folder, []EvidenceSegment{segment, segment}) == nil {
		t.Fatal("duplicate local file accepted")
	}
	if validateRetainedSegments("relative", []EvidenceSegment{segment}) == nil {
		t.Fatal("relative folder accepted")
	}
}
func TestDecoderEnvironmentAndOutputBounds(t *testing.T) {
	t.Setenv("DATABASE_URL", "secret-database-canary")
	t.Setenv("WORKER_TOKEN", "secret-worker-canary")
	for _, value := range decoderEnvironment() {
		if strings.Contains(value, "canary") || strings.HasPrefix(value, "DATABASE_URL=") || strings.HasPrefix(value, "WORKER_TOKEN=") {
			t.Fatal("application secret passed to decoder")
		}
	}
	bounded := boundedDecoderOutput{limit: 4}
	if _, err := bounded.Write([]byte("four")); err != nil {
		t.Fatal(err)
	}
	if _, err := bounded.Write([]byte("more")); err == nil || !bounded.overflow || bounded.data.Len() != 4 {
		t.Fatal("output was not bounded")
	}
	if _, _, err := decoderPaths("subfolder/ffmpeg"); err == nil {
		t.Fatal("relative executable accepted")
	}
}

func TestSampledVideoFramingAndFreeze(t *testing.T) {
	makeFrame := func(shift, overlay int) []byte {
		frame := make([]byte, sampledGrayBytes)
		for y := 0; y < sampledGrayHeight; y++ {
			for x := 0; x < sampledGrayWidth; x++ {
				if x > 10+shift && x < 30+shift && y > 7 && y < 26 {
					frame[y*sampledGrayWidth+x] = 200
				}
			}
		}
		for x := 0; x < sampledGrayWidth; x++ {
			frame[x] = byte(overlay)
		}
		return frame
	}
	t.Run("changing clock does not hide frozen road", func(t *testing.T) {
		var raw []byte
		for n := 0; n < 12; n++ {
			raw = append(raw, makeFrame(0, n)...)
		}
		q := EvidenceQuality{RelativeCoverageComplete: true}
		if err := assessGrayVideoSamples(&q, raw); err != nil {
			t.Fatal(err)
		}
		if q.LongestRepeatedSeconds != 11 || q.RelativeCoverageComplete || !containsEvidenceIssue(q.Issues, "repeated_frame_run_needs_review") {
			t.Fatalf("frozen scene missed: %+v", q)
		}
		if q.CaptureTimeTrusted || q.CaptureStart != nil {
			t.Fatal("sample invented capture UTC")
		}
	})
	t.Run("persistent view change is flagged", func(t *testing.T) {
		var raw []byte
		for n := 0; n < 12; n++ {
			shift := 0
			if n >= 5 {
				shift = 20
			}
			raw = append(raw, makeFrame(shift, n)...)
		}
		q := EvidenceQuality{RelativeCoverageComplete: true}
		if err := assessGrayVideoSamples(&q, raw); err != nil {
			t.Fatal(err)
		}
		if q.FramingStatus != "suspected_change" || q.RelativeCoverageComplete || !containsEvidenceIssue(q.Issues, "sampled_scene_change_needs_review") {
			t.Fatalf("view change missed: %+v", q)
		}
	})
	t.Run("stable samples are only sampled evidence", func(t *testing.T) {
		var raw []byte
		for n := 0; n < 12; n++ {
			frame := makeFrame(0, n)
			frame[15*sampledGrayWidth+20] = byte(100 + n)
			raw = append(raw, frame...)
		}
		q := EvidenceQuality{RelativeCoverageComplete: true}
		if err := assessGrayVideoSamples(&q, raw); err != nil {
			t.Fatal(err)
		}
		if q.FramingStatus != "stable_sampled" || q.SampledFrames != 12 || q.CaptureTimeTrusted {
			t.Fatalf("unexpected sampled report: %+v", q)
		}
	})
	t.Run("truncated sample refused", func(t *testing.T) {
		q := EvidenceQuality{}
		if assessGrayVideoSamples(&q, make([]byte, sampledGrayBytes-1)) == nil {
			t.Fatal("truncated raw frame accepted")
		}
	})
}

func generatedEvidenceFixture(t *testing.T, decoder string) (string, []EvidenceSegment) {
	if generator := os.Getenv("VIDEO_FIXTURE_GENERATOR_PATH"); generator != "" {
		decoder = generator
	}
	t.Helper()
	folder := t.TempDir()
	ffmpeg, _, err := decoderPaths(decoder)
	if err != nil {
		t.Fatal(err)
	}
	_, err = runLocalDecoder(context.Background(), ffmpeg, folder, "-hide_banner", "-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=25", "-t", "4", "-an", "-c:v", "libx264", "-threads", "1", "-g", "50", "-bf", "2", "-sc_threshold", "0", "-f", "segment", "-segment_time", "2", "-segment_format", "mpegts", "-reset_timestamps", "0", "%06d.ts")
	if err != nil {
		t.Fatal("cannot generate bounded decoder fixture")
	}
	segments := []EvidenceSegment{}
	for n := 0; n < 2; n++ {
		name := fmt.Sprintf("%06d.ts", n)
		data, err := os.ReadFile(filepath.Join(folder, name))
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(data)
		segments = append(segments, EvidenceSegment{Sequence: int64(n + 100), File: name, SHA256: hex.EncodeToString(hash[:]), DurationSeconds: 2, ReceivedAt: time.Now().UTC()})
	}
	return folder, segments
}
func TestVideoDecoderIntegration(t *testing.T) {
	decoder := os.Getenv("VIDEO_DECODER_TEST_PATH")
	if decoder == "" {
		t.Skip("VIDEO_DECODER_TEST_PATH is not configured")
	}
	t.Run("contiguous delivered media", func(t *testing.T) {
		folder, segments := generatedEvidenceFixture(t, decoder)
		quality, duration, digest, err := analyzeRetainedVideo(context.Background(), decoder, folder, segments)
		if err != nil {
			t.Fatalf("%v; frames=%d issues=%v first=%f last=%f", err, quality.DecodedFrames, quality.Issues, quality.FirstPTS, quality.LastPTS)
		}
		if !quality.FramesDecoded || !quality.RelativeCoverageComplete || quality.DecodedFrames != 100 || duration < 3900 || duration > 4100 || !evidenceDigest.MatchString(digest) {
			t.Fatalf("unexpected quality: %+v duration=%d", quality, duration)
		}
		if quality.CaptureTimeTrusted || quality.CaptureStart != nil || quality.FramingStatus != "unverified" || quality.TimingBasis != "media_relative" {
			t.Fatal("unsupported capture/framing claim")
		}
		if _, err := os.Stat(filepath.Join(folder, "clip.mp4")); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(folder, "decoder-input.ts")); !os.IsNotExist(err) {
			t.Fatal("temporary concatenation retained")
		}
	})
	t.Run("missing sequence remains unverified", func(t *testing.T) {
		folder, segments := generatedEvidenceFixture(t, decoder)
		segments[1].Sequence++
		q, _, _, err := analyzeRetainedVideo(context.Background(), decoder, folder, segments)
		if err != nil {
			t.Fatal(err)
		}
		if q.RelativeCoverageComplete || !reflect.DeepEqual(q.MissingSequences, []int64{101}) || !containsEvidenceIssue(q.Issues, "missing_sequences") {
			t.Fatalf("missing sequence ignored: %+v", q)
		}
	})
	t.Run("discontinuity remains unverified", func(t *testing.T) {
		folder, segments := generatedEvidenceFixture(t, decoder)
		segments[1].Discontinuity = true
		q, _, _, err := analyzeRetainedVideo(context.Background(), decoder, folder, segments)
		if err != nil {
			t.Fatal(err)
		}
		if q.RelativeCoverageComplete || !containsEvidenceIssue(q.Issues, "media_discontinuity") {
			t.Fatalf("discontinuity ignored: %+v", q)
		}
	})
	t.Run("modified bytes refused", func(t *testing.T) {
		folder, segments := generatedEvidenceFixture(t, decoder)
		if err := os.WriteFile(filepath.Join(folder, segments[0].File), make([]byte, 188), 0600); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := analyzeRetainedVideo(context.Background(), decoder, folder, segments); err == nil {
			t.Fatal("modified clip accepted")
		}
	})
}
