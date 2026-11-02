"""Frame sampling, round counting and calibration on buffered, clock-anchored footage."""
from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field

import numpy as np

from . import framing, video
from .detector import TiledDetector, grid_tiles, line_tiles, wide_tiles
from .calibration import CalibrationResult, TrajectoryCollector, compute_line
from .rules import CrossingCounter, Definition
from .segments import Segment
from .tracking import Tracker

PRE_ROLL = 2.0  # seconds of tracking before the window so vehicles already have a track at its start
COVERAGES = ("line", "wide")  # detection around the line only, or additionally over the whole frame


def choose_coverage(line_count: int, wide_count: int) -> str:
    """Wide coverage costs ~1.7x CPU: worth it only where it finds clearly more vehicles on the same footage."""
    return "wide" if wide_count >= max(1.25 * line_count, line_count + 2) else "line"


def sample_frames(segments: list[Segment], start: float, end: float, fps: float) -> Iterator[tuple[float, np.ndarray]]:
    """Yield (capture_utc, bgr) for the first frame at or after each 1/fps tick in [start, end)."""
    tick, step = start, 1.0 / fps
    for seg in segments:
        anchor = seg.anchor
        if anchor is None or seg.end <= tick:
            continue
        for pts, frame in video.frames(seg.data):
            t = anchor.anchor_utc + video.pts_delta(pts, anchor.first_pts)
            if t >= end:
                return
            if t + 1e-6 < tick:
                continue
            yield t, frame.to_ndarray(format="bgr24")
            while tick <= t + 1e-6:
                tick += step


@dataclass
class RoundAnalysis:
    count: int
    crossings: list[dict]
    frames: int
    expected_frames: int
    detections: int
    tracks: int
    rejected: int
    first_sig: framing.Signature | None
    last_sig: framing.Signature | None
    width: int
    height: int
    seconds: float
    timings: dict = field(default_factory=dict)
    stitches: int = 0
    duplicates: int = 0
    coverage: str = "line"


