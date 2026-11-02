package app

import "math"

func roadSide(a, b, p CountingPoint) float64 {
	return (b.X-a.X)*(p.Y-a.Y) - (b.Y-a.Y)*(p.X-a.X)
}

func roadEdgeContains(a, b, p CountingPoint) bool {
	return math.Abs(roadSide(a, b, p)) <= 1e-9 && p.X >= math.Min(a.X, b.X)-1e-9 && p.X <= math.Max(a.X, b.X)+1e-9 && p.Y >= math.Min(a.Y, b.Y)-1e-9 && p.Y <= math.Max(a.Y, b.Y)+1e-9
}

func validRoadRegions(regions [][]CountingPoint) bool {
	if len(regions) > 8 {
		return false
	}
	for _, polygon := range regions {
		if len(polygon) < 3 || len(polygon) > 12 {
			return false
		}
		area := 0.0
		for i, a := range polygon {
			if math.IsNaN(a.X) || math.IsNaN(a.Y) || math.IsInf(a.X, 0) || math.IsInf(a.Y, 0) || a.X < 0 || a.X > 1 || a.Y < 0 || a.Y > 1 {
				return false
			}
			b := polygon[(i+1)%len(polygon)]
			if math.Hypot(a.X-b.X, a.Y-b.Y) < 1e-5 {
				return false
			}
			area += a.X*b.Y - b.X*a.Y
			for j := i + 1; j < len(polygon); j++ {
				if j == i+1 || (i == 0 && j == len(polygon)-1) {
					continue
				}
				c, d := polygon[j], polygon[(j+1)%len(polygon)]
				if roadEdgeContains(a, b, c) || roadEdgeContains(a, b, d) || roadEdgeContains(c, d, a) || roadEdgeContains(c, d, b) || (roadSide(a, b, c)*roadSide(a, b, d) < 0 && roadSide(c, d, a)*roadSide(c, d, b) < 0) {
					return false
				}
			}
		}
		if math.Abs(area) < 0.0002 {
			return false
		}
	}
	return true
}

func inRoadRegions(regions [][]CountingPoint, p CountingPoint) bool {
	if len(regions) == 0 {
		return true
	}
	for _, polygon := range regions {
		inside := false
		for i, a := range polygon {
			b := polygon[(i+1)%len(polygon)]
			if roadEdgeContains(a, b, p) {
				return true
			}
			if (a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X-a.X)*(p.Y-a.Y)/(b.Y-a.Y)+a.X {
				inside = !inside
			}
		}
		if inside {
			return true
		}
	}
	return false
}
