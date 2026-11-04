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

    def to_ndarray(self, format="bgr24", threads=None):
        assert (
            threads == 1
        ), "Concurrent cameras must not start CPU-count-sized scaler pools"
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
    anchor = Anchor(
        first_pts=start,
        anchor_utc=start,
        precision=0.02,
        utc_offset_minutes=60,
        latency=3,
        displayed="12:00:00",
    )
    return Segment(
        seq=seq,
        duration=10.0,
        data=start,
        fetched_at=start + 13,
        anchor=anchor,
        first_pts=start,
    )


RULE = Definition.from_json(
    {
        "label": "test",
        "lineStart": {"x": 0.5, "y": 0.0},
        "lineEnd": {"x": 0.5, "y": 1.0},
        "directions": ["A_to_B", "B_to_A"],
        "classes": ["car", "van", "bus", "truck", "motorcycle"],
        "anchor": "bottom_center",
        "timeBasis": "capture_utc",
        "notes": "Synthetic line for the incremental session test.",
    }
)


def run(monkeypatch, feed_one_by_one, duplicate_boxes=False):
    monkeypatch.setattr(pipeline.video, "frames", fake_frames)
    track_x = {}

    class Tracker:
        def __init__(self, fps, activation):
            pass

        def update(self, dets, t):
            # car centre moves from x=0.1 to x=0.9 between t=1003 and t=1009
            x = 0.1 + 0.8 * min(
                max((t - 1003.05) / 6.0, 0.0), 1.0
            )  # never exactly on the line
            w = 16
            cx = x * 160
            box = SimpleNamespace(
                track_id=7,
                label="car",
                confidence=0.9,
                xyxy=(cx - w / 2, 40, cx + w / 2, 70),
            )
            return [box, box] if duplicate_boxes else [box]

    monkeypatch.setattr(pipeline, "Tracker", Tracker)
    monkeypatch.setattr(
        pipeline,
        "TiledDetector",
        lambda base, tiles, **kw: SimpleNamespace(
            detect=lambda bgr: [], tiles=tiles, base=base
        ),
    )
    segments = [
        make_segment(10, 990.0),
        make_segment(11, 1000.0),
        make_segment(12, 1010.0),
        make_segment(13, 1020.0),
    ]
    session = pipeline.RoundSession(FakeDetector(0), RULE, 1000.0, 1030.0, 5.0, 0.45)
    snapshots = []
    if feed_one_by_one:
        for seg in segments:
            session.feed(seg)
            snapshots.append(session.progress())
    else:
        return (
            pipeline.count_round(
                FakeDetector(0), segments, RULE, 1000.0, 1030.0, 5.0, 0.45
            ),
            None,
        )
    return session.analysis(), snapshots


def test_incremental_equals_one_pass_and_reports_progress(monkeypatch):
    one_pass, _ = run(monkeypatch, False)
    incremental, snapshots = run(monkeypatch, True)
    assert one_pass.count == incremental.count == 1
    assert one_pass.frames == incremental.frames == 160
    assert [c["at"] for c in one_pass.crossings] == [
        c["at"] for c in incremental.crossings
    ]
    # live view: nothing counted in the pre-roll segment, the crossing appears with the segment that contains it
    assert snapshots[0]["vehicleCount"] == 0 and snapshots[1]["vehicleCount"] == 1
    last = snapshots[-1]
    assert last["vehicleCount"] == len(last["crossings"]) == 1
    assert [s["seq"] for s in last["segments"]] == [10, 11, 12, 13]
    assert last["processedUntil"] == 1030.0
    assert 1003.0 < last["crossings"][0]["at"] < 1009.0 and last["crossings"][0][
        "direction"
    ] in ("A_to_B", "B_to_A")


