"""RoundSession fed segment by segment must equal a one-pass count, and expose the live view."""
from types import SimpleNamespace

import numpy as np

from tbcounter import pipeline
from tbcounter.clock import Anchor
from tbcounter.rules import Definition
from tbcounter.segments import Segment


class FakeFrame:
    def __init__(self, n):
        self.n = n

    def to_ndarray(self, format="bgr24"):
        return np.full((90, 160, 3), self.n % 255, dtype=np.uint8)


def fake_frames(data):
    # 10 s segment at 10 fps; data = start pts
    start = data
    for i in range(100):
        yield start + i * 0.1, FakeFrame(i)


class FakeDetector:
    """One car moving left to right across the frame over 6 seconds, starting at capture t0."""

    def __init__(self, t0):
        self.t0, self.now = t0, None

    def detect(self, bgr):
        return []


def make_segment(seq, start):
    anchor = Anchor(first_pts=start, anchor_utc=start, precision=0.02, utc_offset_minutes=60, latency=3,
                    displayed="12:00:00")
    return Segment(seq=seq, duration=10.0, data=start, fetched_at=start + 13, anchor=anchor, first_pts=start)


RULE = Definition.from_json({
    "label": "test", "lineStart": {"x": 0.5, "y": 0.0}, "lineEnd": {"x": 0.5, "y": 1.0},
    "directions": ["A_to_B", "B_to_A"], "classes": ["car", "van", "bus", "truck", "motorcycle"],
    "anchor": "bottom_center", "timeBasis": "capture_utc",
    "notes": "Synthetic line for the incremental session test."})


def run(monkeypatch, feed_one_by_one):
    monkeypatch.setattr(pipeline.video, "frames", fake_frames)
    track_x = {}

    class Tracker:
        def __init__(self, fps, activation):
            pass

        def update(self, dets, t):
            # car centre moves from x=0.1 to x=0.9 between t=1003 and t=1009
            x = 0.1 + 0.8 * min(max((t - 1003.05) / 6.0, 0.0), 1.0)  # never exactly on the line
            w = 16
            cx = x * 160
            return [SimpleNamespace(track_id=7, label="car", confidence=0.9, xyxy=(cx - w / 2, 40, cx + w / 2, 70))]

    monkeypatch.setattr(pipeline, "Tracker", Tracker)
    monkeypatch.setattr(pipeline, "TiledDetector", lambda base, tiles, **kw: SimpleNamespace(detect=lambda bgr: [], tiles=tiles, base=base))
    segments = [make_segment(10, 990.0), make_segment(11, 1000.0), make_segment(12, 1010.0), make_segment(13, 1020.0)]
    session = pipeline.RoundSession(FakeDetector(0), RULE, 1000.0, 1030.0, 5.0, 0.45)
    snapshots = []
    if feed_one_by_one:
        for seg in segments:
            session.feed(seg)
            snapshots.append(session.progress())
    else:
        return pipeline.count_round(FakeDetector(0), segments, RULE, 1000.0, 1030.0, 5.0, 0.45), None
    return session.analysis(), snapshots


def test_incremental_equals_one_pass_and_reports_progress(monkeypatch):
    one_pass, _ = run(monkeypatch, False)
    incremental, snapshots = run(monkeypatch, True)
    assert one_pass.count == incremental.count == 1
    assert one_pass.frames == incremental.frames == 160
    assert [c["at"] for c in one_pass.crossings] == [c["at"] for c in incremental.crossings]
    # live view: nothing counted in the pre-roll segment, the crossing appears with the segment that contains it
    assert snapshots[0]["vehicleCount"] == 0 and snapshots[1]["vehicleCount"] == 1
    last = snapshots[-1]
    assert last["vehicleCount"] == len(last["crossings"]) == 1
    assert [s["seq"] for s in last["segments"]] == [10, 11, 12, 13]
    assert last["processedUntil"] == 1030.0
    assert 1003.0 < last["crossings"][0]["at"] < 1009.0 and last["crossings"][0]["direction"] in ("A_to_B", "B_to_A")


def test_progress_is_reported_within_a_segment(monkeypatch):
    monkeypatch.setattr(pipeline.video, "frames", fake_frames)
    monkeypatch.setattr(pipeline, "TiledDetector", lambda base, tiles, **kw: SimpleNamespace(detect=lambda bgr: [], tiles=tiles, base=base))
    session = pipeline.RoundSession(FakeDetector(0), RULE, 1000.0, 1030.0, 5.0, 0.45)
    reports = []
    session.feed(make_segment(11, 1000.0), on_progress=reports.append)
    assert len(reports) >= 4, "a 10 s segment reports roughly every 2 s of footage"
    assert [r["processedUntil"] for r in reports] == sorted(r["processedUntil"] for r in reports)
    assert reports[0]["segments"][-1]["seq"] == 11 and reports[-1]["processedUntil"] < 1010.0
    assert session.progress()["processedUntil"] == 1010.0
