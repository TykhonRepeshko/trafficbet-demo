package app

import "time"

// CrossingCandidate validates a proposed crossing from a future tracker or a
// manually linked track. It is not a detector, tracker, timing proof or scene
// quality check. Callers must separately reject incomplete/uncertain evidence.
type CrossingCandidate struct {
	Direction    string
	At           time.Time
	VehicleClass string
}

func crossingCandidate(rule CountingDefinition, before, after CountingPoint, beforeAt, afterAt, start, end time.Time, vehicleClass string) (CrossingCandidate, bool) {
	if !validCountingDefinition(rule) || !afterAt.After(beforeAt) || !end.After(start) {
		return CrossingCandidate{}, false
	}
	included := false
	for _, class := range rule.Classes {
		if class == vehicleClass {
			included = true
		}
	}
	// A coarse vehicle has no asserted subtype. It is valid only for a rule
	// including every supported motor-vehicle class, never a car-only rule.
	if vehicleClass == "vehicle" && len(rule.Classes) == 5 {
		included = true
	}
	if !included {
		return CrossingCandidate{}, false
	}
	for _, p := range []CountingPoint{before, after} {
		if p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1 || p.X != p.X || p.Y != p.Y {
			return CrossingCandidate{}, false
		}
	}
	side := func(p CountingPoint) float64 {
		return (rule.LineEnd.X-rule.LineStart.X)*(p.Y-rule.LineStart.Y) - (rule.LineEnd.Y-rule.LineStart.Y)*(p.X-rule.LineStart.X)
	}
	a, b := side(before), side(after)
	direction := ""
	if a < 0 && b > 0 {
		direction = "A_to_B"
	} else if a > 0 && b < 0 {
		direction = "B_to_A"
	} else {
		return CrossingCandidate{}, false
	}
	allowed := false
	for _, d := range rule.Directions {
		if d == direction {
			allowed = true
		}
	}
	if !allowed {
		return CrossingCandidate{}, false
	}
	ratio := a / (a - b)
	x := before.X + (after.X-before.X)*ratio
	y := before.Y + (after.Y-before.Y)*ratio
	dx, dy := rule.LineEnd.X-rule.LineStart.X, rule.LineEnd.Y-rule.LineStart.Y
	along := ((x-rule.LineStart.X)*dx + (y-rule.LineStart.Y)*dy) / (dx*dx + dy*dy)
	if along < 0 || along > 1 || !inRoadRegions(rule.RoadRegions, CountingPoint{X: x, Y: y}) {
		return CrossingCandidate{}, false
	}
	at := beforeAt.Add(time.Duration(ratio * float64(afterAt.Sub(beforeAt))))
	if at.Before(start) || !at.Before(end) {
		return CrossingCandidate{}, false
	}
	return CrossingCandidate{Direction: direction, At: at, VehicleClass: vehicleClass}, true
}
