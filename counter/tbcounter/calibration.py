"""Automatic counting-line placement from observed vehicle trajectories.

The dominant traffic axis is the principal eigenvector of Σ d·dᵀ over the unit
displacement vectors of good tracks (sign-invariant, so opposite carriageways agree).
The line is perpendicular to that axis, placed where the most tracks pass, and spans
the lateral extent of those tracks plus padding, clipped to the frame.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .rules import CLASSES, DIRECTIONS, Definition, Point, valid_definition


class NotEnoughTracks(Exception):
    pass


@dataclass
class Trajectory:
    points: list[tuple[float, float, float]] = field(default_factory=list)  # (t, x_px, y_px) bottom-centre
    labels: dict[str, int] = field(default_factory=dict)


class TrajectoryCollector:
    def __init__(self) -> None:
        self.tracks: dict[int, Trajectory] = {}

    def observe(self, track_id: int, label: str, xyxy: tuple[float, float, float, float], t: float) -> None:
        x1, _, x2, y2 = xyxy
        tr = self.tracks.setdefault(track_id, Trajectory())
        tr.points.append((t, (x1 + x2) / 2, y2))
        tr.labels[label] = tr.labels.get(label, 0) + 1


@dataclass(frozen=True)
class CalibrationResult:
    definition: Definition
    tracks_used: int
    tracks_seen: int
    coverage: int
    flow_axis: tuple[float, float]


def good_tracks(tracks: dict[int, Trajectory], width: int, height: int, min_points: int = 6,
                min_displacement: float = 0.06) -> list[np.ndarray]:
    diag = math.hypot(width, height)
    out = []
    for tr in tracks.values():
        if len(tr.points) < min_points:
            continue
        pts = np.array([(x, y) for _, x, y in tr.points], np.float64)
        if np.linalg.norm(pts[-1] - pts[0]) < min_displacement * diag:
            continue
        out.append(pts)
    return out


def _clip_segment(p0: np.ndarray, p1: np.ndarray, width: float, height: float, margin: float):
    """Liang–Barsky clip of segment p0→p1 to the frame (inset by margin)."""
    xmin, ymin, xmax, ymax = margin, margin, width - margin, height - margin
    d = p1 - p0
    t0, t1 = 0.0, 1.0
    for p, q in ((-d[0], p0[0] - xmin), (d[0], xmax - p0[0]), (-d[1], p0[1] - ymin), (d[1], ymax - p0[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            t0 = max(t0, r)
        else:
            t1 = min(t1, r)
        if t0 > t1:
            return None
    return p0 + t0 * d, p0 + t1 * d


def compute_line(tracks: dict[int, Trajectory], width: int, height: int, min_tracks: int = 8,
                 camera: str = "camera") -> CalibrationResult:
    good = good_tracks(tracks, width, height)
    if len(good) < min_tracks:
        raise NotEnoughTracks(f"{len(good)} usable vehicle tracks (need {min_tracks})")
    scatter = np.zeros((2, 2))
    for pts in good:
        d = pts[-1] - pts[0]
        d /= np.linalg.norm(d)
        scatter += np.outer(d, d)
    eigvals, eigvecs = np.linalg.eigh(scatter)
    flow = eigvecs[:, int(np.argmax(eigvals))]
    if flow[1] < 0 or (abs(flow[1]) < 1e-9 and flow[0] < 0):
        flow = -flow
    normal = np.array([-flow[1], flow[0]])
    spans = [(float((pts @ flow).min()), float((pts @ flow).max())) for pts in good]
    all_s = np.concatenate([pts @ flow for pts in good])
    candidates = np.linspace(np.percentile(all_s, 5), np.percentile(all_s, 95), 61)
    counts = np.array([sum(lo <= s <= hi for lo, hi in spans) for s in candidates])
    best = counts.max()
    plateau = candidates[counts >= max(math.ceil(0.9 * best), min_tracks)]
    if plateau.size == 0:
        raise NotEnoughTracks("no position is crossed by enough tracks")
    s_star = float(np.median(plateau))
    lateral = []
    for pts in good:
        s = pts @ flow
        for i in range(len(pts) - 1):
            a, b = s[i], s[i + 1]
            if (a - s_star) * (b - s_star) <= 0 and a != b:
                r = (s_star - a) / (b - a)
                lateral.append(float((pts[i] + r * (pts[i + 1] - pts[i])) @ normal))
                break
    if len(lateral) < min_tracks:
        raise NotEnoughTracks(f"only {len(lateral)} tracks reach the chosen position")
    lo, hi = float(np.percentile(lateral, 2)), float(np.percentile(lateral, 98))
    pad = 0.2 * (hi - lo) + 0.04 * math.hypot(width, height)
    p0 = s_star * flow + (lo - pad) * normal
    p1 = s_star * flow + (hi + pad) * normal
    clipped = _clip_segment(p0, p1, width, height, margin=2.0)
    if clipped is None:
        raise NotEnoughTracks("line falls outside the frame")
    c0, c1 = clipped
    start = Point(float(c0[0] / width), float(c0[1] / height))
    end = Point(float(c1[0] / width), float(c1[1] / height))
    within = sum(lo - pad <= v <= hi + pad for v in lateral)
    definition = Definition(
        label=f"Automatic line · {camera}"[:160],
        line_start=start, line_end=end, directions=DIRECTIONS, classes=CLASSES,
        notes=(f"Generated automatically by the AI counter from {len(good)} vehicle trajectories "
               f"({within} cross this position). Perpendicular to the dominant traffic flow; "
               f"both directions and all vehicle classes count; bottom-centre anchor, capture UTC.")[:1000],
    )
    if not valid_definition(definition):
        raise NotEnoughTracks("generated line is too short or invalid")
    return CalibrationResult(definition, len(good), len(tracks), int(best), (float(flow[0]), float(flow[1])))
