"""Counting definition and crossing rule.

`crossing_candidate` is a line-by-line port of the Go `crossingCandidate`
(backend/internal/app/crossing_rules.go) and `valid_definition` mirrors
`validCountingDefinition` (backend/internal/app/counting_profiles.go), so the
worker never counts or publishes anything the backend would interpret differently.
Times are UTC epoch seconds (float); points are normalised image coordinates.
"""

from __future__ import annotations

from .evidence import DETECTOR, PIXEL_MOTION, observation_source

import math
from collections import deque
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

Box = tuple[float, float, float, float]
Observation = tuple[float, str, float, Box, str | None]

DIRECTIONS = ("A_to_B", "B_to_A")
CLASSES = ("car", "van", "bus", "truck", "motorcycle")


@dataclass(frozen=True)
class Point:
    x: float
    y: float

    def to_json(self) -> dict[str, float]:
        return {"x": round(self.x, 6), "y": round(self.y, 6)}


@dataclass(frozen=True)
class Definition:
    label: str
    line_start: Point
    line_end: Point
    directions: tuple[str, ...]
    classes: tuple[str, ...]
    anchor: str = "bottom_center"
    time_basis: str = "capture_utc"
    notes: str = ""
    road_regions: tuple[tuple[Point, ...], ...] = ()

    @staticmethod
    def from_json(data: dict[str, Any]) -> "Definition":
        return Definition(
            label=str(data.get("label", "")),
            line_start=Point(
                float(data["lineStart"]["x"]), float(data["lineStart"]["y"])
            ),
            line_end=Point(float(data["lineEnd"]["x"]), float(data["lineEnd"]["y"])),
            directions=tuple(data.get("directions") or ()),
            classes=tuple(data.get("classes") or ()),
            anchor=str(data.get("anchor", "")),
            time_basis=str(data.get("timeBasis", "")),
            notes=str(data.get("notes", "")),
            road_regions=tuple(
                tuple(Point(float(p["x"]), float(p["y"])) for p in polygon)
                for polygon in (data.get("roadRegions") or ())
            ),
        )

    def to_json(self) -> dict[str, Any]:
        result = {
            "label": self.label,
            "lineStart": self.line_start.to_json(),
            "lineEnd": self.line_end.to_json(),
            "directions": list(self.directions),
            "classes": list(self.classes),
            "anchor": self.anchor,
            "timeBasis": self.time_basis,
            "notes": self.notes,
        }
        if self.road_regions:
            result["roadRegions"] = [
                [p.to_json() for p in polygon] for polygon in self.road_regions
            ]
        return result


@dataclass(frozen=True)
class Crossing:
    direction: str
    at: float
    vehicle_class: str


def _valid_text(value: str, minimum: int, maximum: int) -> bool:
    # Mirrors Go validEvidenceText: trimmed rune count >= min, raw rune count <= max, no control characters.
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        return False
    return len(value.strip()) >= minimum and len(value) <= maximum


def _finite_unit(p: Point) -> bool:
    return all(
        not math.isnan(v) and not math.isinf(v) and 0 <= v <= 1 for v in (p.x, p.y)
    )


def valid_definition(d: Definition) -> bool:
    if not _valid_text(d.label, 1, 160) or not _valid_text(d.notes, 20, 1000):
        return False
    if not _finite_unit(d.line_start) or not _finite_unit(d.line_end):
        return False
    if math.hypot(d.line_start.x - d.line_end.x, d.line_start.y - d.line_end.y) < 0.05:
        return False
    if d.anchor != "bottom_center" or d.time_basis != "capture_utc":
        return False

    def valid_list(values: tuple[str, ...], allowed: tuple[str, ...]) -> bool:
        return (
            0 < len(values) <= len(allowed)
            and len(set(values)) == len(values)
            and all(v in allowed for v in values)
        )

    return (
        valid_road_regions(d.road_regions)
        and valid_list(d.directions, DIRECTIONS)
        and valid_list(d.classes, CLASSES)
    )


def _edge_side(a, b, p):
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)


