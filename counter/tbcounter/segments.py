"""Rolling per-camera buffer of anchored HLS segments and window coverage checks."""
from __future__ import annotations

import threading
from dataclasses import dataclass, field, replace

from . import video
from .clock import Anchor

CONTINUITY_TOLERANCE = 0.6  # seconds between camera-clock anchors and media timing


@dataclass
class Segment:
    seq: int
    duration: float
    data: bytes
    fetched_at: float
    discontinuity: bool = False
    anchor: Anchor | None = None
    first_pts: float | None = None
    width: int = 0
    height: int = 0

    @property
    def start(self) -> float | None:
        return self.anchor.anchor_utc if self.anchor else None

    @property
    def end(self) -> float | None:
        return self.anchor.anchor_utc + self.duration if self.anchor else None


@dataclass
class Coverage:
    segments: list[Segment] = field(default_factory=list)
    covered: bool = False
    reason: str = ""
    gap_seconds: float = 0.0

    def evidence(self) -> dict:
        anchors = [s.anchor for s in self.segments if s.anchor]
        return {
            "segmentSequences": [s.seq for s in self.segments],
            "firstCaptureUtc": self.segments[0].start if self.segments else None,
            "lastCaptureUtc": self.segments[-1].end if self.segments else None,
            "gapSeconds": round(self.gap_seconds, 3),
            "maxAnchorPrecisionMs": round(max((a.precision for a in anchors), default=0) * 1000, 1),
            "derivedAnchors": sum(1 for a in anchors if a.source == "derived"),
        }


def continuous(a: Segment, b: Segment) -> tuple[bool, float]:
    """Whether segment b directly follows a: consecutive sequence and agreeing clocks. Returns (ok, gap)."""
    if a.anchor is None or b.anchor is None:
        return False, b.duration
    gap = b.anchor.anchor_utc - (a.anchor.anchor_utc + a.duration)
    if b.seq != a.seq + 1:
        return False, max(gap, 0.0)
    if not b.discontinuity:
        media = video.pts_delta(b.anchor.first_pts, a.anchor.first_pts)
        clock = b.anchor.anchor_utc - a.anchor.anchor_utc
        if abs(media - clock) > CONTINUITY_TOLERANCE:
            return False, max(gap, 0.0)
    return abs(gap) <= CONTINUITY_TOLERANCE, max(gap, 0.0)


class SegmentBuffer:
    def __init__(self, keep_seconds: float) -> None:
        self.keep_seconds = keep_seconds
        self._segments: dict[int, Segment] = {}
        self._lock = threading.Lock()

    MAX_DERIVED_RUN = 2

    def add(self, segment: Segment) -> None:
        with self._lock:
            self._segments[segment.seq] = segment
            newest = max(s.fetched_at for s in self._segments.values())
            for seq in [k for k, s in self._segments.items() if newest - s.fetched_at > self.keep_seconds]:
                del self._segments[seq]
            self._bridge()

    def _bridge(self) -> None:
        """Anchor an isolated OCR miss from its OCR-anchored predecessor via the continuous media clock.

        The following OCR anchor must still agree (checked by `continuous`), so a wrong bridge breaks coverage
        instead of silently shifting time."""
        ordered = sorted(self._segments.values(), key=lambda s: s.seq)
        run = 0
        for prev, cur in zip(ordered, ordered[1:]):
            if cur.anchor is not None:
                run = run + 1 if cur.anchor.source == "derived" else 0
                continue
            if (prev.anchor is None or cur.first_pts is None or cur.discontinuity or cur.seq != prev.seq + 1
                    or run >= self.MAX_DERIVED_RUN):
                run = 0
                continue
            delta = video.pts_delta(cur.first_pts, prev.anchor.first_pts)
            if abs(delta - prev.duration) > CONTINUITY_TOLERANCE:
                run = 0
                continue
            cur.anchor = replace(prev.anchor, first_pts=cur.first_pts, anchor_utc=prev.anchor.anchor_utc + delta,
                                 latency=cur.fetched_at - (prev.anchor.anchor_utc + delta + cur.duration),
                                 source="derived")
            run += 1

    def has(self, seq: int) -> bool:
        with self._lock:
            return seq in self._segments

    def snapshot(self) -> list[Segment]:
        with self._lock:
            return sorted(self._segments.values(), key=lambda s: s.seq)

    def newest_end(self) -> float | None:
        ends = [s.end for s in self.snapshot() if s.end is not None]
        return max(ends) if ends else None

    def coverage(self, start: float, end: float) -> Coverage:
        """Continuous anchored footage covering [start, end)."""
        anchored = [s for s in self.snapshot() if s.anchor is not None]
        first = next((i for i, s in enumerate(anchored) if s.start <= start < s.end), None)
        if first is None:
            if anchored and anchored[-1].end <= start:
                return Coverage(reason="footage_not_yet_available")
            return Coverage(reason="window_start_not_in_buffer")
        chain = [anchored[first]]
        gap_total = 0.0
        while chain[-1].end < end:
            nxt = next((s for s in anchored if s.seq == chain[-1].seq + 1), None)
            if nxt is None:
                newest = max(s.seq for s in self.snapshot())
                reason = "footage_not_yet_available" if newest <= chain[-1].seq else "missing_or_unanchored_segment"
                return Coverage(segments=chain, reason=reason, gap_seconds=gap_total)
            ok, gap = continuous(chain[-1], nxt)
            gap_total += gap
            if not ok:
                return Coverage(segments=chain + [nxt], reason="discontinuous_footage", gap_seconds=gap_total)
            chain.append(nxt)
        return Coverage(segments=chain, covered=True, gap_seconds=gap_total)
