import cv2
import numpy as np

from tbcounter.motion import MotionBridge
from tbcounter.rules import CrossingCounter, Definition, Point
from tbcounter.tracking import TrackedBox
from tbcounter.tracking import Tracker
from tbcounter.detector import Detections

RULE = Definition(
    "Test road",
    Point(0.5, 0.1),
    Point(0.5, 0.9),
    ("A_to_B", "B_to_A"),
    ("car",),
    notes="Synthetic pixelated vehicle crossing a fixed road line.",
)
WIDTH, HEIGHT = 400, 200


def frame(x=None):
    image = np.full((HEIGHT, WIDTH, 3), 65, np.uint8)
    if x is not None:
        rng = np.random.default_rng(7)
        texture = rng.integers(100, 240, (6, 8, 3), dtype=np.uint8)
        image[80:120, x : x + 48] = cv2.resize(
            texture, (48, 40), interpolation=cv2.INTER_NEAREST
        )
    return image


def run(semantic=True, disappear=False, reseed=False):
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8)
    counter = CrossingCounter(RULE, 4.0, 14.0, WIDTH, HEIGHT)
    ids = set()
    for i in range(70):
        t = i / 8
        x = 70 + (i - 32) * 5 if i >= 32 else None
        if x is not None and x + 48 >= WIDTH:
            x = None
        if disappear and i >= 40:
            x = None
        observations = []
        if x is not None and semantic and (32 <= i <= 39 or (reseed and 48 <= i <= 54)):
            observations = [
                TrackedBox(7 if i < 48 else 99, "car", 0.9, (x, 80, x + 48, 120))
            ]
        for box in bridge.update(frame(x), observations, t):
            ids.add(box.track_id)
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, t)
        bridge.completed.update(c["trackId"] for c in counter.crossings)
    return bridge, counter, ids


def test_pixelated_vehicle_continues_after_detector_disappears():
    bridge, counter, _ = run()
    assert bridge.assisted > 8
    assert counter.count == 1
    assert counter.crossings[0]["at"] > 5


def test_no_predicted_crossing_when_vehicle_visually_disappears():
    bridge, counter, _ = run(disappear=True)
    assert counter.count == 0


def test_new_detector_id_reattaches_without_double_counting():
    bridge, counter, ids = run(reseed=True)
    assert bridge.reattached >= 1
    assert counter.count == 1
    assert len(ids) == 1


def test_unclassified_pixelated_object_is_not_silently_a_zero():
    bridge, counter, _ = run(semantic=False)
    assert counter.count == 0
    assert "unclassified_motion_at_line" in bridge.issues


def test_empty_static_road_has_no_invented_vehicles():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8)
    for i in range(80):
        assert bridge.update(frame(), [], i / 8) == []
    assert bridge.issues == set()


def test_already_pixelated_moving_region_can_seed_a_coarse_vehicle():
    import json

    rule = Definition(
        "All motor traffic",
        RULE.line_start,
        RULE.line_end,
        RULE.directions,
        ("car", "van", "bus", "truck", "motorcycle"),
        notes=RULE.notes,
    )
    bridge = MotionBridge(rule, WIDTH, HEIGHT, 4.0, 8)
    tracker = Tracker(8, 0.3)
    counter = CrossingCounter(rule, 4.0, 14.0, WIDTH, HEIGHT)
    for i in range(70):
        x = 70 + (i - 32) * 5 if i >= 32 else None
        if x is not None and x + 48 >= WIDTH:
            x = None
        image = frame(x)
        dets = bridge.augment(image, Detections.empty(), i / 8)
        for box in bridge.update(image, tracker.update(dets, i / 8), i / 8):
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, i / 8)
        bridge.completed.update(c["trackId"] for c in counter.crossings)
    assert bridge.pixel_candidates >= 8
    assert counter.count == 1
    assert counter.crossings[0]["class"] == "vehicle"
    json.dumps(counter.crossings)


def test_coarse_object_cannot_silently_be_a_zero_for_car_only_rules():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8)
    for i in range(70):
        x = 70 + (i - 32) * 5 if i >= 32 else None
        if x is not None and x + 48 >= WIDTH:
            x = None
        image = frame(x)
        bridge.augment(image, Detections.empty(), i / 8)
        bridge.update(image, [], i / 8)
    assert "uncertain_vehicle_subtype" in bridge.issues


