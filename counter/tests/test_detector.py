import os

import cv2
import pytest

from conftest import FIXTURES
from tbcounter.detector import build

MODELS = os.environ.get("MODELS_DIR", "/app/models")


@pytest.mark.skipif(not os.path.exists(os.path.join(MODELS, "yolox_tiny.onnx")), reason="model not baked")
def test_yolox_finds_the_cars_in_a_real_frame():
    det = build("yolox-tiny", MODELS, 2)
    out = det.detect(cv2.imread(os.path.join(FIXTURES, "e18_frame.jpg")))
    cars = [i for i, l in enumerate(out.labels) if l == "car" and out.confidence[i] > 0.5]
    assert len(cars) >= 2


def test_tile_planners_cover_the_line_and_bound_tile_size():
    from tbcounter.detector import grid_tiles, line_tiles
    tiles = line_tiles(0.1, 0.3, 0.9, 0.35, 1280, 720)
    assert len(tiles) >= 2 and all(x1 - x0 <= 760 and y1 - y0 <= 760 for x0, y0, x1, y1 in tiles)
    assert min(t[0] for t in tiles) <= 128 and max(t[2] for t in tiles) >= 1152
    assert min(t[1] for t in tiles) <= 0.3 * 720 - 150 and max(t[3] for t in tiles) >= 0.35 * 720 + 150
    grid = grid_tiles(1024, 576)
    assert len(grid) == 4 and grid[0][:2] == (0, 0) and grid[-1][2:] == (1024, 576)


@pytest.mark.skipif(not os.path.exists(os.path.join(MODELS, "yolox_tiny.onnx")), reason="model not baked")
def test_tiling_finds_distant_vehicles_full_frame_misses():
    from tbcounter.detector import TiledDetector, grid_tiles
    det = build("yolox-tiny", MODELS, 2)
    frame = cv2.imread(os.path.join(FIXTURES, "e39_frame.jpg"))
    full = sum(det.detect(frame).confidence >= 0.4)
    tiled = sum(TiledDetector(det, grid_tiles(frame.shape[1], frame.shape[0])).detect(frame).confidence >= 0.4)
    assert tiled >= full + 3


@pytest.mark.parametrize("boxes,scores,clipped,expected", [
    ([[90, 40, 100, 90], [85, 40, 115, 90]], [.9, .7], [True, False], [1]),
    ([[90, 40, 100, 90]], [.9], [True], [0]),
    ([[90, 40, 100, 90], [98, 40, 128, 90]], [.9, .7], [True, False], [0, 1]),
    ([[90, 40, 100, 90], [85, 40, 115, 90]], [.9, .7], [True, True], [0, 1]),
    ([[90, 40, 100, 90], [85, 40, 115, 90]], [.9, .19], [True, False], [0, 1]),
])
def test_tile_fragments_require_a_complete_supported_body(boxes, scores, clipped, expected):
    import numpy as np
    from tbcounter.detector import complete_tile_detections
    assert complete_tile_detections(np.array(boxes), np.array(scores), clipped).tolist() == expected


def test_tiling_keeps_the_complete_body_even_when_the_fragment_scores_higher():
    import numpy as np
    from tbcounter.detector import Detections, TiledDetector
    class Detector:
        calls = 0
        def detect(self, image):
            self.calls += 1
            box = [90, 40, 100, 90] if self.calls == 1 else [5, 40, 35, 90]
            return Detections(np.array([box], np.float32),
                              np.array([.9 if self.calls == 1 else .7]), ["car"])
    tiled = TiledDetector(Detector(), [(0, 0, 100, 100), (80, 0, 180, 100)])
    result = tiled.detect(np.zeros((100, 180, 3), np.uint8))
    assert result.xyxy.tolist() == [[85, 40, 115, 90]]


def test_outer_video_edges_are_not_treated_as_tile_seams():
    import numpy as np
    from tbcounter.detector import Detections, TiledDetector
    class Detector:
        def detect(self, image):
            return Detections(np.array([[0, 20, 40, 80]], np.float32), np.array([.9]), ["car"])
    result = TiledDetector(Detector(), [(0, 0, 100, 100)]).detect(np.zeros((100, 100, 3), np.uint8))
    assert len(result) == 1 and result.xyxy[0, 0] == 0