class RoundSession:
    """Counts one round incrementally as clock-anchored segments arrive.

    Feeding the window's segments one by one gives exactly the result of counting them in one pass, so the live
    count shown to viewers and the final settled count come from the same tracker and rule."""

    def __init__(self, detector, rule: Definition, start: float, end: float, fps: float, activation: float,
                 coverage: str = "line") -> None:
        if coverage not in COVERAGES:
            raise ValueError(f"unknown coverage {coverage!r}")
        self.detector, self.rule, self.start, self.end, self.fps = detector, rule, start, end, fps
        self.coverage = coverage
        self.tracker = Tracker(fps, activation)
        self.counter: CrossingCounter | None = None
        self.tiled: TiledDetector | None = None
        self.frames = self.detections = 0
        self.first_sig: framing.Signature | None = None
        self.width = self.height = 0
        self.detect_time = self.busy_time = 0.0
        self.tick, self.step = start - PRE_ROLL, 1.0 / fps
        self.processed_until = start - PRE_ROLL
        self.segments: list[Segment] = []
        self.complete = False
        self._last_frame: np.ndarray | None = None

    def feed(self, seg: Segment, on_frame=None, on_progress=None, progress_every: float = 2.0) -> None:
        """Process one segment. `on_progress` is called each `progress_every` seconds of footage, so viewers see
        the count rise within the segment rather than once per 8–12 s segment."""
        began = time.perf_counter()
        next_report = self.processed_until + progress_every
        self.segments.append(seg)
        anchor = seg.anchor
        if anchor is not None and not self.complete and seg.end > self.tick:
            for pts, frame in video.frames(seg.data):
                t = anchor.anchor_utc + video.pts_delta(pts, anchor.first_pts)
                if t >= self.end:
                    self.complete = True
                    break
                if t + 1e-6 < self.tick:
                    continue
                self._frame(t, frame.to_ndarray(format="bgr24"), on_frame)
                while self.tick <= t + 1e-6:
                    self.tick += self.step
                if on_progress is not None and t >= next_report:
                    self.processed_until = max(self.processed_until, min(t, self.end))
                    on_progress(self.progress())
                    next_report = t + progress_every
        if anchor is not None:
            self.processed_until = max(self.processed_until, min(seg.end, self.end))
            if seg.end >= self.end:
                self.complete = True
        self.busy_time += time.perf_counter() - began

    def _frame(self, t: float, bgr: np.ndarray, on_frame) -> None:
        if self.counter is None:
            self.height, self.width = bgr.shape[:2]
            self.counter = CrossingCounter(self.rule, self.start, self.end, self.width, self.height)
            self.first_sig = framing.signature(bgr)
            r = self.rule
            tiles = line_tiles(r.line_start.x, r.line_start.y, r.line_end.x, r.line_end.y, self.width, self.height)
            extra = wide_tiles(self.width, self.height) if self.coverage == "wide" else []
            self.tiled = TiledDetector(self.detector, tiles, secondary=extra)
        d0 = time.perf_counter()
        dets = self.tiled.detect(bgr)
        self.detect_time += time.perf_counter() - d0
        self.detections += len(dets)
        boxes = self.tracker.update(dets, t)
        for box in boxes:
            self.counter.observe(box.track_id, box.label, box.confidence, box.xyxy, t)
        if on_frame is not None:
            on_frame(t, bgr, boxes, self.counter)
        self.frames += 1
        self._last_frame = bgr

    @property
    def count(self) -> int:
        return self.counter.count if self.counter else 0

    def progress(self) -> dict:
        """Live view for the backend: counted crossings so far and the capture clock of each fed segment
        (including the one being processed, so players can map the frame on screen)."""
        crossings = self.counter.crossings if self.counter else []
        return {
            "vehicleCount": len(crossings),
            "crossings": [{"at": round(c["at"], 3), "direction": c["direction"], "class": c["class"]} for c in crossings],
            "segments": [{"seq": s.seq, "startUtc": round(s.start, 3), "duration": round(s.duration, 3)}
                         for s in self.segments if s.anchor is not None][-40:],
            "processedUntil": round(self.processed_until, 3),
        }

    def analysis(self) -> RoundAnalysis:
        c = self.counter
        return RoundAnalysis(
            count=c.count if c else 0, crossings=c.crossings if c else [],
            frames=self.frames, expected_frames=int(round((self.end - self.start + PRE_ROLL) * self.fps)),
            detections=self.detections, tracks=len(c.tracks) if c else 0, first_sig=self.first_sig,
            last_sig=framing.signature(self._last_frame) if self._last_frame is not None else None,
            rejected=c.rejected if c else 0, width=self.width, height=self.height, seconds=self.busy_time,
            stitches=c.stitches if c else 0, duplicates=c.duplicates if c else 0, coverage=self.coverage,
            timings={"totalSeconds": round(self.busy_time, 3), "detectSeconds": round(self.detect_time, 3),
                     "msPerFrame": round(1000 * self.busy_time / max(self.frames, 1), 1),
                     "tiles": len(self.tiled.tiles) if self.tiled else 0})


def count_round(detector, segments: list[Segment], rule: Definition, start: float, end: float, fps: float,
                activation: float, on_frame=None, coverage: str = "line") -> RoundAnalysis:
    session = RoundSession(detector, rule, start, end, fps, activation, coverage)
    for seg in segments:
        session.feed(seg, on_frame)
        if session.complete:
            break
    return session.analysis()


@dataclass
class CalibrationRun:
    result: CalibrationResult | None
    reference_bgr: np.ndarray | None
    frames: int
    seconds: float
    error: str = ""


def calibrate(detector, segments: list[Segment], fps: float, activation: float, min_tracks: int,
              camera: str) -> CalibrationRun:
    """Track vehicles over continuous footage and derive a counting line."""
    from .calibration import NotEnoughTracks
    began = time.perf_counter()
    anchored = [s for s in segments if s.anchor is not None]
    if not anchored:
        return CalibrationRun(None, None, 0, 0.0, "no anchored footage")
    start, end = anchored[0].start, anchored[-1].end
    tracker, collector = Tracker(fps, activation), TrajectoryCollector()
    frames, reference, width, height, tiled = 0, None, 0, 0, None
    for t, bgr in sample_frames(anchored, start, end, fps):
        height, width = bgr.shape[:2]
        if tiled is None:
            tiled = TiledDetector(detector, grid_tiles(width, height))
        for box in tracker.update(tiled.detect(bgr), t):
            collector.observe(box.track_id, box.label, box.xyxy, t)
        frames += 1
        reference = bgr
    try:
        result = compute_line(collector.tracks, width, height, min_tracks, camera)
        return CalibrationRun(result, reference, frames, time.perf_counter() - began)
    except NotEnoughTracks as exc:
        return CalibrationRun(None, reference, frames, time.perf_counter() - began, str(exc))
