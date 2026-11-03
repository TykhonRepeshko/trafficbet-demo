"""Explicit frame/work coordinates for motion processing; public geometry stays frozen."""

from dataclasses import dataclass
import math

import cv2
import numpy as np


@dataclass(frozen=True)
class MotionView:
    width: int
    height: int
    crop: tuple[int, int, int, int]
    scale: float
    mode: str

    @classmethod
    def create(cls, rule, width, height, mode="legacy"):
        if mode not in ("legacy", "native"):
            raise ValueError("Motion resolution must be legacy or native")
        crop = (0, 0, width, height)
        if mode == "native" and rule.road_regions:
            points = [p for polygon in rule.road_regions for p in polygon]
            # Keep context for objects on polygon edges and the approved line.
            points += [rule.line_start, rule.line_end]
            margin = max(16, round(height * 0.04))
            crop = (
                max(0, math.floor(min(p.x for p in points) * width) - margin),
                max(0, math.floor(min(p.y for p in points) * height) - margin),
                min(width, math.ceil(max(p.x for p in points) * width) + margin),
                min(height, math.ceil(max(p.y for p in points) * height) + margin),
            )
        return cls(
            width,
            height,
            crop,
            min(1.0, 640 / width) if mode == "legacy" else 1.0,
            mode,
        )

    @property
    def size(self):
        x1, y1, x2, y2 = self.crop
        return round((x2 - x1) * self.scale), round((y2 - y1) * self.scale)

    @property
    def offset(self):
        return np.array([self.crop[0], self.crop[1]] * 2, dtype=float)

    def to_work(self, box):
        return (np.asarray(box, dtype=float) - self.offset) * self.scale

    def to_frame(self, box):
        return np.asarray(box, dtype=float) / self.scale + self.offset

    def point(self, x, y):
        return round((x - self.crop[0]) * self.scale), round(
            (y - self.crop[1]) * self.scale
        )

    def gray(self, bgr):
        x1, y1, x2, y2 = self.crop
        image = cv2.cvtColor(bgr[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
        return image if self.scale == 1 else cv2.resize(image, self.size)

    def evidence(self):
        return {
            "mode": self.mode,
            "crop": list(self.crop),
            "workSize": list(self.size),
            "sourceSize": [self.width, self.height],
            "scale": self.scale,
        }
