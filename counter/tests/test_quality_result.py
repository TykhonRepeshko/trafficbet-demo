from types import SimpleNamespace
import threading

from tbcounter.main import Counter
from tbcounter.pipeline import RoundAnalysis


def test_uncertain_positive_count_is_posted_as_invalid_without_vehicle_count():
    worker = Counter.__new__(Counter)
    worker.cfg = SimpleNamespace(
        worker_name="fixture", model="fixture", sample_fps=8, conf_threshold=0.3
    )
    posted = []
    worker.post_result = lambda rid, payload: posted.append(payload)
    camera = SimpleNamespace(
        id=1,
        lock=threading.Lock(),
        baseline=None,
        profile={"id": 1},
        reference_sig=None,
        moved_streak=0,
    )
    result = RoundAnalysis(
        4,
        [{"at": 1.0}] * 4,
        320,
        320,
        100,
        10,
        0,
        None,
        None,
        400,
        200,
        1,
        timings={"msPerFrame": 1, "totalSeconds": 1},
        motion={
            "method": "semantic_pixel_motion_v1",
            "warmupFrames": 80,
            "requiredWarmupFrames": 32,
            "qualityIssues": ["unclassified_motion_at_line"],
        },
        quality_issues=["unclassified_motion_at_line"],
    )
    coverage = SimpleNamespace(segments=[], evidence=lambda: {})
    worker.finalize_round(
        camera,
        {"id": 3, "countingRules": {"profileId": 1}},
        result,
        coverage,
        model_name="yolox-m",
    )
    assert len(posted) == 1
    assert posted[0]["outcome"] == "invalid"
    assert "vehicleCount" not in posted[0]
    assert "unclassified_motion_at_line" in posted[0]["reason"]
    assert posted[0]["evidence"]["model"] == "yolox-m"
