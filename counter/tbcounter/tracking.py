"""ByteTrack (Roboflow `trackers`, Apache-2.0) over our detections."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import supervision as sv
from trackers import ByteTrackTracker

from .detector import VEHICLE_NAMES, Detections


@dataclass(frozen=True)
class TrackedBox:
    track_id: int
    label: str
    confidence: float
    xyxy: tuple[float, float, float, float]


class Tracker:
    def __init__(self, fps: float, activation: float = 0.45) -> None:
        # lost_track_buffer is expressed in 30 fps frames by the library: 45 ≈ 1.5 s of occlusion.
        self.tracker = ByteTrackTracker(lost_track_buffer=45, frame_rate=fps, track_activation_threshold=activation,
                                        minimum_consecutive_frames=2, minimum_iou_threshold=0.05,
                                        high_conf_det_threshold=max(activation - 0.05, 0.1))

    def update(self, detections: Detections, timestamp: float) -> list[TrackedBox]:
        if len(detections):
            sv_det = sv.Detections(xyxy=detections.xyxy.astype(np.float32), confidence=detections.confidence,
                                   class_id=np.array([VEHICLE_NAMES.index(l) for l in detections.labels], np.int64))
        else:
            sv_det = sv.Detections.empty()
        tracked = self.tracker.update(sv_det, timestamp=timestamp)
        out: list[TrackedBox] = []
        if tracked.tracker_id is None:
            return out
        for i, tid in enumerate(tracked.tracker_id):
            if tid is None or int(tid) < 0:
                continue
            cls = int(tracked.class_id[i]) if tracked.class_id is not None else 0
            conf = float(tracked.confidence[i]) if tracked.confidence is not None else 1.0
            out.append(TrackedBox(int(tid), VEHICLE_NAMES[cls], conf, tuple(float(v) for v in tracked.xyxy[i])))
        return out
