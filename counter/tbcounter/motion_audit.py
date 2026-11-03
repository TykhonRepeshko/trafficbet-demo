"""Audit observed moving objects, not every brightness change on a line.

Foreground is independent of semantic detection. A coherent unaccounted object
crossing still invalidates a round; static flicker and an expanding light patch
cannot by themselves prove a missed vehicle. This module never adds to a count.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import cv2
import numpy as np

from .detector import Detections
from .tracking import Tracker
from .rules import Point, crossing_candidate


def overlap(a, b):
    area = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0, min(a[3], b[3]) - max(a[1], b[1])
    )
    return area / max(
        1, min(np.prod(np.asarray(a[2:]) - a[:2]), np.prod(np.asarray(b[2:]) - b[:2]))
    )


@dataclass
class ObjectTrack:
    observations: list = field(default_factory=list)
    links: dict = field(default_factory=dict)
    stable: tuple | None = None
    crossing: object = None
    translation: float = 0.0
    explained_links: set = field(default_factory=set)


class MotionAudit:
    def __init__(self, rule, width, height, start, end, fps, scale, offset=(0, 0)):
        self.rule, self.width, self.height = rule, width, height
        self.start, self.end, self.fps, self.scale = start, end, fps, scale
        self.offset = np.array(offset, dtype=float)
        self.tracker = Tracker(fps, 0.3)
        self.tracks = {}
        self.last_at = start
        self.unresolved = []
        self.resolved = 0
        self.crossed_objects = 0

    def side(self, box):
        a, b = self.rule.line_start, self.rule.line_end
        px, py = (box[0] + box[2]) / 2, box[3]
        dx, dy = (b.x - a.x) * self.width, (b.y - a.y) * self.height
        return (dx * (py - a.y * self.height) - dy * (px - a.x * self.width)) / max(
            math.hypot(dx, dy), 1
        )

    def update(self, foreground, semantic, at):
        joined = cv2.morphologyEx(
            foreground, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)
        )
        _, _, stats, centroids = cv2.connectedComponentsWithStats(joined)
        boxes = []
        centers = []
        for (x, y, w, h, area), center in zip(stats[1:], centroids[1:]):
            if (
                min(w, h) < 3
                or not 20 <= area <= self.width * self.height * self.scale**2 * 0.12
                or not 0.15 < w / h < 8
                or area / (w * h) < 0.2
            ):
                continue
            boxes.append(
                np.array([x, y, x + w, y + h], float) / self.scale
                + np.tile(self.offset, 2)
            )
            centers.append(np.array(center, float) / self.scale + self.offset)
        detected = Detections(
            np.array(boxes, np.float32).reshape(-1, 4),
            np.full(len(boxes), 0.7, np.float32),
            ["vehicle"] * len(boxes),
        )
        for observed in self.tracker.update(detected, at):
            box = np.asarray(observed.xyxy, float)
            index = min(
                range(len(boxes)), key=lambda i: float(np.linalg.norm(box - boxes[i]))
            )
            center = centers[index]
            track = self.tracks.setdefault(observed.track_id, ObjectTrack())
            if track.observations:
                track.translation += float(
                    np.linalg.norm(center - track.observations[-1][2])
                )
            track.observations.append((at, box, center))
            # Links must come from measured boxes in the same frame. A later
            # detection on the far side alone cannot explain a missing pass.
            for known in semantic:
                if overlap(box, known.xyxy) >= 0.6:
                    track.links.setdefault(known.track_id, []).append(at)
            side = self.side(box)
            if abs(side) < 3 / self.scale:
                continue
            point = Point(
                float((box[0] + box[2]) / 2 / self.width), float(box[3] / self.height)
            )
            if track.stable is not None and track.crossing is None:
                before, before_at = track.stable
                crossing = crossing_candidate(
                    self.rule,
                    before,
                    point,
                    before_at,
                    at,
                    self.start,
                    self.end,
                    self.rule.classes[0],
                )
                if crossing is not None:
                    track.crossing = crossing
            track.stable = (point, at)
        self.last_at = at

    def coherent(self, track):
        samples = track.observations
        if track.crossing is not None:
            samples = [
                sample
                for sample in samples
                if track.crossing.at - 1.5 <= sample[0] <= track.crossing.at + 1
            ]
        if len(samples) < max(3, round(self.fps * 0.375)):
            return False
        first, last = samples[0], samples[-1]
        displacement = float(np.linalg.norm(last[2] - first[2]))
        diagonal = float(np.linalg.norm(last[1][2:] - last[1][:2]))
        path = sum(
            float(np.linalg.norm(b[2] - a[2])) for a, b in zip(samples, samples[1:])
        )
        # Box growth or a stationary lamp flickering must not be a trajectory.
        return (
            displacement >= max(3 / self.scale, 0.2 * diagonal)
            and displacement >= 0.55 * path
        )

    def stationary(self, track):
        samples = track.observations
        if len(samples) < max(4, round(self.fps * 0.5)):
            return False
        centers = np.array([sample[2] for sample in samples])
        return (
            float(np.linalg.norm(centers.max(axis=0) - centers.min(axis=0)))
            <= 3 / self.scale
        )

    def covers_stationary_region(self, at, region):
        return any(
            self.stationary(track)
            and any(
                abs(t - at) <= 0.13 and overlap(region, box) >= 0.7
                for t, box, _ in track.observations
            )
            for track in self.tracks.values()
        )

    def linked_vehicle_explains(self, track, known, times, counter):
        if len(times) < 2:
            return False
        passage = counter.confirmed_passage(known)
        if passage is not None:
            if track.crossing is None:
                return False
            if abs(passage["at"] - track.crossing.at) <= 1.25:
                return True
            # A long headlight reflection crosses before the physical body.
            # Require the SAME observed foreground identity to remain linked
            # around the actual body crossing, rather than matching a later car.
            return (
                len(times) >= 3
                and abs(passage["at"] - track.crossing.at) <= 4
                and track.observations[0][0]
                <= passage["at"]
                <= track.observations[-1][0]
                and min(times) <= passage["at"] <= max(times) + 0.25
            )
        state = counter.tracks.get(counter.alias.get(known, known))
        if (
            state is None
            or state.last is None
            or state.detector_strong < 3
            or not state.votes
            or len(times) < 3
            or max(times) < self.end - 0.5
            or state.last_at < self.end - 0.5
        ):
            return False
        # At the end of the window a classified body can still be BEFORE the
        # line, although its headlights have already illuminated the far side.
        # Explain that foreground only; never invent or count a future pass.
        a, b = self.rule.line_start, self.rule.line_end
        side = (b.x - a.x) * (state.last.y - a.y) - (b.y - a.y) * (state.last.x - a.x)
        velocity = (b.x - a.x) * state.velocity[1] - (b.y - a.y) * state.velocity[0]
        direction = (
            (1 if track.crossing.direction == "A_to_B" else -1)
            if track.crossing is not None
            else (1 if velocity > 0 else -1)
        )
        return side * direction < 0 and velocity * direction > 0

    def reconcile(self, counter):
        self.unresolved = []
        self.resolved = 0
        self.crossed_objects = 0
        for tid, track in self.tracks.items():
            track.explained_links.clear()
            if track.crossing is None:
                # The narrow line band may be lit before the foreground
                # centroid crosses. A continuously observed approaching body
                # can explain its own illumination without adding a pass.
                for known, times in track.links.items():
                    if self.linked_vehicle_explains(track, known, times, counter):
                        track.explained_links.add(known)
                # A moving object which disappears just before its predicted
                # crossing remains unresolved; a stationary fragment left by it
                # must not hide the missing approach.
                samples = track.observations
                if (
                    len(samples) >= 3
                    and self.coherent(track)
                    and samples[-1][0] + 0.5 < self.last_at
                ):
                    first, last = samples[-3], samples[-1]
                    dt = last[0] - first[0]
                    side = self.side(last[1])
                    velocity = (side - self.side(first[1])) / max(dt, 0.001)
                    size = min(last[1][2] - last[1][0], last[1][3] - last[1][1])
                    eta = -side / velocity if side * velocity < 0 else float("inf")
                    if (
                        abs(side) <= max(4 / self.scale, size * 0.75)
                        and 0 < eta < 0.75
                        and self.start <= last[0] + eta < self.end
                    ):
                        explained = any(
                            (p := counter.confirmed_passage(known)) is not None
                            and len(times) >= 2
                            and abs(p["at"] - (last[0] + eta)) <= 1.25
                            for known, times in track.links.items()
                        )
                        if not explained:
                            self.unresolved.append(
                                {
                                    "objectId": tid,
                                    "at": last[0] + eta,
                                    "observations": len(samples),
                                    "kind": "lost_approach",
                                }
                            )
                continue
            if not self.coherent(track):
                continue
            self.crossed_objects += 1
            explained = False
            for known, times in track.links.items():
                if self.linked_vehicle_explains(track, known, times, counter):
                    explained = True
                    track.explained_links.add(known)
            if explained:
                self.resolved += 1
            else:
                self.unresolved.append(
                    {
                        "objectId": tid,
                        "at": track.crossing.at,
                        "observations": len(track.observations),
                    }
                )
        return bool(self.unresolved)

    def evidence(self):
        return {
            "movingObjects": len(self.tracks),
            "coherentCrossings": self.crossed_objects,
            "explainedCrossings": self.resolved,
            "unexplainedCrossings": len(self.unresolved),
        }