def _edge_contains(a, b, p):
    return (
        abs(_edge_side(a, b, p)) <= 1e-9
        and min(a.x, b.x) - 1e-9 <= p.x <= max(a.x, b.x) + 1e-9
        and min(a.y, b.y) - 1e-9 <= p.y <= max(a.y, b.y) + 1e-9
    )


def valid_road_regions(regions):
    if len(regions) > 8:
        return False
    for polygon in regions:
        if not 3 <= len(polygon) <= 12 or not all(_finite_unit(p) for p in polygon):
            return False
        area = 0.0
        for i, a in enumerate(polygon):
            b = polygon[(i + 1) % len(polygon)]
            if math.hypot(a.x - b.x, a.y - b.y) < 1e-5:
                return False
            area += a.x * b.y - b.x * a.y
            for j in range(i + 1, len(polygon)):
                if j == i + 1 or (i == 0 and j == len(polygon) - 1):
                    continue
                c, e = polygon[j], polygon[(j + 1) % len(polygon)]
                if (
                    _edge_contains(a, b, c)
                    or _edge_contains(a, b, e)
                    or _edge_contains(c, e, a)
                    or _edge_contains(c, e, b)
                    or (
                        _edge_side(a, b, c) * _edge_side(a, b, e) < 0
                        and _edge_side(c, e, a) * _edge_side(c, e, b) < 0
                    )
                ):
                    return False
        if abs(area) < 0.0002:
            return False
    return True


def in_road_regions(regions, p):
    if not regions:
        return True
    for polygon in regions:
        inside = False
        for i, a in enumerate(polygon):
            b = polygon[(i + 1) % len(polygon)]
            if _edge_contains(a, b, p):
                return True
            if (a.y > p.y) != (b.y > p.y) and p.x < (b.x - a.x) * (p.y - a.y) / (
                b.y - a.y
            ) + a.x:
                inside = not inside
        if inside:
            return True
    return False


def crossing_candidate(
    rule: Definition,
    before: Point,
    after: Point,
    before_at: float,
    after_at: float,
    start: float,
    end: float,
    vehicle_class: str,
) -> Crossing | None:
    """Return the crossing between two consecutive observations of one track, if it counts."""
    if not valid_definition(rule) or not after_at > before_at or not end > start:
        return None
    if vehicle_class not in rule.classes and not (
        vehicle_class == "vehicle" and set(CLASSES).issubset(rule.classes)
    ):
        return None
    for p in (before, after):
        if p.x < 0 or p.x > 1 or p.y < 0 or p.y > 1 or p.x != p.x or p.y != p.y:
            return None
    ls, le = rule.line_start, rule.line_end

    def side(p: Point) -> float:
        return (le.x - ls.x) * (p.y - ls.y) - (le.y - ls.y) * (p.x - ls.x)

    a, b = side(before), side(after)
    if a < 0 and b > 0:
        direction = "A_to_B"
    elif a > 0 and b < 0:
        direction = "B_to_A"
    else:
        return None
    if direction not in rule.directions:
        return None
    ratio = a / (a - b)
    x = before.x + (after.x - before.x) * ratio
    y = before.y + (after.y - before.y) * ratio
    dx, dy = le.x - ls.x, le.y - ls.y
    along = ((x - ls.x) * dx + (y - ls.y) * dy) / (dx * dx + dy * dy)
    if along < 0 or along > 1 or not in_road_regions(rule.road_regions, Point(x, y)):
        return None
    at = before_at + ratio * (after_at - before_at)
    if at < start or not at < end:
        return None
    return Crossing(direction=direction, at=at, vehicle_class=vehicle_class)


def _line_side(rule: Definition, p: Point) -> float:
    ls, le = rule.line_start, rule.line_end
    return (le.x - ls.x) * (p.y - ls.y) - (le.y - ls.y) * (p.x - ls.x)


