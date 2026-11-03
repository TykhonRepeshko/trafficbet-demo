"""Opt-in Caltrans C008 timestamp reader for offline source qualification.

This reader is deliberately not installed in the live worker. It accepts the
reviewed 640x480 header layout and its small fixed bitmap font, including the
calendar date. Unknown glyphs, changed layout, invalid dates, stale footage and
DST-ambiguous local times fail closed. Recognition does not authenticate the
operator's clock or guarantee media-to-UTC continuity; check SegmentBuffer too.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

import cv2
import numpy as np

from . import video
from .clock import Anchor, OverlayClock


@dataclass(frozen=True)
class ClockReading:
    local: datetime
    worst_distance: float
    minimum_margin: float

    @property
    def utc(self) -> float:
        return self.local.timestamp()

    @property
    def seconds_of_day(self) -> int:
        return self.local.hour * 3600 + self.local.minute * 60 + self.local.second


class CaltransHeaderReader:
    """Read the actual date and time, never a filename, fetch time or web still stamp."""

    MAX_DISTANCE = 0.16
    MIN_MARGIN = 0.02

    def __init__(self) -> None:
        asset = Path(__file__).with_name("assets") / "caltrans_c008_clock_font.json"
        font = json.loads(asset.read_text(encoding="utf-8"))
        self.threshold = int(font["threshold"])
        self.templates = {
            char: np.array([[[int(v) for v in row] for row in bitmap] for bitmap in examples], dtype=np.uint8)
            for char, examples in font["characters"].items()
        }
        self.zone = ZoneInfo("America/Los_Angeles")

    def _classify(self, patch: np.ndarray, allowed: str):
        patch = cv2.resize(patch, (8, 12), interpolation=cv2.INTER_NEAREST)
        scores = sorted(
            (float(np.min(np.mean(samples != patch, axis=(1, 2)))), char)
            for char, samples in self.templates.items() if char in allowed
        )
        if len(scores) < 2:
            return None
        score, char = scores[0]
        margin = scores[1][0] - score
        if score > self.MAX_DISTANCE or margin < self.MIN_MARGIN:
            return None
        return char, score, margin

    def read(self, gray: np.ndarray) -> ClockReading | None:
        if gray.ndim != 2 or gray.shape != (480, 640):
            return None
        mask = (gray[12:33, 390:640] > self.threshold).astype(np.uint8)
        _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        boxes = sorted(
            [tuple(map(int, s[:4])) for s in stats[1:]
             if s[4] >= 20 and 3 <= s[2] <= 9 and 8 <= s[3] <= 14],
            key=lambda item: item[0],
        )
        date_boxes = [b for b in boxes if b[0] < 136]
        time_boxes = [b for b in boxes if b[0] >= 136]
        if not 8 <= len(date_boxes) <= 10 or len(time_boxes) != 6:
            return None
        # A different timestamp layout is a different source profile, not a reason to guess.
        if any(abs(b[0] - x) > 2 for b, x in zip(time_boxes, (142, 156, 178, 192, 214, 228))):
            return None
        # Both colon dots must be present at their reviewed positions.
        for x in (170, 206):
            if np.count_nonzero(mask[9:13, x:x+2]) < 3 or np.count_nonzero(mask[15:18, x:x+2]) < 2:
                return None
        chars, distances, margins = [], [], []
        for index, (x, y, width, height) in enumerate(date_boxes + time_boxes):
            result = self._classify(mask[y:y+height, x:x+width], "0123456789/" if index < len(date_boxes) else "0123456789")
            if result is None:
                return None
            char, distance, margin = result
            chars.append(char)
            distances.append(distance)
            margins.append(margin)
        date_text = "".join(chars[:len(date_boxes)])
        if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{4}", date_text) is None:
            return None
        month, day, year = map(int, date_text.split("/"))
        digits = "".join(chars[len(date_boxes):])
        try:
            naive = datetime(year, month, day, int(digits[:2]), int(digits[2:4]), int(digits[4:]))
            if not 2000 <= year <= 2100:
                return None
            local = naive.replace(tzinfo=self.zone)
            # Fall-back ambiguity and spring-forward nonexistent wall times require more evidence.
            if local.utcoffset() != naive.replace(tzinfo=self.zone, fold=1).utcoffset():
                return None
            if local.astimezone(timezone.utc).astimezone(self.zone).replace(tzinfo=None) != naive:
                return None
        except ValueError:
            return None
        return ClockReading(local, max(distances), min(margins))


class CaltransClock(OverlayClock):
    """Explicit opt-in adapter; preserves the existing segment tick/latency checks.

    This clock is not evidence of synchronized UTC by itself. Caltrans's rendered
    clock can disagree with continuous media PTS; callers must retain continuity
    gates and may need to reject an otherwise readable source.
    """

    def __init__(self) -> None:
        super().__init__()
        self.reader = CaltransHeaderReader()
        self._reference_utc: float | None = None

    def _discover(self, gray: np.ndarray) -> bool:
        if self.reader.read(gray) is None:
            return False
        self.region_name = "caltrans_c008_header"
        self.roi = (12 / 480, 33 / 480, 390 / 640, 1.0)
        return True

    def _read_time(self, gray, region, variants=(0, 1)):
        reading = self.reader.read(gray)
        if reading is None:
            return None
        if self._reference_utc is not None:
            age = self._reference_utc - reading.utc
            # Full date validation prevents old clips with a matching time-of-day passing.
            if not self.MIN_LATENCY <= age <= self.MAX_LATENCY + 15:
                return None
        return reading.seconds_of_day

    def _anchor(self, data: bytes, fetched_at: float, duration: float) -> Anchor | None:
        if not 0 < duration <= 15:
            return None
        first = next(video.frames(data), None)
        if first is None:
            return None
        reading = self.reader.read(first[1].to_ndarray(format="gray", threads=1))
        if reading is None:
            return None
        age = fetched_at - reading.utc
        if not self.MIN_LATENCY <= age - duration <= self.MAX_LATENCY:
            return None
        self.offset = int(reading.local.utcoffset().total_seconds())
        self._reference_utc = fetched_at
        try:
            return super()._anchor(data, fetched_at, duration)
        finally:
            self._reference_utc = None
