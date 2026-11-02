import math

import pytest

from tbcounter.calibration import NotEnoughTracks, TrajectoryCollector, compute_line
from tbcounter.rules import valid_definition


def lanes(collector, n=12, w=1024, h=576):
    # Two carriageways moving vertically (towards / away from the camera), slight perspective drift.
    for i in range(n):
        x = 300 + 40 * (i % 3) if i % 2 == 0 else 640 + 40 * (i % 3)
        ys = range(150, 560, 40) if i % 2 == 0 else range(560, 150, -40)
        for k, y in enumerate(ys):
            collector.observe(i, "car", (x - 30 + 0.05 * y, y - 40, x + 30 + 0.05 * y, y), k * 0.2)


def test_line_is_perpendicular_to_flow_and_spans_both_carriageways():
    c = TrajectoryCollector()
    lanes(c)
    res = compute_line(c.tracks, 1024, 576, min_tracks=8, camera="E18")
    d = res.definition
    assert valid_definition(d)
    angle = math.degrees(math.atan2((d.line_end.y - d.line_start.y) * 576, (d.line_end.x - d.line_start.x) * 1024))
    assert abs(abs(angle) % 180 - 0) < 10 or abs(abs(angle) % 180 - 180) < 10  # near horizontal
    xs = sorted([d.line_start.x * 1024, d.line_end.x * 1024])
    assert xs[0] < 300 and xs[1] > 720  # covers both lanes
    assert 0.3 < d.line_start.y < 0.9 and res.tracks_used == 12 and d.directions == ("A_to_B", "B_to_A")


def test_horizontal_traffic_gives_vertical_line():
    c = TrajectoryCollector()
    for i in range(10):
        y = 250 + 25 * (i % 4)
        for k, x in enumerate(range(100, 900, 60)):
            c.observe(i, "truck", (x - 40, y - 30, x + 40, y), k * 0.2)
    d = compute_line(c.tracks, 1024, 576).definition
    assert abs(d.line_start.x - d.line_end.x) < 0.05 and abs(d.line_start.y - d.line_end.y) > 0.05


def test_too_few_tracks():
    c = TrajectoryCollector()
    for k in range(10):
        c.observe(1, "car", (100, 100 + 30 * k, 140, 140 + 30 * k), k)
    with pytest.raises(NotEnoughTracks):
        compute_line(c.tracks, 1024, 576)
