from dev.replay_benchmark import inside, match_events, MeteredDetector
import pytest


def test_two_truck_detections_do_not_replace_one_missed_car():
    events = [{"at": 14.0, "direction": "A_to_B"}, {"at": 14.3, "direction": "A_to_B"}]
    truth = [
        {"earliest": 13, "latest": 16, "direction": "A_to_B"},
        {"earliest": 22, "latest": 25, "direction": "A_to_B"},
    ]
    assert match_events(events, truth) == {
        "matched": 1,
        "missed": 1,
        "extra": 1,
        "allMatch": False,
    }


def test_event_assignment_handles_overlapping_review_intervals():
    events = [{"at": 14.0, "direction": "A_to_B"}, {"at": 16.0, "direction": "A_to_B"}]
    truth = [
        {"earliest": 13, "latest": 17, "direction": "A_to_B"},
        {"earliest": 13, "latest": 15, "direction": "A_to_B"},
    ]
    assert match_events(events, truth)["allMatch"]
    events[0]["direction"] = "B_to_A"
    assert not match_events(events, truth)["allMatch"]


def test_empty_control_and_source_path_boundary(tmp_path):
    assert match_events([], [])["allMatch"]
    with pytest.raises(ValueError, match="escapes"):
        inside(tmp_path, "../private.env")


def test_benchmark_does_not_reuse_predictions():
    class Detector:
        name = "fake"
        calls = 0

        def detect(self, image):
            self.calls += 1
            return self.calls

    inner = Detector()
    measured = MeteredDetector(inner)
    assert measured.detect(None) == 1
    assert measured.detect(None) == 2
    assert inner.calls == measured.calls == 2
