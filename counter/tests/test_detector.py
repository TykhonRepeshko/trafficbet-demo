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
