"""Camera-movement checks: phase correlation of gradient-magnitude images (robust to lighting)."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

WIDTH = 320


@dataclass(frozen=True)
class Signature:
    grad: np.ndarray
    scale: float  # original width / WIDTH


@dataclass(frozen=True)
class Comparison:
    shift_px: float      # in original pixels
    shift_frac: float    # fraction of frame width
    response: float
    similarity: float

    def to_json(self) -> dict:
        return {"shiftPx": round(self.shift_px, 2), "shiftFraction": round(self.shift_frac, 4),
                "response": round(self.response, 3), "similarity": round(self.similarity, 3)}


def signature(bgr_or_gray: np.ndarray) -> Signature:
    gray = bgr_or_gray if bgr_or_gray.ndim == 2 else cv2.cvtColor(bgr_or_gray, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    # Ignore the operator's text bars at the top/bottom: they never move with the camera.
    band = gray[int(h * 0.08):int(h * 0.94)]
    small = cv2.resize(band, (WIDTH, max(16, int(band.shape[0] * WIDTH / w))), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small.astype(np.float32), (3, 3), 0)
    gx, gy = cv2.Sobel(small, cv2.CV_32F, 1, 0), cv2.Sobel(small, cv2.CV_32F, 0, 1)
    grad = cv2.magnitude(gx, gy)
    grad /= max(float(grad.mean()), 1e-6)
    return Signature(grad, w / WIDTH)


def compare(a: Signature, b: Signature) -> Comparison:
    if a.grad.shape != b.grad.shape:
        return Comparison(float("inf"), 1.0, 0.0, 0.0)
    window = cv2.createHanningWindow(a.grad.shape[::-1], cv2.CV_32F)
    (dx, dy), response = cv2.phaseCorrelate(a.grad, b.grad, window)
    shift = float(np.hypot(dx, dy))
    m = np.float32([[1, 0, -dx], [0, 1, -dy]])
    aligned = cv2.warpAffine(b.grad, m, a.grad.shape[::-1], borderMode=cv2.BORDER_REFLECT)
    sim = float(np.corrcoef(a.grad.ravel(), aligned.ravel())[0, 1])
    return Comparison(shift * a.scale, shift / WIDTH, float(response), sim if np.isfinite(sim) else 0.0)


def stable(c: Comparison, max_shift_frac: float = 0.012, min_similarity: float = 0.45) -> bool:
    return c.shift_frac <= max_shift_frac and c.similarity >= min_similarity


def moved(c: Comparison, min_shift_frac: float = 0.02, min_response: float = 0.08) -> bool:
    """Confident movement (as opposed to an inconclusive comparison, e.g. day vs night)."""
    return c.shift_frac > min_shift_frac and c.response >= min_response