def test_scattered_compression_speckles_are_not_a_vehicle_at_the_line():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8)
    for i in range(80):
        image = frame()
        if i >= 32 and i % 2 == 0:
            for y in range(25, 170, 9):
                image[y : y + 3, 198:201] = 180
        bridge.update(image, [], i / 8)
    assert "unclassified_motion_at_line" not in bridge.issues


def test_measured_redetection_keeps_identity_even_without_flow_features():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8)
    bridge.measure = lambda *args: None
    bridge.measure_component = lambda *args: None
    identities = set()
    for i in range(45):
        x = 70 + (i - 32) * 5 if i >= 32 else None
        observed = (
            []
            if x is None
            else [TrackedBox(7 if i < 37 else 99, "car", 0.9, (x, 80, x + 48, 120))]
        )
        identities.update(
            box.track_id for box in bridge.update(frame(x), observed, i / 8)
        )
    assert identities == {0}
    assert bridge.reattached == 1


def test_confirmed_identity_without_an_observed_crossing_cannot_clear_unknown_motion():
    bridge, counter, _ = run(semantic=False)
    assert "unclassified_motion_at_line" in bridge.issues
    # A vehicle first classified after the line cannot prove the missing pass.
    counter.observe(0, "car", 0.9, (250, 80, 298, 120), 8.0)
    counter.observe(0, "car", 0.9, (255, 80, 303, 120), 8.125)
    bridge.observations.extend([(8.0, 0, np.array([250, 80, 298, 120]))])
    bridge.reconcile(counter)
    assert "unclassified_motion_at_line" in bridge.issues


def test_stitched_counted_identity_resolves_a_false_lost_track_issue():
    bridge, counter, _ = run()
    counted = counter.crossings[0]["trackId"]
    counter.alias[999] = counted
    bridge.lost_events.add(999)
    bridge.issues.add("vehicle_lost_near_line")
    bridge.reconcile(counter)
    assert "vehicle_lost_near_line" not in bridge.issues


def test_motion_off_the_included_road_does_not_invalidate_or_count():
    from dataclasses import replace

    rule = replace(
        RULE,
        road_regions=(
            (Point(0.05, 0.05), Point(0.35, 0.05), Point(0.35, 0.9), Point(0.05, 0.9)),
        ),
    )
    bridge = MotionBridge(rule, WIDTH, HEIGHT, 4.0, 8)
    for i in range(80):
        x = 210 + (i - 32) * 3 if 32 <= i < 70 else None
        bridge.update(frame(x), [], i / 8)
    assert bridge.issues == set()


def test_measured_car_with_headlight_spill_does_not_refund_a_complete_count():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8, end=12.0)
    counter = CrossingCounter(RULE, 4.0, 12.0, WIDTH, HEIGHT)
    # Flow ambiguity must not run for an identity measured in this very frame.
    bridge.measure_component = lambda *args: (_ for _ in ()).throw(
        AssertionError("measured identity should not need fallback")
    )
    for i in range(72):
        at = i / 8
        x = 70 + (i - 32) * 5 if i >= 32 else None
        image = frame(x)
        observed = []
        if x is not None:
            cv2.rectangle(
                image,
                (x + 20, 120),
                (min(WIDTH - 1, x + 105), 130),
                (180, 180, 180),
                -1,
            )
            observed = [TrackedBox(7, "car", 0.9, (x, 80, x + 48, 120))]
        for box in bridge.update(image, observed, at):
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, at)
        bridge.completed.update(c["trackId"] for c in counter.crossings)
    bridge.reconcile(counter)
    assert counter.count == 1
    assert not bridge.issues, bridge.evidence()
    assert bridge.audit.resolved >= 1


def test_a_missed_second_vehicle_still_invalidates_a_partial_positive_count():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8, end=12.0)
    counter = CrossingCounter(RULE, 4.0, 12.0, WIDTH, HEIGHT)
    texture = np.random.default_rng(17).integers(100, 230, (6, 8, 3), dtype=np.uint8)
    for i in range(72):
        at = i / 8
        x = 70 + (i - 32) * 5 if i >= 32 else None
        image = np.full((HEIGHT, WIDTH, 3), 65, np.uint8)
        observed = []
        if x is not None:
            image[30:65, x : x + 48] = cv2.resize(
                texture, (48, 35), interpolation=cv2.INTER_NEAREST
            )
            image[125:160, x : x + 48] = cv2.resize(
                texture, (48, 35), interpolation=cv2.INTER_NEAREST
            )
            observed = [TrackedBox(7, "car", 0.9, (x, 30, x + 48, 65))]
        for box in bridge.update(image, observed, at):
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, at)
        bridge.completed.update(c["trackId"] for c in counter.crossings)
    bridge.reconcile(counter)
    assert counter.count == 1
    assert "unclassified_motion_at_line" in bridge.issues
    assert bridge.audit.unresolved


