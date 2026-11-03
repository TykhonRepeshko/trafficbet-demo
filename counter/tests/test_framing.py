import os

import cv2
import numpy as np

from conftest import FIXTURES
from tbcounter import framing

FRAME = cv2.imread(os.path.join(FIXTURES, "e18_frame.jpg"))


def test_same_view_with_lighting_change_is_stable():
    darker = cv2.convertScaleAbs(FRAME, alpha=0.6, beta=-10)
    c = framing.compare(framing.signature(FRAME), framing.signature(darker))
    assert framing.stable(c) and not framing.moved(c), c


def test_pan_is_detected():
    m = np.float32([[1, 0, 40], [0, 1, 12]])
    panned = cv2.warpAffine(FRAME, m, (FRAME.shape[1], FRAME.shape[0]), borderMode=cv2.BORDER_REFLECT)
    c = framing.compare(framing.signature(FRAME), framing.signature(panned))
    assert not framing.stable(c) and framing.moved(c), c
    assert 30 < c.shift_px < 55


def test_zoom_is_not_stable():
    h, w = FRAME.shape[:2]
    zoomed = cv2.resize(FRAME[h // 6: h - h // 6, w // 6: w - w // 6], (w, h))
    assert not framing.stable(framing.compare(framing.signature(FRAME), framing.signature(zoomed)))


def test_same_aspect_reference_and_live_sizes_compare_without_shape_failure():
    for width in (768, 1024, 1280):
        reference = cv2.resize(FRAME, (width, round(width * 9 / 16)))
        live = cv2.resize(reference, (1280, 720))
        a, b = framing.signature(reference), framing.signature(live)
        assert a.grad.shape == b.grad.shape
        assert framing.stable(framing.compare(a, b))


def test_incompatible_aspect_ratio_evidence_is_strict_json_and_fails_closed():
    import json
    a = framing.signature(cv2.resize(FRAME, (768,432)))
    b = framing.signature(cv2.resize(FRAME, (640,480)))
    comparison = framing.compare(a,b)
    assert not framing.stable(comparison)
    evidence = json.loads(json.dumps(comparison.to_json(), allow_nan=False))
    assert evidence['shiftPx'] is None
