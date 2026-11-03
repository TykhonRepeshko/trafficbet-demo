from dataclasses import replace
import numpy as np
import pytest

from tbcounter.detector import Detections, TiledDetector
from tbcounter.evidence import (
    DETECTOR,
    PIXEL_MOTION,
    MEASURED_MOTION,
    observation_source,
)
from tbcounter.tracking import Tracker
from tbcounter.rules import CrossingCounter, Definition, Point

RULE = Definition(
    "All motor vehicles",
    Point(0.5, 0.1),
    Point(0.5, 0.9),
    ("A_to_B", "B_to_A"),
    ("car", "van", "bus", "truck", "motorcycle"),
    notes="Explicit observation origins for a measured crossing.",
)


def crossing(source, samples=3, label="vehicle"):
    counter = CrossingCounter(RULE, 0, 10, 400, 200)
    for index in range(samples):
        x = 130 + index * 30
        counter.observe(
            1, label, 0.9, (x, 80, x + 40, 120), 1 + index / 8, source=source
        )
    return counter


def test_learned_generic_class_is_independent_of_motion_candidates():
    assert crossing(DETECTOR).count == 1
    assert crossing(PIXEL_MOTION).count == 0
    assert crossing(None).count == 0  # Old producers cannot silently gain trust.


def test_pixel_candidate_still_requires_eight_confirmations():
    assert crossing(PIXEL_MOTION, 7).count == 0
    assert crossing(PIXEL_MOTION, 8).count == 1


def test_motion_cannot_fabricate_classification_even_with_high_score():
    assert crossing(MEASURED_MOTION, 8, "car").count == 0


def test_motion_cannot_overwrite_an_observed_vehicle_subtype():
    counter = CrossingCounter(replace(RULE, classes=("car",)), 0, 10, 400, 200)
    for i, x in enumerate((130, 135)):
        counter.observe(1, "car", 0.9, (x, 80, x + 40, 120), i / 8, source=DETECTOR)
    for i in range(10):
        x = 146 + i * 9
        counter.observe(
            1, "vehicle", 0.95, (x, 80, x + 40, 120),
            (i + 2) / 8, source=MEASURED_MOTION,
        )
    assert counter.count == 1
    assert counter.crossings[0]["class"] == "car"


def test_generic_detector_cannot_bypass_frozen_subtype_selection():
    counter = CrossingCounter(replace(RULE, classes=("car",)), 0, 10, 400, 200)
    for i in range(3):
        counter.observe(
            1,
            "vehicle",
            0.9,
            (130 + i * 30, 80, 170 + i * 30, 120),
            1 + i / 8,
            source=DETECTOR,
        )
    assert counter.count == 0


def test_tracker_keeps_origin_through_its_association():
    tracker = Tracker(8, 0.3)
    boxes = []
    for i in range(4):
        data = Detections(
            np.array([[30 + i * 2, 20, 70 + i * 2, 60]], np.float32),
            np.array([0.9], np.float32),
            ["vehicle"],
            [DETECTOR if i < 3 else PIXEL_MOTION],
        )
        boxes = tracker.update(data, i / 8)
        if i == 2:
            assert boxes[0].source == DETECTOR
    assert boxes and boxes[0].source == PIXEL_MOTION


def test_tile_nms_preserves_the_selected_observation_origin():
    class Model:
        def detect(self, image):
            return Detections(
                np.array([[2, 2, 12, 12]], np.float32),
                np.array([0.8], np.float32),
                ["vehicle"],
                [DETECTOR],
            )

    data = TiledDetector(Model(), [(0, 0, 20, 20)]).detect(
        np.zeros((20, 20, 3), np.uint8)
    )
    assert data.source_at(0) == DETECTOR


def test_unknown_evidence_kind_is_rejected():
    with pytest.raises(ValueError):
        observation_source("vehicle", "magic")
