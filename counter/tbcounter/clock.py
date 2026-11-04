"""Capture-time anchoring from the timestamp the camera burns into its own frames.

The camera clock is the only trustworthy capture time available for these sources
(no EXT-X-PROGRAM-DATE-TIME). For each segment we OCR the overlay at the start of
the segment, find the frame where the displayed second ticks over and anchor the
segment's first PTS to UTC with roughly one-frame precision. A segment is only
anchored when every OCR result is self-consistent (s, then exactly s+1).
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass

import cv2
import numpy as np
import pytesseract

from . import video

TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})(?!\d)")
# (y0, y1, x0, x1) fractions searched once per camera; the timestamp box position differs between operators.
def _subregions(corner: str) -> list[tuple[float, float, float, float]]:
    """Nested search boxes for one corner: tight first (less scene), wider later."""
    out = []
    for height in (0.05, 0.065, 0.08):
        for width in (0.22, 0.35, 0.5):
            y0, y1 = (0.0, height) if corner.startswith("top") else (1 - height, 1.0)
            x0, x1 = (1 - width, 1.0) if corner.endswith("right") else (0.0, width)
            out.append((y0, y1, x0, x1))
    return out


# The timestamp box position differs between operators; searched once per camera.
CANDIDATE_REGIONS = {corner: _subregions(corner) for corner in ("top_right", "top_left", "bottom_right", "bottom_left")}
OCR_CONFIG = "--psm 7 -c tessedit_char_whitelist=0123456789-:"
# Generous: a busy host must not turn a readable clock into a coverage gap.
OCR_TIMEOUT = 15
DAY = 86400


@dataclass(frozen=True)
class Anchor:
    first_pts: float
    anchor_utc: float            # capture UTC of the segment's first frame
    precision: float             # ± seconds
    utc_offset_minutes: int
    latency: float               # fetch time minus capture time of the segment end
    displayed: str               # the overlay time used for anchoring (local HH:MM:SS)
    source: str = "ocr"          # "ocr" or "derived" (bridged from the previous segment's media clock)


def parse_time_of_day(text: str) -> int | None:
    matches = list(TIME_RE.finditer(text.replace(" ", "")))
    if not matches:
        return None
    hh, mm, ss = (int(v) for v in matches[-1].groups())
    if hh > 23 or mm > 59 or ss > 59:
        return None
    return hh * 3600 + mm * 60 + ss


def _crop(gray: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    h, w = gray.shape[:2]
    y0, y1, x0, x1 = box
    return gray[int(h * y0):max(int(h * y1), int(h * y0) + 8), int(w * x0):max(int(w * x1), int(w * x0) + 8)]


def prepare(crop: np.ndarray, variant: int = 0) -> np.ndarray:
    """variant 0: blur + 4× + Otsu (robust to compression ringing); variant 1: 3× greyscale (fallback)."""
    if variant == 0:
        crop = cv2.GaussianBlur(crop, (3, 3), 0)
    scale = 4 if variant == 0 else 3
    crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    if np.median(crop) < 128:  # light text on a dark box → dark text on light background
        crop = 255 - crop
    if variant == 0:
        crop = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    return cv2.copyMakeBorder(crop, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)


def ocr_time(gray: np.ndarray, roi: tuple[float, float, float, float], variants: tuple[int, ...] = (0, 1)) -> int | None:
    crop = _crop(gray, roi)
    for variant in variants:
        try:
            text = pytesseract.image_to_string(prepare(crop, variant), config=OCR_CONFIG, timeout=OCR_TIMEOUT)
        except (RuntimeError, pytesseract.TesseractError):
            continue
        value = parse_time_of_day(text)
        if value is not None:
            return value
    return None


def locate_time(gray: np.ndarray, region: tuple[float, float, float, float]) -> tuple[float, float, float, float] | None:
    """Fractional box around the time-of-day token inside a search box (rightmost token with ≥4 digits)."""
    h, w = gray.shape[:2]
    y0, _, x0, _ = region
    crop = _crop(gray, region)
    for variant in (1, 0):
        scale = 3 if variant == 1 else 4
        try:
            data = pytesseract.image_to_data(prepare(crop, variant), config="--psm 7",
                                             output_type=pytesseract.Output.DICT, timeout=OCR_TIMEOUT)
        except (RuntimeError, pytesseract.TesseractError):
            continue
        best = None
        for text, left, top, width, height in zip(data["text"], data["left"], data["top"], data["width"], data["height"]):
            if sum(ch.isdigit() for ch in text) >= 4 and width > 0 and (best is None or left > best[0]):
                best = (left, top, width, height)
        if best is None:
            continue
        left, top = (best[0] - 12) / scale, (best[1] - 12) / scale
        width, height = best[2] / scale, best[3] / scale
        pad_x, pad_y = height * 0.6, height * 0.35
        ox, oy = w * x0, h * y0
        roi = (max(oy + top - pad_y, 0) / h, min(oy + top + height + pad_y, h) / h,
               max(ox + left - pad_x, 0) / w, min(ox + left + width + pad_x, w) / w)
        if ocr_time(gray, roi) is not None:
            return roi
    return None


def local_to_utc(seconds_local: int, offset_seconds: int, reference_utc: float) -> float:
    """UTC epoch for a local time of day, choosing the calendar day closest to `reference_utc`."""
    utc_tod = (seconds_local - offset_seconds) % DAY
    midnight = reference_utc - (reference_utc % DAY)
    return min((midnight + utc_tod + k * DAY for k in (-1, 0, 1)), key=lambda c: abs(reference_utc - c))


def detect_offset(seconds_local: int, reference_utc: float) -> int:
    """Camera UTC offset in seconds, rounded to 15 minutes (valid while latency < 7.5 min)."""
    diff = ((seconds_local - (reference_utc % DAY) + DAY / 2) % DAY) - DAY / 2
    return int(round(diff / 900.0) * 900)


class OverlayClock:
    """Per-camera clock reader; remembers the overlay region and UTC offset."""

    MIN_LATENCY, MAX_LATENCY = -5.0, 180.0

    def __init__(self, variants: tuple[int, ...] = (0, 1)) -> None:
        self.ocr_variants = variants
        self.region_name: str | None = None
        self.roi: tuple[float, float, float, float] | None = None
        self._next_discovery = 0.0
        self.offset: int | None = None
        self._offset_votes: dict[int, int] = {}
        self._lock = threading.Lock()
        self.successes = 0
        self.failures = 0

    def _discover(self, gray: np.ndarray) -> bool:
        for name, boxes in CANDIDATE_REGIONS.items():
            for box in boxes:
                roi = locate_time(gray, box)
                if roi is not None:
                    self.region_name, self.roi = name, roi
                    return True
        return False

    def _read_time(self, gray, region, variants=None):
        return ocr_time(gray, region, self.ocr_variants if variants is None else variants)

    def anchor_segment(self, data: bytes, fetched_at: float, duration: float) -> Anchor | None:
        with self._lock:
            result = self._anchor(data, fetched_at, duration)
            if result is None:
                self.failures += 1
            else:
                self.successes += 1
            return result

    def _anchor(self, data: bytes, fetched_at: float, duration: float) -> Anchor | None:
        frames = video.first_frames_gray(data, 1.35)
        if len(frames) < 3:
            return None
        if self.roi is None:
            if fetched_at < self._next_discovery:
                return None  # no overlay found recently; don't burn CPU on every segment
            if not self._discover(frames[0][1]):
                self._next_discovery = fetched_at + (30 if self.failures < 3 else 300)
                return None
        region = self.roi
        cache: dict[int, int | None] = {}

        def read(i: int) -> int | None:
            if i not in cache:
                cache[i] = self._read_time(frames[i][1], region)
            return cache[i]

        def classify(i: int, s0: int, s1: int) -> int | None:
            """s0, s1 or None (unreadable / misread digits re-checked with the fallback preprocessing)."""
            value = read(i)
            if value in (s0, s1):
                return value
            alt = self._read_time(frames[i][1], region, variants=(1,))
            return alt if alt in (s0, s1) else None

        # The initial second is the majority of the first three frames (a tick inside 80 ms is rare).
        initial = [v for v in (read(i) for i in range(3)) if v is not None]
        s0 = max(set(initial), key=initial.count) if initial else None
        if s0 is None or initial.count(s0) < 2:
            return None
        s1 = (s0 + 1) % DAY
        first = next(i for i in range(3) if read(i) == s0)
        frame_dt = max((frames[-1][0] - frames[0][0]) / max(len(frames) - 1, 1), 1e-3)
        step = max(1, int(round(0.2 / frame_dt)))
        lo, hi, misses = first, None, 0
        i = first + step
        while i < len(frames):
            value = classify(i, s0, s1)
            if value is None:
                misses += 1
                if misses > 2:
                    return None
            elif value == s0:
                lo = i
            else:
                hi = i
                break
            i += step
        if hi is None:
            return None
        while hi - lo > 1:
            mid = (lo + hi) // 2
            value = classify(mid, s0, s1)
            if value == s0:
                lo = mid
                continue
            if value == s1:
                hi = mid
                continue
            # Unreadable frame: use its neighbours; the bracket only ever narrows on readings, never guesses.
            after = classify(mid + 1, s0, s1) if mid + 1 < hi else None
            before = classify(mid - 1, s0, s1) if mid - 1 > lo else None
            if after == s0:
                lo = mid + 1
            elif before == s1:
                hi = mid - 1
            elif (before == s0 or mid - 1 == lo) and (after == s1 or mid + 1 == hi):
                lo, hi = mid - 1, mid + 1  # tick is at mid or mid+1: precision widens to one frame
                break
            else:
                return None
        transition_pts = (frames[lo][0] + frames[hi][0]) / 2
        precision = (frames[hi][0] - frames[lo][0]) / 2
        offset = self.offset if self.offset is not None else detect_offset(s1, fetched_at)
        transition_utc = local_to_utc(s1, offset, fetched_at)
        first_pts = frames[0][0]
        anchor_utc = transition_utc - video.pts_delta(transition_pts, first_pts)
        latency = fetched_at - (anchor_utc + duration)
        if not self.MIN_LATENCY <= latency <= self.MAX_LATENCY:
            # Clock or offset changed (e.g. DST): only adopt a new offset after three agreeing segments.
            candidate = detect_offset(s1, fetched_at)
            self._offset_votes[candidate] = self._offset_votes.get(candidate, 0) + 1
            if self._offset_votes[candidate] >= 3:
                self.offset, self._offset_votes = candidate, {}
            return None
        if self.offset is None:
            self.offset = offset
        self._offset_votes.clear()
        hh, rem = divmod(s1, 3600)
        return Anchor(first_pts=first_pts, anchor_utc=anchor_utc, precision=precision,
                      utc_offset_minutes=offset // 60, latency=latency,
                      displayed=f"{hh:02d}:{rem // 60:02d}:{rem % 60:02d}")
