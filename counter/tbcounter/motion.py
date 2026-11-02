"""Classified and coarse pixelated objects with measured motion continuation.

Continuations never advance a box on velocity alone. New coarse candidates
come from moving block-textured regions and need longer temporal confirmation.
Unclassified motion at the line, merges and failed near-line continuations make
the result unverifiable rather than a successful zero.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

import cv2
import numpy as np

from .tracking import TrackedBox
from .detector import Detections
from .pixelation import pixelated_regions, pixelated_bodies
from .rules import Point, in_road_regions
from .motion_audit import MotionAudit


def overlap(a, b) -> float:
    area = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0, min(a[3], b[3]) - max(a[1], b[1])
    )
    return area / max(
        1, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    )


@dataclass
class VisualTrack:
    id: int
    label: str
    box: np.ndarray
    points: np.ndarray | None
    semantic_at: float
    seen_at: float
    strong: int = 0
    velocity: np.ndarray | None = None


class MotionBridge:
    MAX_UNCLASSIFIED_SECONDS = 6.0

    def __init__(
        self,
        rule,
        width: int,
        height: int,
        start: float,
        fps: float,
        end: float | None = None,
    ):
        self.rule, self.width, self.height, self.start, self.fps = (
            rule,
            width,
            height,
            start,
            fps,
        )
        self.scale = min(1.0, 640 / width)
        self.size = (round(width * self.scale), round(height * self.scale))
        self.background = cv2.createBackgroundSubtractorMOG2(
            history=160, varThreshold=24, detectShadows=False
        )
        self.previous = None
        self.previous_at = None
        self.tracks: dict[int, VisualTrack] = {}
        self.alias: dict[int, int] = {}
        self.next_id = 0
        self.issues: set[str] = set()
        self.completed: set[int] = set()
        self.classified: set[int] = set()
        self.frames = self.assisted = self.reattached = self.unexplained = 0
        self.blob_observations = 0
        self.warmup_frames = 0
        self.pixel_candidates = 0
        self.prepared_at = None
        self.prepared = None
        self.reference_samples = []
        self.reference_gray = None
        self.unknown_run = 0
        self.unknown_events = []
        self.observations = []
        self.lost_events = set()
        self.resolved_unknown = 0
        self.resolved_regions = 0
        self.risks = []
        self.diagnostics = {}
        self.audit = MotionAudit(
            rule,
            width,
            height,
            start,
            end if end is not None else start + 30,
            fps,
            self.scale,
        )
        self.band = np.zeros(self.size[::-1], np.uint8)
        self.road_mask = np.full(self.size[::-1], 255, np.uint8)
        if rule.road_regions:
            self.road_mask.fill(0)
            polygons = [
                np.array(
                    [
                        [round(p.x * self.size[0]), round(p.y * self.size[1])]
                        for p in polygon
                    ],
                    np.int32,
                )
                for polygon in rule.road_regions
            ]
            cv2.fillPoly(self.road_mask, polygons, 255)
        a, b = rule.line_start, rule.line_end
        cv2.line(
            self.band,
            (round(a.x * self.size[0]), round(a.y * self.size[1])),
            (round(b.x * self.size[0]), round(b.y * self.size[1])),
            255,
            max(5, round(self.size[1] * 0.025)),
        )
        self.band = cv2.bitwise_and(self.band, self.road_mask)

    def warn(self, kind, at, ids=()):
        self.diagnostics[kind] = self.diagnostics.get(kind, 0) + 1
        if at >= self.start:
            self.risks.append((kind, at, tuple(ids)))

    def near_line(self, box) -> bool:
        a, b = self.rule.line_start, self.rule.line_end
        p = np.array([(box[0] + box[2]) / 2 / self.width, box[3] / self.height])
        first = np.array([a.x, a.y])
        direction = np.array([b.x - a.x, b.y - a.y])
        along = float(np.dot(p - first, direction) / np.dot(direction, direction))
        distance = float(np.linalg.norm(p - (first + np.clip(along, 0, 1) * direction)))
        return -0.05 <= along <= 1.05 and distance < max(
            0.035, (box[3] - box[1]) / self.height
        )

    def features(self, gray, foreground, box):
        x1, y1, x2, y2 = np.round(np.asarray(box) * self.scale).astype(int)
        h, w = gray.shape
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        mask = np.zeros_like(gray)
        if x2 - x1 < 5 or y2 - y1 < 5:
            return None
        mask[y1:y2, x1:x2] = foreground[y1:y2, x1:x2]
        return cv2.goodFeaturesToTrack(
            gray,
            maxCorners=40,
            qualityLevel=0.01,
            minDistance=2,
            mask=mask,
            blockSize=3,
        )

    def measure(self, gray, foreground, track):
        points = track.points
        if points is None or len(points) < 5:
            return None
        moved, ok, _ = cv2.calcOpticalFlowPyrLK(
            self.previous, gray, points, None, winSize=(21, 21), maxLevel=3
        )
        if moved is None:
            return None
        back, reverse, _ = cv2.calcOpticalFlowPyrLK(
            gray, self.previous, moved, None, winSize=(21, 21), maxLevel=3
        )
        if back is None:
            return None
        valid = (
            (ok.ravel() > 0)
            & (reverse.ravel() > 0)
            & (np.linalg.norm(back - points, axis=2).ravel() < 1.25)
        )
        old, new = points[valid].reshape(-1, 2), moved[valid].reshape(-1, 2)
        if len(new) < 5:
            return None
        motion = new - old
        delta = np.median(motion, axis=0)
        consistent = np.linalg.norm(motion - delta, axis=1) < max(
            1.5, float(np.linalg.norm(delta)) * 0.25
        )
        old, new = old[consistent], new[consistent]
        if len(new) < 5 or len(new) < len(points) * 0.5 or np.linalg.norm(delta) < 0.35:
            return None
        xs = np.clip(np.round(new[:, 0]).astype(int), 0, gray.shape[1] - 1)
        ys = np.clip(np.round(new[:, 1]).astype(int), 0, gray.shape[0] - 1)
        if np.mean(foreground[ys, xs] > 0) < 0.4:
            return None
        transform, inliers = cv2.estimateAffinePartial2D(
            old, new, method=cv2.RANSAC, ransacReprojThreshold=1.5
        )
        if transform is None or inliers.mean() < 0.7:
            return None
        scale = math.hypot(transform[0, 0], transform[1, 0])
        angle = abs(math.atan2(transform[1, 0], transform[0, 0]))
        if not 0.85 <= scale <= 1.18 or angle > 0.12:
            return None
        box = track.box * self.scale
        corners = np.array([[box[0], box[1]], [box[2], box[3]]], np.float32)
        corners = cv2.transform(corners[None], transform)[0] / self.scale
        result = np.asarray(np.r_[corners[0], corners[1]], dtype=np.float64)
        if (
            result[0] < 0
            or result[1] < 0
            or result[2] > self.width
            or result[3] > self.height
        ):
            return None
        if np.linalg.norm(delta) / self.scale > max(
            12, np.linalg.norm(track.box[2:] - track.box[:2])
        ):
            return None
        return result

    def measure_component(self, components, track, at):
        """Use a newly measured foreground region when pixelation loses corners.

        Velocity is used only to associate a region; the returned box always
        comes from image pixels. Competing regions are never guessed between.
        """
        center = (track.box[:2] + track.box[2:]) / 2
        predicted = center + (track.velocity if track.velocity is not None else 0) * (
            at - track.seen_at
        )
        diagonal = float(np.linalg.norm(track.box[2:] - track.box[:2]))
        area = float(np.prod(track.box[2:] - track.box[:2]))
        candidates = []
        for box in components:
            ratio = float(np.prod(box[2:] - box[:2])) / max(area, 1)
            distance = float(np.linalg.norm((box[:2] + box[2:]) / 2 - predicted))
            shift = float(np.linalg.norm((box[:2] + box[2:]) / 2 - center))
            if (
                0.3 <= ratio <= 3.0
                and distance < max(12, diagonal * 0.65)
                and shift >= 0.5
            ):
                candidates.append((distance, box))
        candidates.sort(key=lambda candidate: candidate[0])
        if not candidates:
            return None
        if len(candidates) > 1 and candidates[1][0] < candidates[0][0] * 1.4 + 3:
            if self.near_line(track.box) and at >= self.start:
                self.warn("ambiguous_motion_association", at, (track.id,))
            return None
        self.blob_observations += 1
        return candidates[0][1]

    def prepare(self, bgr, at):
        if self.prepared_at == at:
            return self.prepared
        gray = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), self.size)
        if at < self.start and self.frames % 4 == 0:
            self.reference_samples.append(gray.copy())
            self.reference_samples = self.reference_samples[-20:]
        elif (
            at >= self.start
            and self.reference_gray is None
            and len(self.reference_samples) >= 4
        ):
            self.reference_gray = np.median(
                np.stack(self.reference_samples), axis=0
            ).astype(np.uint8)
            self.reference_samples.clear()
        mask = self.background.apply(
            gray, learningRate=0.08 if at < self.start else 0.005
        )
        foreground = np.uint8(mask == 255) * 255
        if self.reference_gray is not None:
            changed = np.uint8(cv2.absdiff(gray, self.reference_gray) > 12) * 255
            foreground = cv2.bitwise_and(
                foreground, cv2.dilate(changed, np.ones((3, 3), np.uint8))
            )
        foreground = cv2.morphologyEx(
            foreground, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)
        )
        foreground = cv2.bitwise_and(foreground, self.road_mask)
        self.prepared_at, self.prepared = at, (gray, foreground)
        return gray, foreground

    def augment(self, bgr, detections: Detections, at: float) -> Detections:
        gray, foreground = self.prepare(bgr, at)
        candidates = (
            pixelated_regions(gray, foreground, self.scale)
            if self.frames >= round(self.fps * 2)
            else []
        )
        boxes = list(detections.xyxy)
        confidence = list(detections.confidence)
        labels = list(detections.labels)
        bodies = pixelated_bodies(gray, foreground, self.scale) if candidates else []
        for candidate in candidates:
            # A bright foreground patch can include several metres of road in
            # front of a car. Refine only an existing classified identity using
            # measured mosaic cells; unclassified fragments never seed a car.
            recent = [
                track
                for track in self.tracks.values()
                if track.id in self.classified
                and 0 <= at - track.seen_at <= 0.5
                and overlap(candidate, track.box) > 0.4
            ]
            if len(recent) == 1:
                track = recent[0]
                center = (track.box[:2] + track.box[2:]) / 2
                if track.velocity is not None:
                    center = center + track.velocity * (at - track.seen_at)
                close = [
                    body
                    for body in bodies
                    if overlap(body, candidate) >= 0.8
                    and np.linalg.norm((body[:2] + body[2:]) / 2 - center)
                    <= max(12, np.linalg.norm(track.box[2:] - track.box[:2]) * 0.75)
                ]
                if close:
                    candidate = min(
                        close,
                        key=lambda body: np.linalg.norm(
                            (body[:2] + body[2:]) / 2 - center
                        ),
                    )
            # Start a trajectory before it reaches the line. Restricting seeds
            # to the narrow crossing band leaves fewer than eight observations
            # for a fast vehicle, making coarse confirmation impossible.
            if candidate[1] < self.height * 0.06 or candidate[3] > self.height * 0.98:
                continue
            if not in_road_regions(
                self.rule.road_regions,
                Point(
                    (candidate[0] + candidate[2]) / 2 / self.width,
                    candidate[3] / self.height,
                ),
            ):
                continue
            matching = [
                i
                for i, box in enumerate(detections.xyxy)
                if overlap(candidate, box) > 0.4 and detections.confidence[i] >= 0.35
            ]
            if matching:
                if (
                    len(matching) > 1
                    and at >= self.start
                    and any(
                        overlap(detections.xyxy[a], detections.xyxy[b]) < 0.2
                        for a in matching
                        for b in matching
                        if a != b
                    )
                ):
                    # A connected foreground patch may contain two correctly
                    # detected cars. That alone is not an identity failure.
                    self.warn("connected_foreground_vehicles", at)
                continue
            if not {"car", "van", "bus", "truck", "motorcycle"}.issubset(
                self.rule.classes
            ):
                if at >= self.start:
                    self.issues.add("uncertain_vehicle_subtype")
                continue
            boxes.append(candidate)
            confidence.append(0.7)
            labels.append("vehicle")
            self.pixel_candidates += 1
        if not boxes:
            return Detections.empty()
        return Detections(
            np.asarray(boxes, np.float32), np.asarray(confidence, np.float32), labels
        )

    def update(self, bgr, semantic: list[TrackedBox], at: float) -> list[TrackedBox]:
        gray, foreground = self.prepare(bgr, at)
        count, _, stats, _ = cv2.connectedComponentsWithStats(foreground)
        components = []
        for x, y, w, h, area in stats[1:]:
            if (
                min(w, h) >= 3
                and 8 <= area <= gray.size * 0.12
                and area / (w * h) >= 0.2
            ):
                components.append(
                    np.array([x, y, x + w, y + h], dtype=float) / self.scale
                )
        predictions = {}
        measured_ids = {self.alias.get(box.track_id) for box in semantic}
        if self.previous is not None and 0 < at - self.previous_at <= 0.5:
            for tid, track in self.tracks.items():
                if tid in measured_ids:
                    continue
                if at - track.semantic_at <= self.MAX_UNCLASSIFIED_SECONDS:
                    predicted = self.measure(gray, foreground, track)
                    if predicted is None:
                        predicted = self.measure_component(components, track, at)
                    if predicted is not None:
                        predictions[tid] = predicted
        used = set()
        output = []
        for box in semantic:
            tid = self.alias.get(box.track_id)
            if tid not in self.tracks:
                tid = None
            if tid is None:
                # A detector can return a new ID even when flow features failed.
                # Associate its measured box with a recent trajectory; never
                # emit the predicted association box as an observation.
                associations = dict(predictions)
                for key, recent in self.tracks.items():
                    if key in associations or not 0 < at - recent.seen_at <= 0.5:
                        continue
                    shift = (
                        recent.velocity if recent.velocity is not None else np.zeros(2)
                    ) * (at - recent.seen_at)
                    associations[key] = recent.box + np.tile(shift, 2)
                candidates = [
                    key
                    for key, predicted in associations.items()
                    if key not in used and overlap(predicted, box.xyxy) > 0.55
                ]
                if len(candidates) == 1:
                    tid = candidates[0]
                    self.reattached += 1
                elif len(candidates) > 1:
                    if self.near_line(box.xyxy) and at >= self.start:
                        self.warn("ambiguous_vehicle_merge", at, candidates)
                    used.update(candidates)
            if tid is None:
                tid = self.next_id
                self.next_id += 1
            if tid in used:
                if self.near_line(box.xyxy) and at >= self.start:
                    self.warn("ambiguous_vehicle_merge", at, (tid,))
                continue
            self.alias[box.track_id] = tid
            if box.label != "vehicle" and box.confidence >= 0.35:
                self.classified.add(tid)
            used.add(tid)
            old = self.tracks.get(tid)
            velocity = old.velocity if old is not None else None
            if old is not None and at > old.seen_at:
                measured = (
                    (np.asarray(box.xyxy[:2]) + box.xyxy[2:]) / 2
                    - (old.box[:2] + old.box[2:]) / 2
                ) / (at - old.seen_at)
                velocity = (
                    measured if velocity is None else velocity * 0.5 + measured * 0.5
                )
            track = VisualTrack(
                tid,
                box.label,
                np.asarray(box.xyxy),
                None,
                at,
                at,
                (old.strong if old else 0) + int(box.confidence >= 0.35),
                velocity,
            )
            track.points = self.features(gray, foreground, track.box)
            self.tracks[tid] = track
            output.append(
                TrackedBox(
                    tid,
                    box.label,
                    float(box.confidence),
                    tuple(float(v) for v in track.box),
                )
            )
        for tid, track in list(self.tracks.items()):
            if tid in used:
                continue
            predicted = predictions.get(tid)
            if predicted is not None:
                conflicting = any(overlap(predicted, b.xyxy) > 0.5 for b in output)
                if conflicting:
                    if self.near_line(predicted) and at >= self.start:
                        self.warn("ambiguous_vehicle_merge", at, (tid,))
                    continue
                measured = (
                    (predicted[:2] + predicted[2:]) / 2
                    - (track.box[:2] + track.box[2:]) / 2
                ) / max(at - track.seen_at, 0.001)
                track.velocity = (
                    measured
                    if track.velocity is None
                    else track.velocity * 0.5 + measured * 0.5
                )
                track.box = predicted
                track.seen_at = at
                track.points = self.features(gray, foreground, predicted)
                # Motion is measured support for an existing vehicle, not a new
                # confident classification. It must not supply strong votes.
                output.append(
                    TrackedBox(
                        tid, track.label, 0.25, tuple(float(v) for v in predicted)
                    )
                )
                self.assisted += 1
            elif at - track.seen_at > 0.5:
                if (
                    tid not in self.completed
                    and track.strong >= 2
                    and self.near_line(track.box)
                    and at >= self.start
                ):
                    self.issues.add("vehicle_lost_near_line")
                    self.lost_events.add(tid)
                del self.tracks[tid]
        if at >= self.start:
            covered = np.zeros_like(gray)
            for box in output:
                x1, y1, x2, y2 = np.round(np.asarray(box.xyxy) * self.scale).astype(int)
                pad = 3
                cv2.rectangle(
                    covered,
                    (max(0, x1 - pad), max(0, y1 - pad)),
                    (
                        min(gray.shape[1] - 1, x2 + pad),
                        min(gray.shape[0] - 1, y2 + pad),
                    ),
                    255,
                    -1,
                )
            unexplained = np.uint8((foreground > 0) & (self.band > 0) & (covered == 0))
            _, _, regions, _ = cv2.connectedComponentsWithStats(unexplained)
            # Dispersed compression/sensor speckles are not a moving object.
            # Require a coherent region at the line, not a sum over its width.
            unknown = (
                int(regions[1:, cv2.CC_STAT_AREA].max()) if len(regions) > 1 else 0
            )
            limit = max(40, np.count_nonzero(self.band) * 0.004)
            self.unknown_run = self.unknown_run + 1 if unknown > limit else 0
            if unknown > limit:
                self.unexplained += 1
            if self.unknown_run >= max(2, round(self.fps * 0.25)):
                for x, y, w, h, area in regions[1:]:
                    if area > limit:
                        self.unknown_events.append(
                            (
                                at,
                                np.array([x, y, x + w, y + h], dtype=float)
                                / self.scale,
                            )
                        )
            # Overlapping boxes of independently measured, stable IDs do not
            # mean a merge. Missing identities are audited after the interval.
        else:
            self.warmup_frames += 1
        self.previous, self.previous_at = gray, at
        self.observations.extend(
            (at, box.track_id, np.array(box.xyxy, dtype=float)) for box in output
        )
        self.audit.update(foreground, output, at)
        if any(
            t.crossing is not None and self.audit.coherent(t)
            for t in self.audit.tracks.values()
        ):
            self.issues.add("unclassified_motion_at_line")
        self.frames += 1
        return output

    def reconcile(self, counter):
        """Resolve detector startup lag using observed boxes, never a predicted crossing.

        A later confirmed identity can explain foreground that appeared before
        ByteTrack activated it. Unexplained regions remain a quality failure.
        Counter aliases matter: a successfully stitched trajectory must not
        subsequently be reported as a missing, different vehicle.
        """

        def state_for(tid):
            return counter.tracks.get(counter.alias.get(tid, tid))

        unresolved_lost = set()
        a, b = self.rule.line_start, self.rule.line_end
        for tid in self.lost_events:
            if counter.confirmed_passage(tid) is not None:
                continue
            state = state_for(tid)
            if state is None or state.last is None:
                unresolved_lost.add(tid)
                continue
            side = (b.x - a.x) * (state.last.y - a.y) - (b.y - a.y) * (
                state.last.x - a.x
            )
            velocity = (b.x - a.x) * state.velocity[1] - (b.y - a.y) * state.velocity[0]
            if side * velocity < 0 and 0 < -side / velocity <= 1.5:
                unresolved_lost.add(tid)
        self.issues.discard("vehicle_lost_near_line")
        if unresolved_lost:
            self.issues.add("vehicle_lost_near_line")
        self.issues.discard("unclassified_motion_at_line")
        if self.audit.reconcile(counter):
            self.issues.add("unclassified_motion_at_line")
        self.resolved_unknown = self.audit.resolved
        # Keep the conservative line-band check as a second guard. In
        # particular, fragmented foreground tracks must not silently excuse a
        # vehicle which the independent audit never managed to link.
        dx = (b.x - a.x) * self.width
        dy = (b.y - a.y) * self.height
        unit = np.array([dx, dy], float) / max(math.hypot(dx, dy), 1)
        passages = {}
        for _, tid, _ in self.observations:
            if (passage := counter.confirmed_passage(tid)) is not None:
                passages[passage["trackId"]] = passage

        def explained_region(at, region):
            if self.audit.covers_stationary_region(at, region):
                return True
            # Background adaptation may split a static illuminated remnant
            # from its parent object. Require both stationary image evidence
            # and an earlier measured link to an explained vehicle identity.
            center = (region[:2] + region[2:]) / 2
            if np.prod(region[2:] - region[:2]) * self.scale**2 <= 120:
                stationary = [
                    t
                    for t, other in self.unknown_events
                    if abs(t - at) <= 0.6
                    and overlap(region, other) >= 0.8
                    and np.linalg.norm((other[:2] + other[2:]) / 2 - center)
                    <= 2 / self.scale
                ]
                if len(stationary) >= 5 and max(stationary) - min(stationary) >= 0.5:
                    linked_before = any(
                        0 <= at - t <= 2.5
                        and overlap(region, box) >= 0.8
                        and any(
                            abs(link - t) <= 0.375
                            for known in track.explained_links
                            for link in track.links[known]
                        )
                        for track in self.audit.tracks.values()
                        if track.explained_links
                        for t, box, _ in track.observations
                    )
                    if linked_before:
                        return True
            # An illuminated extension can touch the line before the vehicle's
            # anchor. Explain it through the same measured foreground identity,
            # with an actual linked vehicle observation at that moment.
            for track in self.audit.tracks.values():
                if not track.explained_links:
                    continue
                if not any(
                    abs(t - at) <= 1.25
                    for known in track.explained_links
                    for t in track.links[known]
                ):
                    continue
                if any(
                    abs(t - at) <= 0.13 and overlap(region, box) >= 0.7
                    for t, box, _ in track.observations
                ):
                    return True
            center = (region[:2] + region[2:]) / 2
            region_span = abs(unit[0]) * (region[2] - region[0]) + abs(unit[1]) * (
                region[3] - region[1]
            )
            for passage in passages.values():
                box = passage["box"]
                anchor = np.array([(box[0] + box[2]) / 2, box[3]])
                span = abs(unit[0]) * (box[2] - box[0]) + abs(unit[1]) * (
                    box[3] - box[1]
                )
                aligned = abs(float(np.dot(center - anchor, unit))) <= max(
                    8 / self.scale, (span + region_span) / 2
                )
                if aligned and abs(passage["at"] - at) <= 1.25:
                    return True
                # A small fixed remnant immediately AFTER an observed pass is
                # a tail, not another moving crossing. Keep this bounded in
                # area/time and retain the independent lost-object audit.
                tail_aligned = (
                    abs(float(np.dot(center - anchor, unit)))
                    <= (span + region_span) / 2 + 24 / self.scale
                )
                if (
                    tail_aligned
                    and 0 <= at - passage["at"] <= 2.5
                    and np.prod(region[2:] - region[:2]) * self.scale**2 <= 120
                ):
                    neighbors = [
                        (t, other)
                        for t, other in self.unknown_events
                        if abs(t - at) <= 0.5
                        and overlap(region, other) >= 0.8
                        and np.linalg.norm((other[:2] + other[2:]) / 2 - center)
                        <= 2 / self.scale
                    ]
                    if (
                        len(neighbors) >= 4
                        and max(t for t, _ in neighbors) - min(t for t, _ in neighbors)
                        >= 0.35
                    ):
                        return True
            return False

        self.resolved_regions = sum(
            explained_region(at, region) for at, region in self.unknown_events
        )
        if self.resolved_regions < len(self.unknown_events):
            self.issues.add("unclassified_motion_at_line")
        for kind, at, ids in self.risks:
            if kind == "connected_foreground_vehicles" or all(
                counter.confirmed_passage(tid) is not None for tid in ids
            ):
                continue
            missing = set(ids) & unresolved_lost
            # An ambiguity is fatal when two previously separate measured
            # identities collapse and at least one observed pass remains lost.
            separated = False
            if len(ids) > 1:
                recent = [
                    (t, tid, box)
                    for t, tid, box in self.observations
                    if tid in ids and at - 1 <= t <= at
                ]
                separated = any(
                    t == other_t and tid != other_id and overlap(box, other_box) < 0.2
                    for t, tid, box in recent
                    for other_t, other_id, other_box in recent
                )
            if missing or separated:
                self.issues.add(kind)

    def evidence(self):
        return {
            "method": "semantic_pixel_motion_v1",
            "assistedObservations": self.assisted,
            "reattachedTracks": self.reattached,
            "componentAssociations": self.blob_observations,
            "pixelatedCandidateObservations": self.pixel_candidates,
            "warmupFrames": self.warmup_frames,
            "requiredWarmupFrames": round(self.fps * 4),
            "unexplainedMotionFrames": self.unexplained,
            "unknownRegions": self.audit.crossed_objects,
            "resolvedUnknownRegions": self.resolved_unknown,
            "lineMotionRegions": len(self.unknown_events),
            "explainedLineMotionRegions": self.resolved_regions,
            "auditMode": "object_trajectories_v2",
            "objectAudit": self.audit.evidence(),
            "trackingWarnings": self.diagnostics,
            "qualityIssues": sorted(self.issues),
        }
