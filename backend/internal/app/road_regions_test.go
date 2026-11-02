package app

import (
	"math"
	"testing"
	"time"
)

func TestRoadRegionsExcludeSidewalkAndPreserveBoundary(t *testing.T) {
	rule := CountingDefinition{Label: "Road", LineStart: CountingPoint{X: .1, Y: .5}, LineEnd: CountingPoint{X: .9, Y: .5}, Directions: []string{"A_to_B", "B_to_A"}, Classes: []string{"car"}, Anchor: "bottom_center", TimeBasis: "capture_utc", Notes: "Count the visible vehicle footprint inside the marked carriageways.", RoadRegions: [][]CountingPoint{{{X: .2, Y: .2}, {X: .4, Y: .2}, {X: .4, Y: .8}, {X: .2, Y: .8}}}}
	start := time.Unix(1793646000, 0)
	for _, test := range []struct {
		x    float64
		want bool
	}{{.3, true}, {.4, true}, {.5, false}} {
		_, ok := crossingCandidate(rule, CountingPoint{X: test.x, Y: .4}, CountingPoint{X: test.x, Y: .6}, start, start.Add(time.Second), start, start.Add(30*time.Second), "car")
		if ok != test.want {
			t.Fatalf("x=%v: got %v", test.x, ok)
		}
	}
	for _, bad := range [][][]CountingPoint{
		{{{X: 0, Y: 0}, {X: 1, Y: 1}}},
		{{{X: 0, Y: 0}, {X: 1, Y: 1}, {X: 0, Y: 1}, {X: 1, Y: 0}}},
		{{{X: 0, Y: 0}, {X: .5, Y: .5}, {X: 1, Y: 1}}},
		{{{X: 0, Y: 0}, {X: math.NaN(), Y: 1}, {X: 1, Y: 0}}},
	} {
		rule.RoadRegions = bad
		if validCountingDefinition(rule) {
			t.Fatal("invalid road geometry accepted")
		}
	}
}
