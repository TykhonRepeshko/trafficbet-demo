"""ByteTrack (Roboflow `trackers`, Apache-2.0) over our detections."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace

import numpy as np
import supervision as sv
from trackers import ByteTrackTracker

from .detector import VEHICLE_NAMES, Detections
from .evidence import DETECTOR, observation_source


@dataclass(frozen=True)
class TrackedBox:
    track_id: int
    label: str
    confidence: float
    xyxy: tuple[float, float, float, float]
    source: str | None = None


class Tracker:
    def __init__(self, fps: float, activation: float = 0.45) -> None:
        # lost_track_buffer is expressed in 30 fps frames by the library: 45 ≈ 1.5 s of occlusion.
        self._seen_ids: set[int] = set()
        self._pending = deque(maxlen=max(3, min(16, int(np.ceil(fps * 0.6)) + 1)))
        self._early: list[tuple[float, TrackedBox]] = []
        self._history_step = 1.5 / fps + 1e-3
        self.tracker = ByteTrackTracker(
            lost_track_buffer=45,
            frame_rate=fps,
            track_activation_threshold=activation,
            minimum_consecutive_frames=2,
            minimum_iou_threshold=0.05,
            high_conf_det_threshold=max(activation - 0.05, 0.1),
        )

    def update(self, detections: Detections, timestamp: float) -> list[TrackedBox]:
        if len(detections):
            sv_det = sv.Detections(
                xyxy=detections.xyxy.astype(np.float32),
                confidence=detections.confidence,
                class_id=np.array(
                    [VEHICLE_NAMES.index(l) for l in detections.labels], np.int64
                ),
                data={
                    "observation_source": np.array(
                        [detections.source_at(i) for i in range(len(detections))]
                    )
                },
            )
        else:
            sv_det = sv.Detections.empty()
        tracked = self.tracker.update(sv_det, timestamp=timestamp)
        self._early = []
        out: list[TrackedBox] = []
        pending: list[TrackedBox] = []
        if tracked.tracker_id is None:
            self._pending.append((timestamp, pending))
            return out
        for i, tid in enumerate(tracked.tracker_id):
            if tid is None:
                continue
            cls = int(tracked.class_id[i]) if tracked.class_id is not None else 0
            conf = (
                float(tracked.confidence[i]) if tracked.confidence is not None else 1.0
            )
            origins = tracked.data.get("observation_source")
            source = observation_source(
                VEHICLE_NAMES[cls], str(origins[i]) if origins is not None else None
            )
            box = TrackedBox(
                int(tid), VEHICLE_NAMES[cls], conf,
                tuple(float(v) for v in tracked.xyxy[i]), source,
            )
            if int(tid) >= 0:
                out.append(box)
            elif source == DETECTOR:
                pending.append(box)
        self._recover_early(out, timestamp)
        self._seen_ids.update(box.track_id for box in out)
        self._pending.append((timestamp, pending))
        return out

    @staticmethod
    def _iou(a: TrackedBox, b: TrackedBox) -> float:
        ax1, ay1, ax2, ay2 = a.xyxy
        bx1, by1, bx2, by2 = b.xyxy
        intersection = max(0., min(ax2, bx2)-max(ax1, bx1)) * max(0., min(ay2, by2)-max(ay1, by1))
        union = (ax2-ax1)*(ay2-ay1) + (bx2-bx1)*(by2-by1) - intersection
        return intersection / union if union > 0 else 0.

    def _recover_early(self, current: list[TrackedBox], timestamp: float) -> None:
        """Recover measured pre-ID observations only through unique adjacent-frame matches.

        ByteTrack hides its first detections until ID confirmation. A vehicle
        can cross the line during those frames. Keep its real earlier boxes,
        scores and classes; CrossingCounter still requires strong neural votes.
        Ambiguous overlaps, gaps and unclassified motion never supply history.
        """
        wanted = {box.track_id for box in current if box.track_id not in self._seen_ids and box.source == DETECTOR}
        front = {box.track_id: box for box in current if box.source == DETECTOR}
        newer = timestamp
        for at, candidates in reversed(self._pending):
            if not wanted or not 0 < newer-at <= self._history_step or timestamp-at > 0.6:
                break
            matches = {
                tid: [i for i, older in enumerate(candidates)
                      if (older.track_id < 0 or older.track_id == tid)
                      and box.label == older.label and self._iou(box, older) >= 0.35]
                for tid, box in front.items()
            }
            owners: dict[int, list[int]] = {}
            for tid, indices in matches.items():
                for i in indices:
                    owners.setdefault(i, []).append(tid)
            joined = {tid: candidates[indices[0]] for tid, indices in matches.items()
                      if len(indices) == 1 and len(owners[indices[0]]) == 1}
            wanted &= joined.keys()
            for tid in wanted:
                self._early.append((at, replace(joined[tid], track_id=tid)))
            # One neural measurement belongs to one trajectory. A later new
            # ID must not replay already claimed pre-crossing evidence.
            for tid, older in joined.items():
                candidates[matches[tid][0]] = replace(older, track_id=tid)
            front, newer = joined, at
        self._early.sort(key=lambda observation: observation[0])

    def take_early_observations(self) -> list[tuple[float, TrackedBox]]:
        early, self._early = self._early, []
        return early
