from types import SimpleNamespace
import numpy as np
from tbcounter.evidence import DETECTOR, PIXEL_MOTION
from tbcounter.observation_fusion import fuse_observations
from tbcounter.tracking import TrackedBox
from tbcounter.motion import MotionBridge
from tbcounter.rules import Definition, Point


def body():
    return TrackedBox(5, "truck", 0.85, (50, 40, 150, 100), DETECTOR)


def history():
    return {1: SimpleNamespace(box=np.array([50, 40, 150, 100]), detector_strong=4)}


def test_pixel_fragment_inside_established_body_is_support_not_new_vehicle():
    fragment = TrackedBox(99, "vehicle", 0.95, (80, 60, 110, 80), PIXEL_MOTION)
    boxes, support = fuse_observations([fragment, body()], history(), {5: 1})
    assert boxes == [body()]
    assert support == [(99, 5, "contained_fragment")]


def test_two_classified_vehicles_are_never_merged_by_containment():
    car = TrackedBox(99, "car", 0.95, (80, 60, 110, 80), DETECTOR)
    boxes, support = fuse_observations([car, body()], history(), {5: 1})
    assert len(boxes) == 2 and not support


def test_occluded_pixel_vehicle_with_independent_history_is_retained():
    fragment = TrackedBox(99, "vehicle", 0.95, (80, 60, 110, 80), PIXEL_MOTION)
    tracks = history()
    tracks[2] = SimpleNamespace(box=np.array([160, 60, 190, 80]), detector_strong=0)
    boxes, support = fuse_observations([fragment, body()], tracks, {5: 1, 99: 2})
    assert len(boxes) == 2 and not support


def test_same_canonical_identity_uses_detector_geometry_before_high_motion_score():
    fragment = TrackedBox(99, "vehicle", 0.99, (80, 60, 110, 80), PIXEL_MOTION)
    boxes, support = fuse_observations([fragment, body()], history(), {5: 1, 99: 1})
    assert boxes == [body()] and support == [(99, 5, "canonical")]


def test_new_contained_object_cannot_silently_certify_a_complete_count():
    rule = Definition(
        "All traffic",
        Point(0.1, 0.6),
        Point(0.9, 0.6),
        ("A_to_B", "B_to_A"),
        ("car", "van", "bus", "truck", "motorcycle"),
        notes="Ambiguous contained object",
    )
    bridge = MotionBridge(rule, 200, 120, 0, 8, 30)
    image = np.full((120, 200, 3), 60, np.uint8)
    bridge.update(image, [body()], 0.0)
    bridge.update(image, [body()], 0.125)
    bridge.update(
        image,
        [body(), TrackedBox(99, "vehicle", 0.9, (80, 60, 110, 80), PIXEL_MOTION)],
        0.25,
    )
    assert "unverified_contained_motion" in bridge.issues
