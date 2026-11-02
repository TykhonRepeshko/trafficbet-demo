package app

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestHybridResultCannotIgnoreUncertainTracking(t *testing.T) {
	evidence := func(issues string, warmup int, crossings string) json.RawMessage {
		data, _ := json.Marshal(map[string]any{"motion": map[string]any{"method": "semantic_pixel_motion_v1", "warmupFrames": warmup, "requiredWarmupFrames": 32, "qualityIssues": []string{}}, "qualityIssues": json.RawMessage(issues), "crossings": json.RawMessage(crossings)})
		return data
	}
	input := AutomaticResultInput{Outcome: "counted", VehicleCount: intPointer(0), Reason: "No moving vehicle crossed the line", Worker: "test-worker", Evidence: evidence("[]", 80, "[]")}
	if _, err := normalizeAutomaticResult(input); err != nil {
		t.Fatal("verified quiet-road zero rejected", err)
	}
	for _, bad := range []json.RawMessage{evidence(`["unclassified_motion_at_line"]`, 80, "[]"), evidence("[]", 2, "[]"), evidence("[]", 80, "[{}]"), evidence("null", 80, "[]")} {
		input.Evidence = bad
		if _, err := normalizeAutomaticResult(input); !errors.Is(err, ErrInvalid) {
			t.Fatal("uncertain or inconsistent hybrid evidence must not settle", err)
		}
	}
}

func TestCoarseVehicleRespectsPublishedClassSelection(t *testing.T) {
	rule := CountingDefinition{
		Label: "All motor vehicles", LineStart: CountingPoint{X: .1, Y: .5}, LineEnd: CountingPoint{X: .9, Y: .5},
		Directions: []string{"A_to_B", "B_to_A"}, Classes: []string{"car", "van", "bus", "truck", "motorcycle"},
		Anchor: "bottom_center", TimeBasis: "capture_utc", Notes: "A coarse vehicle is included only when all motor classes are included.",
	}
	start := time.Unix(1793646000, 0)
	before, after := CountingPoint{X: .5, Y: .4}, CountingPoint{X: .5, Y: .6}
	candidate, ok := crossingCandidate(rule, before, after, start, start.Add(time.Second), start, start.Add(30*time.Second), "vehicle")
	if !ok || candidate.VehicleClass != "vehicle" {
		t.Fatal("all-vehicle rule must accept a coarse vehicle", candidate, ok)
	}
	progress := LiveProgressInput{VehicleCount: 1, ProcessedUntil: unixSeconds(start.Add(time.Second)),
		Crossings: []LiveCrossing{{At: unixSeconds(candidate.At), Direction: candidate.Direction, Class: "vehicle"}},
		Segments:  []LiveSegment{{Seq: 1, StartUTC: unixSeconds(start), Duration: 10}},
	}
	if err := validateLiveProgress(progress, start, start.Add(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	rule.Classes = []string{"car"}
	if _, ok := crossingCandidate(rule, before, after, start, start.Add(time.Second), start, start.Add(30*time.Second), "vehicle"); ok {
		t.Fatal("a coarse vehicle must not be classified as a car")
	}
}
