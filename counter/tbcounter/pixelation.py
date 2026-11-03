"""Moving, block-textured regions; no reconstruction of private image details.

These are coarse vehicle candidates, not car/truck subtype classifications.
They require temporal confirmation and the round's independent quality gates.
"""

from __future__ import annotations

import cv2
import numpy as np


def pixelated_bodies(
    gray: np.ndarray,
    foreground: np.ndarray,
    scale: float,
    max_area: float | None = None,
):
    """Measured mosaic cells for an already classified vehicle, excluding smooth glare.

    These fragments cannot seed a vehicle on their own: road markings can also
    have straight edges. The caller must associate them with a measured identity.
    """
    gx = np.pad(cv2.absdiff(gray[:, 1:], gray[:, :-1]), ((0, 0), (0, 1)))
    gy = np.pad(cv2.absdiff(gray[1:, :], gray[:-1, :]), ((0, 1), (0, 0)))
    horizontal = cv2.morphologyEx(
        np.uint8(gy > 14), cv2.MORPH_OPEN, np.ones((1, 4), np.uint8)
    )
    vertical = cv2.morphologyEx(
        np.uint8(gx > 14), cv2.MORPH_OPEN, np.ones((4, 1), np.uint8)
    )
    hs = cv2.boxFilter(horizontal.astype(np.float32), -1, (11, 11), normalize=False)
    vs = cv2.boxFilter(vertical.astype(np.float32), -1, (11, 11), normalize=False)
    flat = cv2.boxFilter(np.float32((gx < 5) & (gy < 5)), -1, (11, 11))
    cells = np.uint8((hs >= 5) & (vs >= 5) & (flat > 0.55) & (foreground > 0)) * 255
    cells = cv2.morphologyEx(cells, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(cells)
    return [
        np.array([x, y, x + w, y + h], np.float64) / scale
        for x, y, w, h, area in stats[1:]
        if min(w, h) >= 5
        and 25 <= area <= (max_area if max_area is not None else gray.size * 0.08)
    ]


def pixelated_regions(
    gray: np.ndarray,
    foreground: np.ndarray,
    scale: float,
    max_area: float | None = None,
) -> list[np.ndarray]:
    joined = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(joined)
    regions = []
    for x, y, width, height, area in stats[1:]:
        if min(width, height) < 5 or not 55 <= area <= (
            max_area if max_area is not None else gray.size * 0.08
        ):
            continue
        if not 0.25 < width / height < 4 or area / (width * height) < 0.4:
            continue
        patch = gray[
            max(y - 1, 0) : min(y + height + 1, gray.shape[0]),
            max(x - 1, 0) : min(x + width + 1, gray.shape[1]),
        ].astype(np.float32)
        dx, dy = np.abs(np.diff(patch, axis=1)), np.abs(np.diff(patch, axis=0))
        # Large flat cells with sharp edges along both axes. A smooth light
        # reflection or uniform asphalt alone must not seed a new object.
        flat = min(float(np.mean(dx < 4)), float(np.mean(dy < 4)))
        edges = min(float(np.mean(dx > 18)), float(np.mean(dy > 18)))
        if flat >= 0.55 and edges >= 0.015:
            regions.append(np.array([x, y, x + width, y + height], np.float64) / scale)
    return regions