def test_two_separate_measured_vehicles_are_not_a_merge_error():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8, end=12.0)
    counter = CrossingCounter(RULE, 4.0, 12.0, WIDTH, HEIGHT)
    texture = np.random.default_rng(17).integers(100, 230, (6, 8, 3), dtype=np.uint8)
    for i in range(72):
        at = i / 8
        x = 70 + (i - 32) * 5 if i >= 32 else None
        image = np.full((HEIGHT, WIDTH, 3), 65, np.uint8)
        observed = []
        if x is not None:
            for tid, y in ((7, 30), (8, 125)):
                image[y : y + 35, x : x + 48] = cv2.resize(
                    texture, (48, 35), interpolation=cv2.INTER_NEAREST
                )
                observed.append(TrackedBox(tid, "car", 0.9, (x, y, x + 48, y + 35)))
        for box in bridge.update(image, observed, at):
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, at)
        bridge.completed.update(c["trackId"] for c in counter.crossings)
    bridge.reconcile(counter)
    assert counter.count == 2
    assert not bridge.issues, bridge.evidence()


def test_background_afterimage_without_a_visible_object_is_not_a_missed_car():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8, end=12.0)
    for i in range(32):
        bridge.update(frame(), [], i / 8)

    class GhostBackground:
        def apply(self, gray, learningRate):
            mask = np.zeros_like(gray)
            mask[75:125, 180:220] = 255
            return mask

    bridge.background = GhostBackground()
    for i in range(32, 56):
        bridge.update(frame(), [], i / 8)
    assert bridge.reference_gray is not None
    assert not np.any(bridge.prepared[1])
    assert not bridge.issues


def test_headlights_crossing_before_window_end_do_not_count_the_approaching_body():
    bridge = MotionBridge(RULE, WIDTH, HEIGHT, 4.0, 8, end=9.0)
    counter = CrossingCounter(RULE, 4.0, 9.0, WIDTH, HEIGHT)
    for i in range(72):
        at = i / 8
        x = 70 + (i - 32) * 2 if i >= 32 else None
        image = frame(x)
        observed = []
        if x is not None:
            cv2.rectangle(image, (x + 20, 120), (x + 105, 130), (180, 180, 180), -1)
            observed = [TrackedBox(7, "car", 0.9, (x, 80, x + 48, 120))]
        for box in bridge.update(image, observed, at):
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, at)
    bridge.reconcile(counter)
    assert counter.count == 0  # The physical body never reached the line.
    assert not bridge.issues, bridge.evidence()


def test_pixelated_body_with_glare_keeps_one_crossing_after_semantic_dropout():
    rule = Definition(
        "All motor traffic",
        RULE.line_start,
        RULE.line_end,
        RULE.directions,
        ("car", "van", "bus", "truck", "motorcycle"),
        notes=RULE.notes,
    )
    bridge = MotionBridge(rule, WIDTH, HEIGHT, 4.0, 8, end=9.0)
    tracker = Tracker(8, 0.3)
    counter = CrossingCounter(rule, 4.0, 9.0, WIDTH, HEIGHT)
    for i in range(72):
        at = i / 8
        x = 70 + (i - 32) * 5 if i >= 32 else None
        image = frame(x)
        detections = Detections.empty()
        if x is not None:
            cv2.rectangle(
                image,
                (x + 20, 120),
                (min(WIDTH - 1, x + 105), 130),
                (180, 180, 180),
                -1,
            )
            if i < 40:
                detections = Detections(
                    np.array([[x, 80, x + 48, 120]], np.float32),
                    np.array([0.9], np.float32),
                    ["car"],
                )
        dets = bridge.augment(image, detections, at)
        for box in bridge.update(image, tracker.update(dets, at), at):
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, at)
        bridge.completed.update(c["trackId"] for c in counter.crossings)
    bridge.reconcile(counter)
    assert counter.count == 1
    assert not bridge.issues, bridge.evidence()
