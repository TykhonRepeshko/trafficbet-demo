from types import SimpleNamespace

import numpy as np
import pytest

from tbcounter import pipeline
from tbcounter.detector import wide_tiles
from tbcounter.rules import Definition


def test_wide_coverage_only_when_it_clearly_finds_more():
    assert pipeline.choose_coverage(3, 8) == "wide"      # Vingnes at night: 3 → 8
    assert pipeline.choose_coverage(11, 11) == "line"    # E18: no gain, keep the cheap mode
    assert pipeline.choose_coverage(12, 9) == "line"     # dense junction: wide is worse
    assert pipeline.choose_coverage(10, 12) == "line"    # +20 % is not worth ~3x CPU
    assert pipeline.choose_coverage(0, 1) == "line" and pipeline.choose_coverage(0, 2) == "wide"


def test_wide_tiles_cover_the_frame_with_overlap():
    tiles = wide_tiles(1024, 576)
    assert tiles == [(0, 0, 544, 576), (480, 0, 1024, 576)]
    assert wide_tiles(800, 450)[1][2] == 800


def test_session_adds_wide_tiles(monkeypatch):
    seen = []
    monkeypatch.setattr(pipeline, "TiledDetector", lambda base, tiles, secondary=(): seen.append(list(tiles) + list(secondary)) or SimpleNamespace(detect=lambda bgr: [], tiles=tiles, base=base))
    rule = Definition.from_json({"label": "t", "lineStart": {"x": 0.5, "y": 0.2}, "lineEnd": {"x": 0.5, "y": 0.8},
                                 "directions": ["A_to_B", "B_to_A"], "classes": ["car"], "anchor": "bottom_center",
                                 "timeBasis": "capture_utc", "notes": "Synthetic line for the coverage test."})
    for coverage, extra in (("line", 0), ("wide", 2)):
        s = pipeline.RoundSession(None, rule, 0.0, 30.0, 8.0, 0.3, coverage)
        s._frame(0.0, np.zeros((576, 1024, 3), np.uint8), None)
        assert len(seen[-1]) == len(pipeline.line_tiles(0.5, 0.2, 0.5, 0.8, 1024, 576)) + extra
        assert s.analysis().coverage == coverage
    with pytest.raises(ValueError):
        pipeline.RoundSession(None, rule, 0.0, 30.0, 8.0, 0.3, "everything")


def test_secondary_tiles_run_every_other_frame():
    from tbcounter.detector import Detections, TiledDetector

    calls = []

    class Base:
        def detect(self, crop):
            calls.append(crop.shape[:2])
            return Detections.empty()

    tiled = TiledDetector(Base(), [(0, 0, 100, 100)], secondary=[(0, 0, 50, 50), (50, 0, 100, 50)], secondary_every=2)
    frame = np.zeros((100, 100, 3), np.uint8)
    for _ in range(4):
        tiled.detect(frame)
    assert len(calls) == 1 + 2 + 1 + 1 + 2 + 1  # frames 0 and 2 include the secondary tiles
