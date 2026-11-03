from dataclasses import replace
import cv2
import numpy as np

from tbcounter.motion_view import MotionView
from tbcounter.motion import MotionBridge
from tbcounter.rules import CrossingCounter, Definition, Point
from tbcounter.tracking import TrackedBox
from tbcounter.evidence import DETECTOR

RULE = Definition(
    "Cropped road",
    Point(0.5, 0.2),
    Point(0.5, 0.8),
    ("A_to_B", "B_to_A"),
    ("car",),
    notes="Native ROI coordinates must preserve the published crossing.",
    road_regions=(
        (Point(0.2, 0.2), Point(0.8, 0.2), Point(0.8, 0.8), Point(0.2, 0.8)),
    ),
)


def test_native_crop_is_lossless_and_round_trips_coordinates():
    view = MotionView.create(RULE, 1280, 720, "native")
    assert view.crop[0] > 0 and view.crop[1] > 0
    assert view.scale == 1
    box = np.array([450, 250, 600, 350], float)
    np.testing.assert_allclose(view.to_frame(view.to_work(box)), box)
    image = np.random.default_rng(2).integers(0, 255, (720, 1280, 3), dtype=np.uint8)
    x1, y1, x2, y2 = view.crop
    np.testing.assert_array_equal(
        view.gray(image), cv2.cvtColor(image[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
    )


def test_native_and_legacy_keep_same_observed_crossing_and_frozen_geometry():
    results = []
    for mode in ("legacy", "native"):
        rule = replace(RULE)
        bridge = MotionBridge(rule, 800, 400, 4, 8, 9, resolution=mode)
        counter = CrossingCounter(rule, 4, 9, 800, 400)
        for i in range(72):
            at = i / 8
            image = np.full((400, 800, 3), 60, np.uint8)
            observed = []
            if i >= 32:
                x = 230 + (i - 32) * 8
                if x + 60 < 800:
                    image[160:220, x : x + 60] = np.random.default_rng(4).integers(
                        90, 240, (60, 60, 3), dtype=np.uint8
                    )
                    observed = [
                        TrackedBox(1, "car", 0.9, (x, 160, x + 60, 220), DETECTOR)
                    ]
            for box in bridge.update(image, observed, at):
                counter.observe(
                    box.track_id,
                    box.label,
                    box.confidence,
                    box.xyxy,
                    at,
                    source=box.source,
                )
        bridge.reconcile(counter)
        assert counter.count == 1
        assert rule == RULE
        results.append(counter.crossings[0]["at"])
    assert abs(results[0] - results[1]) < 1e-6


def test_unconfigured_road_keeps_full_frame_in_native_mode():
    view = MotionView.create(replace(RULE, road_regions=()), 800, 400, "native")
    assert view.crop == (0, 0, 800, 400)