def test_progress_is_reported_within_a_segment(monkeypatch):
    monkeypatch.setattr(pipeline.video, "frames", fake_frames)
    monkeypatch.setattr(
        pipeline,
        "TiledDetector",
        lambda base, tiles, **kw: SimpleNamespace(
            detect=lambda bgr: [], tiles=tiles, base=base
        ),
    )
    session = pipeline.RoundSession(FakeDetector(0), RULE, 1000.0, 1030.0, 5.0, 0.45)
    reports = []
    session.feed(make_segment(11, 1000.0), on_progress=reports.append)
    assert len(reports) >= 4, "a 10 s segment reports roughly every 2 s of footage"
    assert [r["processedUntil"] for r in reports] == sorted(
        r["processedUntil"] for r in reports
    )
    assert (
        reports[0]["segments"][-1]["seq"] == 11
        and reports[-1]["processedUntil"] < 1010.0
    )
    assert session.progress()["processedUntil"] == 1010.0


def test_green_boxes_follow_only_counted_tracks_and_stay_bounded(monkeypatch):
    import json

    _, snapshots = run(monkeypatch, True)
    assert snapshots[0]["highlights"] == []
    crossing = snapshots[-1]["crossings"][0]
    assert crossing["trackId"] == 7
    frames = snapshots[-1]["highlights"]
    assert len(frames) <= 320
    assert any(f["boxes"] for f in frames)
    for frame in frames:
        for box in frame["boxes"]:
            assert crossing["at"] <= frame["at"] < crossing["at"] + 0.5
            assert box["trackId"] == crossing["trackId"]
            assert 0 <= box["x"] < box["x"] + box["width"] <= 1.001
            assert 0 <= box["y"] < box["y"] + box["height"] <= 1.001
    assert sum(len(f["boxes"]) for f in frames) <= 640
    assert len(json.dumps(snapshots[-1]).encode()) <= 60000


def test_progress_removes_highlights_when_duplicate_identity_is_no_longer_counted():
    session = pipeline.RoundSession(FakeDetector(0), RULE, 1000.0, 1030.0, 5.0, 0.45)
    session.counter = SimpleNamespace(
        crossings=[{"trackId": 2, "at": 1005.0, "direction": "A_to_B", "class": "car"}]
    )
    session.highlight_frames.append(
        {
            "at": 1006.0,
            "boxes": [{"trackId": 1, "x": 0.1, "y": 0.2, "width": 0.1, "height": 0.1}],
        }
    )
    assert session.progress()["highlights"][0]["boxes"] == []


def test_highlights_send_one_box_for_each_counted_identity(monkeypatch):
    _, snapshots = run(monkeypatch, True, duplicate_boxes=True)
    assert any(f["boxes"] for f in snapshots[-1]["highlights"])
    for f in snapshots[-1]["highlights"]:
        ids = [b["trackId"] for b in f["boxes"]]
        assert len(ids) == len(set(ids))


def test_right_only_047_profile_discards_left_road_before_tracking(monkeypatch):
    import json
    from pathlib import Path
    from tbcounter.detector import Detections
    from tbcounter.rules import in_road_regions, Point

    definition = json.loads(
        (
            Path(__file__).parents[1] / "dev/profiles/caltrans_sr57_sr22_right.json"
        ).read_text()
    )["definition"]
    rule = Definition.from_json(definition)
    assert rule.line_start.x < 0.4 < rule.line_end.x
    assert rule.line_start.y == rule.line_end.y
    assert len(rule.road_regions) == 1
    assert not in_road_regions(rule.road_regions, Point(0.25, 0.7))
    assert in_road_regions(rule.road_regions, Point(0.65, 0.7))
    assert in_road_regions(rule.road_regions, Point(0.45, 0.55))
    assert not in_road_regions(rule.road_regions, Point(0.3, 0.55))
    dets = Detections(
        np.array([[30, 40, 50, 63], [64, 40, 80, 49.5], [96, 40, 112, 63]], np.float32),
        np.array([0.9, 0.9, 0.9], np.float32),
        ["car", "car", "car"],
    )
    received = []

    class Tracker:
        def __init__(self, *args):
            pass

        def update(self, items, t):
            received.extend(items.xyxy.tolist())
            return []

    monkeypatch.setattr(pipeline, "Tracker", Tracker)
    monkeypatch.setattr(
        pipeline,
        "TiledDetector",
        lambda *args, **kw: SimpleNamespace(detect=lambda bgr: dets),
    )
    session = pipeline.RoundSession(FakeDetector(0), rule, 1000.0, 1030.0, 5.0, 0.45)
    session._frame(1005.0, np.zeros((90, 160, 3), np.uint8), None)
    assert received == [[64.0, 40.0, 80.0, 49.5], [96.0, 40.0, 112.0, 63.0]]
    assert session.count == 0


