from datetime import datetime
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from conftest import FIXTURES
from tbcounter.caltrans_clock import CaltransClock, CaltransHeaderReader
from tbcounter.clock import Anchor
from tbcounter.rules import Definition, valid_definition, in_road_regions, Point
from tbcounter.segments import Segment, continuous
from dev.source_trial import reviewed_truth

ROOT = Path(FIXTURES) / "caltrans_c008"


def frame(name):
    header = cv2.imread(str(ROOT / name), cv2.IMREAD_GRAYSCALE)
    assert header is not None
    return cv2.copyMakeBorder(header, 0, 480-header.shape[0], 0, 0, cv2.BORDER_CONSTANT)


@pytest.mark.parametrize("displayed", ["08-06-49", "08-06-58", "08-07-08", "08-07-19", "08-07-29", "08-07-38"])
def test_read_real_headers_outside_font_training(displayed):
    reading = CaltransHeaderReader().read(frame(displayed+".png"))
    assert reading is not None
    assert reading.local.isoformat() == "2026-11-03T" + displayed.replace("-", ":") + "-08:00"
    assert reading.worst_distance <= .05
    assert reading.minimum_margin >= .02


def test_unknown_layout_and_damaged_time_are_rejected():
    reader = CaltransHeaderReader()
    assert reader.read(np.zeros((480, 640), np.uint8)) is None
    assert reader.read(np.zeros((720, 1280), np.uint8)) is None
    source = frame("08-06-49.png")
    source[12:33, 618:628] = 0  # Missing seconds digit is not inferred from neighbouring frames.
    assert reader.read(source) is None
    source = frame("08-06-49.png")
    source[12:33, 560:563] = 0  # Missing separator must not turn another number into a clock.
    assert reader.read(source) is None


def test_invalid_calendar_date_is_rejected():
    source = frame("08-06-49.png")
    source[:, 400:412] = source[:, 532:544]  # month 01 is still valid
    assert CaltransHeaderReader().read(source).local.month == 1
    source[:, 414:426] = source[:, 546:558]  # month 08 is valid
    assert CaltransHeaderReader().read(source).local.month == 8
    source[:, 400:412] = source[:, 546:558]  # month 88 is impossible
    assert CaltransHeaderReader().read(source) is None


def test_real_segment_requires_matching_full_date():
    data = (ROOT / "clock-segment.ts").read_bytes()
    fetched = datetime.fromisoformat("2026-11-03T16:07:00+00:00").timestamp()
    reader = CaltransClock()
    anchor = reader.anchor_segment(data, fetched, 2)
    assert anchor is not None
    assert anchor.utc_offset_minutes == -480
    assert anchor.displayed == "08:06:40"
    assert reader.anchor_segment(data, fetched+86400, 2) is None
    assert reader.anchor_segment(data, fetched-86400, 2) is None
    assert reader.anchor_segment(data, fetched, 1000) is None


def test_source_clock_jitter_is_not_waived_by_the_new_reader():
    a = Segment(1, 10, b"", 0, anchor=Anchor(0, 100, .025, -480, 3, "08:07:09"))
    b = Segment(2, 10, b"", 0, anchor=Anchor(10, 110.8, .025, -480, 3, "08:07:20"))
    assert continuous(a, b)[0] is False


def test_offline_profile_covers_both_roads_and_excludes_median_and_shoulder():
    profile = json.loads((Path(__file__).parents[1] / "dev/profiles/caltrans_c008.json").read_text())
    rule = Definition.from_json(profile["definition"])
    assert valid_definition(rule)
    assert profile["status"] == "offline_trial_only" and not profile["registeredInApplication"]
    assert in_road_regions(rule.road_regions, Point(320/640, 300/480))
    assert in_road_regions(rule.road_regions, Point(320/640, 100/480))
    assert not in_road_regions(rule.road_regions, Point(235/640, 176/480))
    assert not in_road_regions(rule.road_regions, Point(320/640, 20/480))
    assert not in_road_regions(rule.road_regions, Point(500/640, 420/480))


def test_labels_cannot_silently_change_window_or_anchor():
    review = {"anchor":"bottom_center", "events":[{"id":"a", "earliestPtsSeconds":19.9,
              "latestPtsSeconds":20.2, "direction":"B_to_A", "description":"white car"}]}
    with pytest.raises(ValueError, match="straddles"):
        reviewed_truth(review, 20, 50)
    review["anchor"] = "centre"
    with pytest.raises(ValueError, match="anchor"):
        reviewed_truth(review, 20, 50)


def test_full_coverage_preserves_the_whole_source_without_crop_seams():
    from tbcounter.detector import Detections
    from tbcounter.pipeline import RoundSession

    class RecordingDetector:
        name = "recording"

        def __init__(self):
            self.images = []

        def detect(self, image):
            self.images.append(image.copy())
            return Detections.empty()

    profile = json.loads((Path(__file__).parents[1] / "dev/profiles/caltrans_c008.json").read_text())
    detector = RecordingDetector()
    session = RoundSession(detector, Definition.from_json(profile["definition"]),
                           10, 20, 8, .3, coverage="full")
    source = np.zeros((480, 640, 3), np.uint8)
    source[0, 0] = (10, 20, 30)
    source[-1, -1] = (100, 110, 120)
    session._frame(10, source, None)
    assert session.tiled.tiles == [(0, 0, 640, 480)]
    assert session.tiled.secondary == []
    assert len(detector.images) == 1
    assert np.array_equal(detector.images[0], source)


def test_both_traffic_directions_count_but_the_concrete_median_does_not():
    from tbcounter.rules import crossing_candidate

    profile = json.loads((Path(__file__).parents[1] / "dev/profiles/caltrans_c008.json").read_text())
    rule = Definition.from_json(profile["definition"])

    def point(x, y):
        return Point(x/640, y/480)

    opposing = crossing_candidate(rule, point(225, 95), point(185, 115),
                                  10, 11, 10, 12, "car")
    near = crossing_candidate(rule, point(279, 295), point(319, 275),
                              10, 11, 10, 12, "car")
    assert opposing is not None and opposing.direction == "A_to_B"
    assert near is not None and near.direction == "B_to_A"
    assert crossing_candidate(rule, point(260, 162), point(220, 182),
                              10, 11, 10, 12, "car") is None
