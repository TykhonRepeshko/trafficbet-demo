package app

// This optional local decoder verifies retained, delivered media. It never
// opens a camera URL, supplies a capture-UTC anchor, or accesses accounts/credits.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type EvidenceSegment struct {
	Sequence        int64     `json:"sequence"`
	SHA256          string    `json:"sha256"`
	File            string    `json:"file"`
	DurationSeconds float64   `json:"durationSeconds"`
	ReceivedAt      time.Time `json:"receivedAt"`
	Discontinuity   bool      `json:"discontinuity"`
}
type EvidenceGap struct {
	AfterSequence  int64   `json:"afterSequence"`
	BeforeSequence int64   `json:"beforeSequence"`
	Seconds        float64 `json:"seconds"`
}
type EvidenceDecodedSegment struct {
	Sequence       int64   `json:"sequence"`
	Frames         int64   `json:"frames"`
	FirstPTS       float64 `json:"firstPts"`
	LastPTS        float64 `json:"lastPts"`
	FramePeriod    float64 `json:"framePeriod"`
	DecodedSeconds float64 `json:"decodedSeconds"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
}
type EvidenceQuality struct {
	CaptureDiagnostics       *EvidenceCaptureDiagnostics `json:"captureDiagnostics,omitempty"`
	FramesDecoded            bool                        `json:"framesDecoded"`
	RelativeCoverageComplete bool                        `json:"relativeCoverageComplete"`
	CaptureTimeTrusted       bool                        `json:"captureTimeTrusted"`
	CaptureStart             *time.Time                  `json:"captureStart"`
	TimingBasis              string                      `json:"timingBasis"`
	Issues                   []string                    `json:"issues"`
	SegmentCount             int                         `json:"segmentCount"`
	DecodedFrames            int64                       `json:"decodedFrames"`
	FirstPTS                 float64                     `json:"firstPts"`
	LastPTS                  float64                     `json:"lastPts"`
	MissingSequences         []int64                     `json:"missingSequences"`
	PTSGaps                  []EvidenceGap               `json:"ptsGaps"`
	FramingStatus            string                      `json:"framingStatus"`
	Segments                 []EvidenceSegment           `json:"segments"`
	DecodedSegments          []EvidenceDecodedSegment    `json:"decodedSegments"`
	SampledFrames            int                         `json:"sampledFrames"`
	LongestRepeatedSeconds   int                         `json:"longestRepeatedSeconds"`
}

const retainedSegmentLimit int64 = 20 << 20
const retainedTotalLimit int64 = 512 << 20

var evidenceSegmentName = regexp.MustCompile(`^[0-9]{1,20}\.ts$`)
var evidenceDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

var errVideoVerification = errors.New("retained video verification failed")

type boundedDecoderOutput struct {
	data     bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedDecoderOutput) Write(p []byte) (int, error) {
	if b.data.Len()+len(p) > b.limit {
		b.overflow = true
		return 0, errVideoVerification
	}
	return b.data.Write(p)
}

// Decoder subprocesses inherit no application environment or credentials. PATH
// is used by LookPath before launching, not exposed to the child. max_alloc is a
// per-allocation bound, not a claim of a process-wide OS memory sandbox.
func decoderEnvironment() []string {
	values := []string{"AV_LOG_FORCE_NOCOLOR=1"}
	for _, key := range []string{"SystemRoot", "WINDIR", "TEMP", "TMP"} {
		if value := os.Getenv(key); value != "" {
			values = append(values, key+"="+value)
		}
	}
	return values
}
func runLocalDecoder(ctx context.Context, executable, folder string, args ...string) ([]byte, error) {
	return runLocalDecoderLimited(ctx, executable, folder, 8<<20, args...)
}
func runLocalDecoderLimited(ctx context.Context, executable, folder string, outputLimit int, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = folder
	cmd.Env = decoderEnvironment()
	cmd.WaitDelay = 2 * time.Second
	out := &boundedDecoderOutput{limit: outputLimit}
	errout := &boundedDecoderOutput{limit: 64 << 10}
	cmd.Stdout, cmd.Stderr = out, errout
	if err := cmd.Run(); err != nil || out.overflow || errout.overflow || errout.data.Len() != 0 {
		return nil, errVideoVerification
	}
	return out.data.Bytes(), nil
}

const sampledGrayWidth, sampledGrayHeight = 64, 36
const sampledGrayBytes = sampledGrayWidth * sampledGrayHeight

// The timestamp/header/footer rows are excluded so a changing overlay cannot
// conceal a frozen road image. These coarse samples can flag suspicious input;
// they neither prove fixed hardware framing nor guarantee every freeze is seen.
func grayScene(frame []byte) []byte {
	return frame[2*sampledGrayWidth : (sampledGrayHeight-2)*sampledGrayWidth]
}
func graySceneTexture(scene []byte) float64 {
	var sum, squares float64
	for _, value := range scene {
		sum += float64(value)
		squares += float64(value) * float64(value)
	}
	mean := sum / float64(len(scene))
	return squares/float64(len(scene)) - mean*mean
}
func grayGradientCorrelation(a, b []byte) float64 {
	var dot, aa, bb float64
	height := len(a) / sampledGrayWidth
	for y := 1; y < height-1; y++ {
		for x := 1; x < sampledGrayWidth-1; x++ {
			i := y*sampledGrayWidth + x
			ax, ay := float64(a[i+1])-float64(a[i-1]), float64(a[i+sampledGrayWidth])-float64(a[i-sampledGrayWidth])
			bx, by := float64(b[i+1])-float64(b[i-1]), float64(b[i+sampledGrayWidth])-float64(b[i-sampledGrayWidth])
			dot += ax*bx + ay*by
			aa += ax*ax + ay*ay
			bb += bx*bx + by*by
		}
	}
	if aa == 0 || bb == 0 {
		return 0
	}
	return dot / math.Sqrt(aa*bb)
}
func assessGrayVideoSamples(q *EvidenceQuality, raw []byte) error {
	if len(raw)%sampledGrayBytes != 0 || len(raw) == 0 || len(raw) > 3<<20 {
		return errVideoVerification
	}
	q.SampledFrames = len(raw) / sampledGrayBytes
	var baseline, previous []byte
	repeat, lowCorrelation := 0, 0
	suspected := false
	for start := 0; start < len(raw); start += sampledGrayBytes {
		scene := grayScene(raw[start : start+sampledGrayBytes])
		if previous != nil && bytes.Equal(scene, previous) {
			repeat++
			if repeat > q.LongestRepeatedSeconds {
				q.LongestRepeatedSeconds = repeat
			}
		} else {
			repeat = 0
		}
		previous = scene
		if baseline == nil && graySceneTexture(scene) >= 64 {
			baseline = scene
		}
		if baseline != nil && grayGradientCorrelation(baseline, scene) < .45 {
			lowCorrelation++
			if lowCorrelation >= 5 {
				suspected = true
			}
		} else {
			lowCorrelation = 0
		}
	}
	if q.LongestRepeatedSeconds >= 10 {
		appendEvidenceIssue(q, "repeated_frame_run_needs_review")
		q.RelativeCoverageComplete = false
	}
	if suspected {
		q.FramingStatus = "suspected_change"
		appendEvidenceIssue(q, "sampled_scene_change_needs_review")
		q.RelativeCoverageComplete = false
	} else if baseline != nil && q.SampledFrames >= 10 {
		q.FramingStatus = "stable_sampled"
	} else {
		q.FramingStatus = "unverified"
		appendEvidenceIssue(q, "insufficient_scene_samples")
	}
	return nil
}
func decoderPaths(configured string) (string, string, error) {
	if configured == "" {
		return "", "", errVideoVerification
	}
	if !filepath.IsAbs(configured) && strings.ContainsAny(configured, `/\\`) {
		return "", "", errVideoVerification
	}
	resolved, err := exec.LookPath(configured)
	if err != nil {
		return "", "", errVideoVerification
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", "", errVideoVerification
	}
	probeName := "ffprobe"
	if strings.EqualFold(filepath.Ext(resolved), ".exe") {
		probeName += ".exe"
	}
	probe := filepath.Join(filepath.Dir(resolved), probeName)
	for _, executable := range []string{resolved, probe} {
		info, err := os.Stat(executable)
		if err != nil || !info.Mode().IsRegular() {
			return "", "", errVideoVerification
		}
	}
	return resolved, probe, nil
}

type decodedProbe struct {
	Frames []struct {
		PTS      string `json:"best_effort_timestamp_time"`
		Duration string `json:"pkt_duration_time"`
		Width    int    `json:"width"`
		Height   int    `json:"height"`
	} `json:"frames"`
	Streams []struct {
		Codec  string `json:"codec_name"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"streams"`
}

func inspectDecodedProbe(data []byte, segment EvidenceSegment) (EvidenceDecodedSegment, []string, error) {
	var parsed decodedProbe
	if json.Unmarshal(data, &parsed) != nil || len(parsed.Streams) != 1 || len(parsed.Frames) < 2 || len(parsed.Frames) > 16000 {
		return EvidenceDecodedSegment{}, nil, errVideoVerification
	}
	stream := parsed.Streams[0]
	if stream.Codec != "h264" || stream.Width < 32 || stream.Height < 32 || stream.Width > 1920 || stream.Height > 1080 || stream.Width*stream.Height > 1920*1080 {
		return EvidenceDecodedSegment{}, nil, errVideoVerification
	}
	v := EvidenceDecodedSegment{Sequence: segment.Sequence, Frames: int64(len(parsed.Frames)), Width: stream.Width, Height: stream.Height}
	pts := make([]float64, len(parsed.Frames))
	steps := make([]float64, 0, len(pts)-1)
	for i, frame := range parsed.Frames {
		timestamp, err := strconv.ParseFloat(frame.PTS, 64)
		if err != nil || math.IsNaN(timestamp) || math.IsInf(timestamp, 0) || math.Abs(timestamp) > 1e9 || frame.Width != stream.Width || frame.Height != stream.Height {
			return v, nil, errVideoVerification
		}
		pts[i] = timestamp
		if i > 0 {
			step := pts[i] - pts[i-1]
			if step <= 0 {
				return v, []string{"non_monotonic_frame_pts"}, errVideoVerification
			}
			steps = append(steps, step)
		}
	}
	sort.Float64s(steps)
	v.FramePeriod = steps[len(steps)/2]
	if v.FramePeriod < 1.0/120 || v.FramePeriod > 1 {
		return v, nil, errVideoVerification
	}
	v.FirstPTS, v.LastPTS = pts[0], pts[len(pts)-1]
	v.DecodedSeconds = v.LastPTS - v.FirstPTS + v.FramePeriod
	issues := []string{}
	// Uneven presentation intervals can be intentional VFR or lost footage.
	// Without a documented source cadence, neither is silently assumed valid.
	for _, step := range steps {
		if math.Abs(step-v.FramePeriod) > math.Max(.002, v.FramePeriod*.2) {
			issues = append(issues, "irregular_frame_cadence")
			break
		}
	}
	if math.Abs(v.DecodedSeconds-segment.DurationSeconds) > math.Max(.002, .75*v.FramePeriod) {
		issues = append(issues, "declared_decoded_duration_mismatch")
	}
	return v, issues, nil
}

func appendEvidenceIssue(q *EvidenceQuality, issue string) {
	for _, existing := range q.Issues {
		if existing == issue {
			return
		}
	}
	q.Issues = append(q.Issues, issue)
}

// Browser annotation offsets assume a finite review-clip timeline starting at
// zero. Neither NaN nor an unknown timestamp can establish that mapping.
func parseReviewClipDuration(rawDuration, rawStart string) (float64, error) {
	duration, durationErr := strconv.ParseFloat(rawDuration, 64)
	start, startErr := strconv.ParseFloat(rawStart, 64)
	if durationErr != nil || startErr != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || math.IsNaN(start) || math.IsInf(start, 0) || duration <= 0 || duration > 1900 || math.Abs(start) > .002 {
		return 0, errVideoVerification
	}
	return duration, nil
}

func appendDecodedEvidence(q *EvidenceQuality, segment EvidenceSegment, decoded EvidenceDecodedSegment) {
	if len(q.DecodedSegments) == 0 {
		q.FirstPTS = decoded.FirstPTS
	} else {
		previous := q.DecodedSegments[len(q.DecodedSegments)-1]
		expected := previous.LastPTS + previous.FramePeriod
		delta := decoded.FirstPTS - expected
		tolerance := math.Max(.002, math.Max(previous.FramePeriod, decoded.FramePeriod)*.5)
		if math.Abs(delta) > tolerance {
			q.PTSGaps = append(q.PTSGaps, EvidenceGap{AfterSequence: previous.Sequence, BeforeSequence: decoded.Sequence, Seconds: delta})
			appendEvidenceIssue(q, "segment_pts_gap_or_overlap")
		}
		if previous.Width != decoded.Width || previous.Height != decoded.Height {
			appendEvidenceIssue(q, "video_format_changed")
		}
	}
	q.DecodedSegments = append(q.DecodedSegments, decoded)
	q.DecodedFrames += decoded.Frames
	q.LastPTS = decoded.LastPTS
}

func validateRetainedSegments(folder string, segments []EvidenceSegment) error {
	if !filepath.IsAbs(folder) || len(segments) == 0 || len(segments) > 128 {
		return errVideoVerification
	}
	canonical, err := filepath.EvalSymlinks(folder)
	if err != nil {
		return errVideoVerification
	}
	equalPath := filepath.Clean(canonical) == filepath.Clean(folder)
	if runtime.GOOS == "windows" {
		equalPath = strings.EqualFold(filepath.Clean(canonical), filepath.Clean(folder))
	}
	info, err := os.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !equalPath {
		return errVideoVerification
	}
	var total int64
	var duration float64
	names := map[string]bool{}
	for _, segment := range segments {
		if segment.Sequence < 0 || !evidenceSegmentName.MatchString(segment.File) || names[segment.File] || !evidenceDigest.MatchString(segment.SHA256) || math.IsNaN(segment.DurationSeconds) || math.IsInf(segment.DurationSeconds, 0) || segment.DurationSeconds <= 0 || segment.DurationSeconds > 120 || segment.ReceivedAt.IsZero() {
			return errVideoVerification
		}
		names[segment.File] = true
		info, err := os.Lstat(filepath.Join(folder, segment.File))
		if err != nil || !info.Mode().IsRegular() || info.Size() < 188 || info.Size() > retainedSegmentLimit {
			return errVideoVerification
		}
		total += info.Size()
		duration += segment.DurationSeconds
		if total > retainedTotalLimit || duration > 1800 {
			return errVideoVerification
		}
		file, err := os.Open(filepath.Join(folder, segment.File))
		if err != nil {
			return errVideoVerification
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, io.LimitReader(file, retainedSegmentLimit+1))
		file.Close()
		if copyErr != nil || hex.EncodeToString(hash.Sum(nil)) != segment.SHA256 {
			return errVideoVerification
		}
	}
	return nil
}

// analyzeRetainedVideo has a bounded private local input surface. Complete is
// deliberately stricter than playable: errors/gaps remain in the report even
// when a partial MP4 is useful for review. CaptureTimeTrusted always stays false.
func analyzeRetainedVideo(ctx context.Context, decoderPath string, folder string, segments []EvidenceSegment) (EvidenceQuality, int64, string, error) {
	q := EvidenceQuality{TimingBasis: "media_relative", FramingStatus: "unverified", Issues: []string{}, MissingSequences: []int64{}, PTSGaps: []EvidenceGap{}, Segments: append([]EvidenceSegment(nil), segments...), DecodedSegments: []EvidenceDecodedSegment{}, SegmentCount: len(segments)}
	if err := validateRetainedSegments(folder, segments); err != nil {
		return q, 0, "", err
	}
	ffmpeg, ffprobe, err := decoderPaths(decoderPath)
	if err != nil {
		return q, 0, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	hashes := map[string]bool{}
	for i, segment := range segments {
		if segment.Discontinuity {
			appendEvidenceIssue(&q, "media_discontinuity")
		}
		if i > 0 {
			previous := segments[i-1]
			if segment.Sequence <= previous.Sequence {
				appendEvidenceIssue(&q, "sequence_regression_or_duplicate")
			} else if segment.Sequence > previous.Sequence+1 {
				appendEvidenceIssue(&q, "missing_sequences")
				for missing := previous.Sequence + 1; missing < segment.Sequence && len(q.MissingSequences) < 1024; missing++ {
					q.MissingSequences = append(q.MissingSequences, missing)
				}
			}
		}
		if hashes[segment.SHA256] {
			appendEvidenceIssue(&q, "repeated_segment_content")
		}
		hashes[segment.SHA256] = true
		data, err := runLocalDecoder(ctx, ffprobe, folder, "-v", "error", "-max_alloc", "67108864", "-max_pixels", "2073600", "-max_streams", "8", "-threads", "1", "-err_detect", "explode", "-protocol_whitelist", "file,pipe", "-probesize", "2097152", "-analyzeduration", "5000000", "-f", "mpegts", "-select_streams", "v:0", "-show_frames", "-show_entries", "stream=codec_name,width,height:frame=best_effort_timestamp_time,pkt_duration_time,width,height", "-of", "json", "-i", segment.File)
		if err != nil {
			appendEvidenceIssue(&q, "segment_decode_failed")
			continue
		}
		decoded, issues, err := inspectDecodedProbe(data, segment)
		for _, issue := range issues {
			appendEvidenceIssue(&q, issue)
		}
		if err != nil {
			appendEvidenceIssue(&q, "segment_decode_failed")
			continue
		}
		appendDecodedEvidence(&q, segment, decoded)
	}
	q.FramesDecoded = len(q.DecodedSegments) == len(segments)
	q.RelativeCoverageComplete = q.FramesDecoded && len(q.Issues) == 0
	if q.DecodedFrames == 0 {
		return q, 0, "", errVideoVerification
	}
	// Concatenate exact retained TS bytes, avoiding manifests, concat demuxer
	// directives, user-controlled command fragments and all network protocols.
	inputPath := filepath.Join(folder, "decoder-input.ts")
	combined, err := os.OpenFile(inputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return q, 0, "", errVideoVerification
	}
	defer os.Remove(inputPath)
	for _, segment := range segments {
		file, err := os.Open(filepath.Join(folder, segment.File))
		if err != nil {
			combined.Close()
			return q, 0, "", errVideoVerification
		}
		_, err = io.Copy(combined, io.LimitReader(file, retainedSegmentLimit+1))
		file.Close()
		if err != nil {
			combined.Close()
			return q, 0, "", errVideoVerification
		}
	}
	if combined.Close() != nil {
		return q, 0, "", errVideoVerification
	}
	partial := filepath.Join(folder, "clip.partial.mp4")
	final := filepath.Join(folder, "clip.mp4")
	for _, output := range []string{partial, final} {
		if _, err := os.Lstat(output); !os.IsNotExist(err) {
			return q, 0, "", errVideoVerification
		}
	}
	defer os.Remove(partial)
	_, err = runLocalDecoder(ctx, ffmpeg, folder, "-hide_banner", "-v", "error", "-nostdin", "-n", "-max_alloc", "67108864", "-max_pixels", "2073600", "-max_streams", "8", "-threads", "1", "-protocol_whitelist", "file,pipe", "-probesize", "2097152", "-analyzeduration", "5000000", "-copyts", "-start_at_zero", "-f", "mpegts", "-i", "decoder-input.ts", "-map", "0:v:0", "-c:v", "copy", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1", "-avoid_negative_ts", "disabled", "-use_editlist", "1", "-movflags", "+faststart", "-fs", fmt.Sprint(retainedTotalLimit), "clip.partial.mp4")
	if err != nil {
		return q, 0, "", errVideoVerification
	}
	info, err := os.Stat(partial)
	if err != nil || info.Size() < 32 || info.Size() >= retainedTotalLimit {
		return q, 0, "", errVideoVerification
	}
	data, err := runLocalDecoder(ctx, ffprobe, folder, "-v", "error", "-max_alloc", "67108864", "-max_pixels", "2073600", "-max_streams", "8", "-threads", "1", "-protocol_whitelist", "file,pipe", "-f", "mov", "-select_streams", "v:0", "-count_frames", "-show_entries", "format=duration,start_time:stream=nb_read_frames", "-of", "json", "-i", "clip.partial.mp4")
	if err != nil {
		return q, 0, "", errVideoVerification
	}
	var metadata struct {
		Streams []struct {
			Frames string `json:"nb_read_frames"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
			Start    string `json:"start_time"`
		} `json:"format"`
	}
	if json.Unmarshal(data, &metadata) != nil {
		return q, 0, "", errVideoVerification
	}
	duration, err := parseReviewClipDuration(metadata.Format.Duration, metadata.Format.Start)
	if err != nil {
		return q, 0, "", errVideoVerification
	}
	if len(metadata.Streams) != 1 {
		return q, 0, "", errVideoVerification
	}
	clipFrames, countErr := strconv.ParseInt(metadata.Streams[0].Frames, 10, 64)
	if countErr != nil || clipFrames < 1 {
		return q, 0, "", errVideoVerification
	}
	if clipFrames != q.DecodedFrames {
		appendEvidenceIssue(&q, "review_clip_frame_count_mismatch")
		q.RelativeCoverageComplete = false
	}
	samples, sampleErr := runLocalDecoderLimited(ctx, ffmpeg, folder, 3<<20, "-hide_banner", "-v", "error", "-nostdin", "-max_alloc", "67108864", "-max_pixels", "2073600", "-max_streams", "8", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", "clip.partial.mp4", "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "fps=1,scale=64:36:flags=area,format=gray", "-f", "rawvideo", "pipe:1")
	if sampleErr != nil || assessGrayVideoSamples(&q, samples) != nil {
		appendEvidenceIssue(&q, "scene_sampling_failed")
		q.FramingStatus = "unverified"
		q.RelativeCoverageComplete = false
	}
	file, err := os.Open(partial)
	if err != nil {
		return q, 0, "", errVideoVerification
	}
	hash := sha256.New()
	_, err = io.Copy(hash, io.LimitReader(file, retainedTotalLimit+1))
	file.Close()
	if err != nil {
		return q, 0, "", errVideoVerification
	}
	if renameErr := os.Rename(partial, final); renameErr != nil {
		return q, 0, "", errVideoVerification
	}
	return q, int64(math.Round(duration * 1000)), hex.EncodeToString(hash.Sum(nil)), nil
}