def test_packing_keeps_first_green_frame_of_every_counted_car():
    import json

    session = pipeline.RoundSession(FakeDetector(0), RULE, 1000.0, 1030.0, 8.0, 0.3)
    session.counter = SimpleNamespace(
        crossings=[
            {
                "trackId": i,
                "at": 1000.0 + i * 0.2,
                "direction": "A_to_B",
                "class": "car",
            }
            for i in range(80)
        ]
    )
    for n in range(150):
        at = 1000.0 + n * 0.2
        # Each new identity can be visible for just one measured frame.
        ids = (
            list(range(max(0, n - 20), min(79, n) + 1))
            if n < 80
            else list(range(60, 80))
        )
        session.highlight_frames.append(
            {
                "at": at,
                "boxes": [
                    {"trackId": i, "x": 0.1, "y": 0.2, "width": 0.02, "height": 0.03}
                    for i in ids
                ],
            }
        )
    result = session.progress()
    assert {b["trackId"] for f in result["highlights"] for b in f["boxes"]} == set(
        range(80)
    )
    assert sum(len(f["boxes"]) for f in result["highlights"]) <= 640
    assert len(json.dumps(result).encode()) <= 60000


def test_newly_counted_car_is_highlighted_between_regular_samples(monkeypatch):
    _, snapshots = run(monkeypatch, True)
    last = snapshots[-1]
    crossing = last["crossings"][0]
    first = next(
        f
        for f in last["highlights"]
        if any(b["trackId"] == crossing["trackId"] for b in f["boxes"])
    )
    assert first["at"] - crossing["at"] <= 0.201


def test_progress_preserves_a_crossing_just_before_the_exclusive_window_end():
    session=pipeline.RoundSession(FakeDetector(0),RULE,1000.,1030.,15.,.3)
    at=1030.-.0001
    session.counter=SimpleNamespace(crossings=[{'trackId':1,'at':at,'direction':'A_to_B','class':'car'}])
    session.processed_until=at
    session.highlight_frames.append({'at':at,'boxes':[{'trackId':1,'x':.2,'y':.3,'width':.1,'height':.1}]})
    payload=session.progress()
    assert payload['crossings'][0]['at']==at
    assert payload['crossings'][0]['at']<session.end
    assert payload['highlights'][0]['at']<=payload['processedUntil']<session.end


def test_late_neural_confirmation_publishes_only_measured_half_second_pulse(monkeypatch):
    class LateTracker:
        def __init__(self, *args):
            pass
        def update(self, dets, at):
            # The ID is already tracked, but strong class evidence arrives late.
            x = 64 + min((at-1000)*40, 60)
            return [SimpleNamespace(track_id=7,label="car",confidence=.9 if at>=1001.1 else .31,
                                    xyxy=(x-8,40,x+8,70),source="detector")]
    monkeypatch.setattr(pipeline,"Tracker",LateTracker)
    monkeypatch.setattr(pipeline,"TiledDetector",lambda *args,**kw:SimpleNamespace(detect=lambda bgr:[]))
    session=pipeline.RoundSession(FakeDetector(0),RULE,1000.,1030.,15.,.3)
    image=np.zeros((90,160,3),np.uint8)
    for n in range(11):
        session._frame(1000.+n*.1,image,None)
    assert session.progress()["vehicleCount"]==0
    assert not any(f["boxes"] for f in session.progress()["highlights"])
    session._frame(1001.1,image,None)
    session._frame(1001.2,image,None)
    payload=session.progress()
    assert payload["vehicleCount"]==1
    crossing=payload["crossings"][0]["at"]
    assert 1000.3<crossing<1000.5
    pulse=[f for f in payload["highlights"] if f["boxes"]]
    assert pulse, "late class confirmation must not erase the real earlier crossing flash"
    assert all(crossing<=f["at"]<crossing+.5 for f in pulse)
    assert not any(f["boxes"] for f in payload["highlights"] if f["at"]>=crossing+.5)
