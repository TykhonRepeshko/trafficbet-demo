"""Frame sampling, round counting and calibration on buffered, clock-anchored footage."""

from __future__ import annotations

import time
import json
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass, field

import numpy as np

from . import framing, video
from .detector import TiledDetector, grid_tiles, line_tiles, wide_tiles
from .calibration import CalibrationResult, TrajectoryCollector, compute_line
from .rules import CrossingCounter, Definition, Point, in_road_regions
from .segments import Segment
from .tracking import Tracker
from .motion import MotionBridge

PRE_ROLL = 2.0  # seconds of tracking before the window so vehicles already have a track at its start
COVERAGES = ("line", "wide", "grid", "full")


def pre_roll_for(hybrid_motion: bool) -> float:
    return 10.0 if hybrid_motion else PRE_ROLL


def choose_coverage(line_count: int, wide_count: int) -> str:
    """Wide coverage costs ~1.7x CPU: worth it only where it finds clearly more vehicles on the same footage."""
    return "wide" if wide_count >= max(1.25 * line_count, line_count + 2) else "line"


def sample_frames(
    segments: list[Segment], start: float, end: float, fps: float
) -> Iterator[tuple[float, np.ndarray]]:
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
            yield t, frame.to_ndarray(format="bgr24", threads=1)
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
    motion: dict = field(default_factory=dict)
    quality_issues: list[str] = field(default_factory=list)