@dataclass
class _TrackState:
    last: Point | None = None
    last_at: float = 0.0
    votes: dict[str, float] = field(default_factory=dict)
    areas: list[float] = field(default_factory=list)
    strong: int = 0
    detector_strong: int = 0
    coarse_strong: int = 0
    crossing: dict[str, Any] | None = None
    passage: dict[str, Any] | None = (
        None  # observed pass, including pre-roll, for motion reconciliation only
    )
    size: float = 0.0  # last accepted box diagonal, normalised by the frame diagonal
    velocity: tuple[float, float] = (
        0.0,
        0.0,
    )  # anchor motion, normalised frame units per second
    moves: int = 0  # velocity samples so far
    stitched: bool = False  # already continued by a newer track id
    initial_footprint: list[Observation] = field(default_factory=list)
    observations: deque[tuple[float, Box]] = field(default_factory=lambda: deque(maxlen=32))


class CrossingCounter:
    """Applies the frozen rule to tracked observations; first allowed crossing per track only.

    Detector-quality gates (the geometric rule itself is identical to the backend's):
    * weak (< min_conf) or implausibly resized boxes never move the track's anchor point;
    * a crossing counts only for tracks seen confidently (>= strong_conf) at least `min_strong` times.

    Track stitching: at night, motion blur and headlight glare often make the tracker drop a vehicle and start a
    new id a few frames later — frequently right at the line, so neither fragment alone crosses it. A new id that
    appears within `stitch_gap` seconds next to where an uncrossed track was lost continues that track.
    """

    def __init__(
        self,
        rule: Definition,
        start: float,
        end: float,
        width: int,
        height: int,
        min_conf: float = 0.2,
        strong_conf: float = 0.35,
        min_strong: int = 2,
        max_area_jump: float = 3.5,
        stitch_gap: float = 0.8,
        stitch_reach: float = 1.2,
        duplicate_gap: float = 0.35,
        duplicate_overlap: float = 0.6,
    ) -> None:
        self.rule, self.start, self.end, self.width, self.height = (
            rule,
            start,
            end,
            width,
            height,
        )
        self.min_conf, self.strong_conf, self.min_strong, self.max_area_jump = (
            min_conf,
            strong_conf,
            min_strong,
            max_area_jump,
        )
        self.stitch_gap, self.stitch_reach = stitch_gap, stitch_reach
        self.duplicate_gap, self.duplicate_overlap = duplicate_gap, duplicate_overlap
        self.tracks: dict[int, _TrackState] = {}
        self.alias: dict[int, int] = {}
        self.stitches = 0
        self.footprint_resets = 0
        self._visible_at: float | None = None
        self._visible_ids: set[int] = set()
        self._raw: dict[int, deque] = {}
        self._raw_truncated: set[int] = set()
        self._rebuilding = False
        self.identity_splits = 0
        self.issues: set[str] = set()
        self._distinct_cache: tuple[list[dict[str, Any]], int] | None = None

    def begin_frame(self, at: float, track_ids: Iterable[int]) -> None:
        """Declare coexisting IDs and undo a stitch when its original ID returns."""
        visible = set(track_ids)
        groups: dict[int, set[int]] = {}
        for tid in visible:
            groups.setdefault(self.alias.get(tid, tid), set()).add(tid)
        for canonical, members in groups.items():
            if len(members) > 1:
                self._split_reappearing_ids(canonical)
        self._visible_at = float(at)
        self._visible_ids = {self.alias.get(tid, tid) for tid in visible}

    def _split_reappearing_ids(self, canonical: int) -> None:
        members = {canonical} | {tid for tid, target in self.alias.items() if target == canonical}
        old = self.tracks.get(canonical)
        # A correction after a published crossing, or without a complete raw
        # history, cannot certify a settlement. Keep the existing refund gate.
        if (old is not None and old.crossing is not None) or members & self._raw_truncated:
            self.issues.add("conflicting_vehicle_identities")
        for tid in members:
            self.alias.pop(tid, None)
            self.tracks.pop(tid, None)
        self._rebuilding = True
        try:
            for tid in members:
                for at, label, score, box, source, history in self._raw.get(tid, ()):
                    self._observe(tid, label, score, box, at, source, history)
        finally:
            self._rebuilding = False
        self.identity_splits += 1
        self._distinct_cache = None

    def _stitch(self, track_id: int, point: Point, size: float, at: float) -> int:
        """Id whose state a brand-new track continues (itself when nothing fits)."""
        if self._rebuilding or self.stitch_gap <= 0:
            return track_id
        best, best_distance = None, None
        for tid, state in self.tracks.items():
            if (
                state.stitched
                or (at == self._visible_at and tid in self._visible_ids)
                or state.crossing is not None
                or state.last is None
                or not 0 < at - state.last_at <= self.stitch_gap
            ):
                continue
            # Where the lost vehicle would be now: a stopped car cannot reappear beyond the line.
            dt = at - state.last_at
            px, py = (
                state.last.x + state.velocity[0] * dt,
                state.last.y + state.velocity[1] * dt,
            )
            distance = self._diag_fraction(
                (point.x - px) * self.width, (point.y - py) * self.height
            )
            if (
                _line_side(self.rule, state.last) * _line_side(self.rule, point) < 0
                and _line_side(self.rule, Point(px, py)) * _line_side(self.rule, point)
                <= 0
            ):
                continue  # the join would credit a crossing the lost vehicle could not have made by now
            reach = self.stitch_reach * max(state.size, size, 0.02)
            if distance <= reach and (
                best_distance is None or distance < best_distance
            ):
                best, best_distance = tid, distance
        if best is None:
            return track_id
        self.tracks[best].stitched = True
        self.stitches += 1
        return best

    def _diag_fraction(self, dx: float, dy: float) -> float:
        return math.hypot(dx, dy) / math.hypot(self.width, self.height)

    def observe(
        self,
        track_id: int,
        vehicle_class: str,
        confidence: float,
        xyxy: tuple[float, float, float, float],
        at: float,
        source: str | None = None,
        history: list[Observation] | None = None,
    ) -> None:
        rows = self._raw.setdefault(track_id, deque(maxlen=96))
        row = (float(at), vehicle_class, float(confidence), tuple(map(float, xyxy)), source, history)
        if rows and rows[-1][0] == float(at):
            rows[-1] = row
        else:
            if len(rows) == rows.maxlen:
                self._raw_truncated.add(track_id)
            rows.append(row)
        self._observe(track_id, vehicle_class, confidence, xyxy, at, source, history)

    def _observe(
        self,
        track_id: int,
        vehicle_class: str,
        confidence: float,
        xyxy: tuple[float, float, float, float],
        at: float,
        source: str | None = None,
        history: list[Observation] | None = None,
    ) -> None:
        self._distinct_cache = None
        # NumPy float32 coordinates must not promote epoch-second arithmetic to
        # float32 (which would lose whole seconds and break window boundaries).
        x1, y1, x2, y2 = (float(v) for v in xyxy)
        confidence, at = float(confidence), float(at)
        source = observation_source(vehicle_class, source)
        if track_id in self.alias:
            track_id = self.alias[track_id]
        elif track_id not in self.tracks and confidence >= self.min_conf:
            point = Point(
                min(max((x1 + x2) / 2 / self.width, 0.0), 1.0),
                min(max(y2 / self.height, 0.0), 1.0),
            )
            target = self._stitch(
                track_id, point, self._diag_fraction(x2 - x1, y2 - y1), at
            )
            if target != track_id:
                self.alias[track_id] = target
                self.tracks[
                    target
                ].areas.clear()  # the new id's box size starts a fresh footprint baseline
                track_id = target
        new_track = track_id not in self.tracks
        state = self.tracks.setdefault(track_id, _TrackState())
        if new_track and history:
            # Resolve stitching at the current confirmed observation first.
            # Only recover a crossing actually hidden by ID confirmation;
            # older boxes far from the line must not alter other trajectories.
            measured = sorted(history, key=lambda row: row[0])
            measured = [row for row in measured if row[0] < at]
            measured.append((at, vehicle_class, confidence, (x1, y1, x2, y2), source))
            def point(box):
                return Point((box[0] + box[2]) / 2 / self.width, box[3] / self.height)
            hidden_crossing = any(
                crossing_candidate(self.rule, point(a[3]), point(b[3]), a[0], b[0],
                                   self.start, self.end, vehicle_class) is not None
                for a, b in zip(measured, measured[1:])
            )
            if hidden_crossing:
                for observed_at, label, score, box, origin in measured[:-1]:
                    self._observe(track_id, label, score, box, observed_at, origin)
        if confidence < self.min_conf:
            state.initial_footprint.clear()
            return
        box = (x1, y1, x2, y2)
        if confidence >= self.strong_conf and source in (DETECTOR, PIXEL_MOTION) and (
            state.crossing is None or at <= state.crossing["at"] + 0.25
        ):
            state.observations.append((at, box))
        area = max(x2 - x1, 1.0) * max(y2 - y1, 1.0)
        if state.areas:
            recent = sorted(state.areas[-5:])[len(state.areas[-5:]) // 2]
            if area > recent * self.max_area_jump or area * self.max_area_jump < recent:
                self._recover_initial_footprint(track_id, state, (at, vehicle_class, confidence, box, source))
                return
        state.initial_footprint.clear()
        state.areas.append(area)
        state.size = self._diag_fraction(x2 - x1, y2 - y1)
        if confidence >= self.strong_conf and source in (DETECTOR, PIXEL_MOTION):
            state.strong += 1
            state.detector_strong += int(source == DETECTOR)
            state.coarse_strong += int(source == PIXEL_MOTION)
        if source in (DETECTOR, PIXEL_MOTION):
            state.votes[vehicle_class] = (
                state.votes.get(vehicle_class, 0.0) + confidence
            )
        if not state.votes:
            return  # Unclassified motion cannot invent a vehicle identity/class.
        cls = max(state.votes.items(), key=lambda kv: kv[1])[0]
        point = Point(
            min(max((x1 + x2) / 2 / self.width, 0.0), 1.0),
            min(max(y2 / self.height, 0.0), 1.0),
        )
        # Pixel-region boxes have integer edges and can land exactly on the
        # line. Keep the last non-touching observation, so A -> line -> B is a
        # crossing, while A -> line -> A remains only a touch.
        if abs(_line_side(self.rule, point)) <= 1e-9:
            return
        if state.last is not None and state.passage is None:
            passage = crossing_candidate(
                self.rule,
                state.last,
                point,
                state.last_at,
                at,
                self.start - 15,
                self.end,
                cls,
            )
            if passage is not None:
                state.passage = {
                    "trackId": int(track_id),
                    "class": passage.vehicle_class,
                    "direction": passage.direction,
                    "at": passage.at,
                    "box": (x1, y1, x2, y2),
                }
        if state.last is not None and state.crossing is None:
            crossing = crossing_candidate(
                self.rule,
                state.last,
                point,
                state.last_at,
                at,
                self.start,
                self.end,
                cls,
            )
            if crossing is not None:
                state.crossing = {
                    "trackId": int(track_id),
                    "class": crossing.vehicle_class,
                    "direction": crossing.direction,
                    "at": crossing.at,
                    "box": (x1, y1, x2, y2),
                }
        if state.last is not None and at > state.last_at:
            vx, vy = (point.x - state.last.x) / (at - state.last_at), (
                point.y - state.last.y
            ) / (at - state.last_at)
            state.velocity = (
                (0.5 * state.velocity[0] + 0.5 * vx, 0.5 * state.velocity[1] + 0.5 * vy)
                if state.moves
                else (vx, vy)
            )
            state.moves += 1
        state.last, state.last_at, state.stitched = point, at, False

    @staticmethod
    def _iou(a: Box, b: Box) -> float:
        intersection = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(
            0.0, min(a[3], b[3]) - max(a[1], b[1])
        )
        union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
        return intersection / union if union > 0 else 0.0

    def _recover_initial_footprint(self, track_id: int, state: _TrackState, row: Observation) -> None:
        """Replace a bad initial patch only after three consistent strong neural boxes.

        Drop the old anchor entirely: a footprint change itself cannot cross the
        line. Established tracks and tracks with an observed passage keep their
        original area gate and identity, including an already counted vehicle.
        """
        at, label, confidence, box, source = row
        pending = state.initial_footprint
        if len(state.areas) > 2 or state.passage is not None or state.crossing is not None or (
            confidence < self.strong_conf or source != DETECTOR
        ):
            pending.clear()
            return
        if pending and (not 0 < at - pending[-1][0] <= 0.25 or self._iou(box, pending[-1][3]) < 0.5):
            pending.clear()
        pending.append(row)
        if len(pending) < 3:
            return
        measured = list(pending)
        self.tracks[track_id] = _TrackState()
        self.footprint_resets += 1
        for observed_at, vehicle_class, score, measured_box, origin in measured:
            self._observe(track_id, vehicle_class, score, measured_box, observed_at, origin)

    def _duplicate_supported(self, a: dict, b: dict) -> bool:
        """Keep the geometric duplicate guard unless strong frames prove two vehicles.

        Body and glare boxes may be offset and fragmented. Missing simultaneous
        evidence must not turn those into extra cars. Conversely, two disjoint
        strong boxes in multiple shared frames cannot be one physical vehicle.
        """
        if a["class"] != b["class"] and "vehicle" not in (a["class"], b["class"]):
            return False
        lo, hi = min(a["at"], b["at"]) - 0.5, max(a["at"], b["at"]) + 0.25
        first = {at: box for at, box in self.tracks[a["trackId"]].observations if lo <= at <= hi}
        second = {at: box for at, box in self.tracks[b["trackId"]].observations if lo <= at <= hi}
        shared = first.keys() & second.keys()
        separated = sum(self._overlap(first[at], second[at]) == 0 for at in shared)
        return separated < 2

    def _counted(self, state: _TrackState) -> bool:
        return state.crossing is not None and self._confirmed(state, state.crossing)

    def _confirmed(self, state: _TrackState, passage: dict) -> bool:
        return state.detector_strong >= self.min_strong or (
            passage["class"] == "vehicle"
            and state.coarse_strong >= max(8, self.min_strong)
        )

    def confirmed_passage(self, track_id: int) -> dict[str, Any] | None:
        """An observed, class-confirmed pass; this never adds a settled crossing."""
        state = self.tracks.get(self.alias.get(track_id, track_id))
        if state is None or state.passage is None:
            return None
        passage = state.crossing or state.passage
        return passage if self._confirmed(state, passage) else None

    @staticmethod
    def _overlap(a: tuple[float, ...], b: tuple[float, ...]) -> float:
        """Intersection over the smaller box: 1 when one box lies inside the other."""
        w = min(a[2], b[2]) - max(a[0], b[0])
        h = min(a[3], b[3]) - max(a[1], b[1])
        if w <= 0 or h <= 0:
            return 0.0
        smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
        return w * h / smaller if smaller > 0 else 0.0

    def _distinct(self) -> tuple[list[dict[str, Any]], int]:
        """Counted crossings, merging duplicate tracks of one vehicle (e.g. a body box and a headlight-glare box
        crossing together): same class/direction, within `duplicate_gap` seconds,
        unless simultaneous strong observations establish separate vehicles.
        """
        if self._distinct_cache is not None:
            return self._distinct_cache
        kept: list[dict[str, Any]] = []
        recent: deque[dict[str, Any]] = deque()
        duplicates = 0
        for c in sorted(
            (s.crossing for s in self.tracks.values() if self._counted(s)),
            key=lambda c: c["at"],
        ):
            while recent and c["at"] - recent[0]["at"] > self.duplicate_gap:
                recent.popleft()
            if any(
                k["direction"] == c["direction"]
                and abs(k["at"] - c["at"]) <= self.duplicate_gap
                and self._overlap(k["box"], c["box"]) >= self.duplicate_overlap
                and self._duplicate_supported(k, c)
                for k in recent
            ):
                duplicates += 1
                continue
            kept.append(c)
            recent.append(c)
        self._distinct_cache = kept, duplicates
        return self._distinct_cache

    @property
    def crossings(self) -> list[dict[str, Any]]:
        return [{k: v for k, v in c.items() if k != "box"} for c in self._distinct()[0]]

    @property
    def duplicates(self) -> int:
        return self._distinct()[1]

    @property
    def rejected(self) -> int:
        return sum(
            1
            for s in self.tracks.values()
            if s.crossing is not None and not self._counted(s)
        )

    @property
    def count(self) -> int:
        return len(self._distinct()[0])