class RoundSession:
    """Counts one round incrementally as clock-anchored segments arrive.

    Feeding the window's segments one by one gives exactly the result of counting them in one pass, so the live
    count shown to viewers and the final settled count come from the same tracker and rule.
    """

    def __init__(
        self,
        detector,
        rule: Definition,
        start: float,
        end: float,
        fps: float,
        activation: float,
        coverage: str = "line",
        hybrid_motion: bool = False,
        motion_resolution: str = "legacy",
    ) -> None:
        if coverage not in COVERAGES:
            raise ValueError(f"unknown coverage {coverage!r}")
        self.detector, self.rule, self.start, self.end, self.fps = (
            detector,
            rule,
            start,
            end,
            fps,
        )
        self.coverage = coverage
        self.hybrid_motion = hybrid_motion
        self.motion_resolution = motion_resolution
        self.pre_roll = pre_roll_for(hybrid_motion)
        self.motion: MotionBridge | None = None
        self.tracker = Tracker(fps, activation)
        self.counter: CrossingCounter | None = None
        self.tiled: TiledDetector | None = None
        self.frames = self.detections = 0
        self.first_sig: framing.Signature | None = None
        self.width = self.height = 0
        self.detect_time = self.busy_time = 0.0
        self.tick, self.step = start - self.pre_roll, 1.0 / fps
        self.processed_until = start - self.pre_roll
        self.segments: list[Segment] = []
        self.complete = False
        self._last_frame: np.ndarray | None = None
        self.highlight_frames = deque(maxlen=320)
        self.last_highlight_at = float("-inf")
        self.highlighted_tracks: set[int] = set()

    def feed(
        self, seg: Segment, on_frame=None, on_progress=None, progress_every: float = 1.0
    ) -> None:
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
                self._frame(t, frame.to_ndarray(format="bgr24", threads=1), on_frame)
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
            self.counter = CrossingCounter(
                self.rule, self.start, self.end, self.width, self.height
            )
            if self.hybrid_motion:
                self.motion = MotionBridge(
                    self.rule,
                    self.width,
                    self.height,
                    self.start,
                    self.fps,
                    self.end,
                    resolution=self.motion_resolution,
                )
            self.first_sig = framing.signature(bgr)
            r = self.rule
            tiles = line_tiles(
                r.line_start.x,
                r.line_start.y,
                r.line_end.x,
                r.line_end.y,
                self.width,
                self.height,
            )
            extra = (
                wide_tiles(self.width, self.height) if self.coverage == "wide" else []
            )
            if self.coverage == "grid":
                tiles = grid_tiles(self.width, self.height)
            elif self.coverage == "full":
                # Large clear vehicles do not need crop seams or partial-body boxes.
                tiles = [(0, 0, self.width, self.height)]
            self.tiled = TiledDetector(self.detector, tiles, secondary=extra)
        d0 = time.perf_counter()
        dets = self.tiled.detect(bgr)
        if self.rule.road_regions:
            keep = np.array(
                [
                    i
                    for i, b in enumerate(dets.xyxy)
                    if in_road_regions(
                        self.rule.road_regions,
                        Point(
                            (float(b[0]) + float(b[2])) / 2 / self.width,
                            float(b[3]) / self.height,
                        ),
                    )
                ],
                dtype=int,
            )
            dets = type(dets)(
                dets.xyxy[keep],
                dets.confidence[keep],
                [dets.labels[i] for i in keep],
                [dets.source_at(i) for i in keep],
            )
        self.detect_time += time.perf_counter() - d0
        self.detections += len(dets)
        if self.motion is not None:
            dets = self.motion.augment(bgr, dets, t)
        boxes = self.tracker.update(dets, t)
        # Original neural measurements linked after ID confirmation.
        early = getattr(self.tracker, "take_early_observations", lambda: [])()
        history = {}
        for observed_at, box in early:
            history.setdefault(box.track_id, []).append(
                (observed_at, box.label, box.confidence, box.xyxy, box.source)
            )
        if self.motion is not None:
            boxes = self.motion.update(bgr, boxes, t)
        for box in boxes:
            self.counter.observe(
                box.track_id,
                box.label,
                box.confidence,
                box.xyxy,
                t,
                source=getattr(box, "source", None),
                history=history.get(box.track_id),
            )
        if self.motion is not None:
            self.motion.completed.update(
                crossing["trackId"] for crossing in self.counter.crossings
            )
            self.motion.completed.update(
                tid
                for tid, canonical in self.counter.alias.items()
                if canonical in self.motion.completed
            )
        counted = {c["trackId"] for c in self.counter.crossings}
        newly_visible = any(
            self.counter.alias.get(b.track_id, b.track_id)
            in counted - self.highlighted_tracks
            for b in boxes
        )
        if self.start <= t < self.end and (
            t - self.last_highlight_at >= 0.19 or newly_visible
        ):
            self.last_highlight_at = t
            highlights, highlighted_tracks = [], set()
            for box in sorted(boxes, key=lambda b: b.confidence, reverse=True):
                canonical = self.counter.alias.get(box.track_id, box.track_id)
                if canonical in highlighted_tracks:
                    continue
                x1, y1, x2, y2 = map(float, box.xyxy)
                x1, y1 = max(0.0, min(1.0, x1 / self.width)), max(
                    0.0, min(1.0, y1 / self.height)
                )
                x2, y2 = max(x1, min(1.0, x2 / self.width)), max(
                    y1, min(1.0, y2 / self.height)
                )
                if x2 > x1 and y2 > y1:
                    highlighted_tracks.add(canonical)
                    highlights.append(
                        {
                            "trackId": int(canonical),
                            "x": round(x1, 4),
                            "y": round(y1, 4),
                            "width": round(x2 - x1, 4),
                            "height": round(y2 - y1, 4),
                        }
                    )
            self.highlighted_tracks.update(b["trackId"] for b in highlights[:40] if b["trackId"] in counted)
            self.highlight_frames.append({"at": float(t), "boxes": highlights[:40]})
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
        counted_at = {int(c["trackId"]): c["at"] for c in crossings}
        # Keep measured positions before late class confirmation so a pulse
        # can be shown at its real crossing time, never later along the road.
        aliases = getattr(self.counter, "alias", {})
        frames = []
        for frame in self.highlight_frames:
            boxes, seen = [], set()
            for box in frame["boxes"]:
                canonical = aliases.get(box["trackId"], box["trackId"])
                at = counted_at.get(canonical)
                if at is None or canonical in seen or not at <= frame["at"] < at + 0.5:
                    continue
                seen.add(canonical)
                boxes.append(box | {"trackId": canonical})
            frames.append({"at": frame["at"], "boxes": boxes})
        payload = {
            "vehicleCount": len(crossings),
            "crossings": [
                {
                    "at": float(c["at"]),
                    "trackId": int(c["trackId"]),
                    "direction": c["direction"],
                    "class": c["class"],
                }
                for c in crossings
            ],
            "segments": [
                {
                    "seq": s.seq,
                    "startUtc": float(s.start),
                    "duration": round(s.duration, 3),
                }
                for s in self.segments
                if s.anchor is not None
            ][-40:],
            "processedUntil": float(self.processed_until),
            "highlights": frames,
        }

        # Display metadata stays inside the existing 64 KiB progress limit.
        # Keep the newest frames, including empty frames that clear old boxes.
        def too_large():
            return (
                sum(len(f["boxes"]) for f in payload["highlights"]) > 640
                or len(json.dumps(payload).encode()) > 60000
            )

        # Protect the first real box of every counted identity. Blindly dropping
        # every second frame used to erase cars that exited just after crossing.
        seen, protected = set(), set()
        for i, frame in enumerate(frames):
            ids = {b["trackId"] for b in frame["boxes"]}
            if ids - seen:
                protected.add(frame["at"])
            seen.update(ids)
        while payload["highlights"] and too_large():
            current = payload["highlights"]
            reduced = [
                f
                for i, f in enumerate(current)
                if f["at"] in protected or i % 2 == 0 or i == len(current) - 1
            ]
            if len(reduced) == len(current):
                # Preserve an identity's first box; spend the remaining budget
                # on current positions rather than repeated historical boxes.
                seen = set()
                reduced = []
                for i, frame in enumerate(current):
                    boxes = [
                        b
                        for b in frame["boxes"]
                        if b["trackId"] not in seen or i == len(current) - 1
                    ]
                    seen.update(b["trackId"] for b in boxes)
                    reduced.append({"at": frame["at"], "boxes": boxes})
                payload["highlights"] = reduced
                if too_large():
                    # Pathological payloads still respect the public API limit.
                    payload["highlights"] = []
                break
            payload["highlights"] = reduced
        return payload

    def analysis(self) -> RoundAnalysis:
        c = self.counter
        if self.motion is not None and c is not None:
            self.motion.reconcile(c)
        return RoundAnalysis(
            count=c.count if c else 0,
            crossings=c.crossings if c else [],
            frames=self.frames,
            expected_frames=int(
                round((self.end - self.start + self.pre_roll) * self.fps)
            ),
            detections=self.detections,
            tracks=len(c.tracks) if c else 0,
            first_sig=self.first_sig,
            last_sig=(
                framing.signature(self._last_frame)
                if self._last_frame is not None
                else None
            ),
            rejected=c.rejected if c else 0,
            width=self.width,
            height=self.height,
            seconds=self.busy_time,
            stitches=c.stitches if c else 0,
            duplicates=c.duplicates if c else 0,
            coverage=self.coverage,
            motion=self.motion.evidence() if self.motion else {},
            quality_issues=sorted(self.motion.issues) if self.motion else [],
            timings={
                "totalSeconds": round(self.busy_time, 3),
                "detectSeconds": round(self.detect_time, 3),
                "msPerFrame": round(1000 * self.busy_time / max(self.frames, 1), 1),
                "tiles": len(self.tiled.tiles) if self.tiled else 0,
            },
        )


def count_round(
    detector,
    segments: list[Segment],
    rule: Definition,
    start: float,
    end: float,
    fps: float,
    activation: float,
    on_frame=None,
    coverage: str = "line",
    hybrid_motion: bool = False,
    motion_resolution: str = "legacy",
) -> RoundAnalysis:
    session = RoundSession(
        detector,
        rule,
        start,
        end,
        fps,
        activation,
        coverage,
        hybrid_motion,
        motion_resolution,
    )
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


def calibrate(
    detector,
    segments: list[Segment],
    fps: float,
    activation: float,
    min_tracks: int,
    camera: str,
) -> CalibrationRun:
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
        return CalibrationRun(
            None, reference, frames, time.perf_counter() - began, str(exc)
        )
