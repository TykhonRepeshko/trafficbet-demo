"""Offline multi-camera benchmark with real inference, no prediction cache or API.

Input: {"cases": [{"id": "camera-a", "segments": "capture/segments.json",
"definition": {...}, "start": 20, "end": 50, "clock": "relative",
"truth": [{"earliest": 12, "latest": 14, "direction": "B_to_A"}]}]}.
Truth times are relative to the counting window. Whole decoded segments become
available at their end in paced mode. Model warmup, file reads and initial clock
OCR are excluded; decoding, inference, tracking and final audits are measured.
This tests compute capacity on saved footage, not live transport availability.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import inspect
import json
from pathlib import Path
import threading
import time

import cv2
import numpy as np

from tbcounter import detector, pipeline, video
from tbcounter.clock import Anchor, OverlayClock
from tbcounter.quality import counting_problem
from tbcounter.rules import Definition, valid_definition
from tbcounter.segments import Segment
from tbcounter.config import VERSION


def inside(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Source path escapes the replay root")
    return path


def match_events(crossings, truth):
    """One-to-one maximum matching: a duplicate cannot replace a missed car."""
    owners = {}

    def assign(index, visited):
        event = crossings[index]
        for n, expected in enumerate(truth):
            if n in visited or event["direction"] != expected["direction"]:
                continue
            if not expected["earliest"] <= event["at"] <= expected["latest"]:
                continue
            visited.add(n)
            if n not in owners or assign(owners[n], visited):
                owners[n] = index
                return True
        return False

    for i in range(len(crossings)):
        assign(i, set())
    return {
        "matched": len(owners),
        "missed": len(truth) - len(owners),
        "extra": len(crossings) - len(owners),
        "allMatch": len(owners) == len(truth) == len(crossings),
    }


@dataclass
class Case:
    spec: dict
    segments: list[Segment]
    rule: Definition
    hashes: list[str]


def load_case(root: Path, spec: dict) -> Case:
    if spec.get("clock", "relative") not in ("relative", "overlay"):
        raise ValueError("Clock must be relative or overlay")
    rule = Definition.from_json(spec["definition"])
    if not valid_definition(rule):
        raise ValueError(f"Invalid frozen definition for {spec['id']}")
    if spec["end"] <= spec["start"]:
        raise ValueError("Empty counting window")
    for expected in spec["truth"]:
        if not (
            0
            <= expected["earliest"]
            <= expected["latest"]
            < spec["end"] - spec["start"]
            and expected["direction"] in ("A_to_B", "B_to_A")
        ):
            raise ValueError("Invalid reviewed crossing interval")
    manifest = inside(root, spec["segments"])
    origin = None
    result, hashes = [], []
    clock = OverlayClock() if spec.get("clock") == "overlay" else None
    for row in json.loads(manifest.read_text()):
        data = inside(manifest.parent, row["file"]).read_bytes()
        pts, width, height = video.probe(data)
        if origin is None:
            origin = (
                clock.anchor_segment(data, row["fetchedAt"], row["duration"])
                if clock
                else Anchor(pts, 0.0, 0.04, 60, 2, "offline")
            )
            if origin is None:
                continue
        at = origin.anchor_utc + video.pts_delta(pts, origin.first_pts)
        result.append(
            Segment(
                row["seq"],
                row["duration"],
                data,
                row["fetchedAt"],
                anchor=Anchor(pts, at, 0.04, 60, 2, "offline"),
                first_pts=pts,
                width=width,
                height=height,
            )
        )
        hashes.append(hashlib.sha256(data).hexdigest())
    pre_roll = pipeline.pre_roll_for(True)
    if (
        not result
        or result[0].start > spec["start"] - pre_roll + 0.1
        or result[-1].end < spec["end"]
    ):
        raise ValueError(f"Insufficient saved footage for {spec['id']}")
    return Case(spec, result, rule, hashes)


class MeteredDetector:
    """Counts every real invocation, including tile calls, without caching."""

    def __init__(self, inner):
        self.inner, self.name = inner, inner.name
        self.calls, self.seconds = 0, 0.0
        self.lock = threading.Lock()

    def detect(self, image):
        started = time.perf_counter()
        result = self.inner.detect(image)
        with self.lock:
            self.calls += 1
            self.seconds += time.perf_counter() - started
        return result


class PilotEnsemble:
    """Offline comparison only; never installed into the settlement worker."""

    def __init__(self, base, weights, device):
        self.base = base
        self.pilot = detector.YoloxDetector(str(weights), 2, device=device)
        self.pilot.class_index = np.array([0], np.int64)
        self.pilot.class_names = ["vehicle"]
        self.name = base.name + "+single-class-pilot"

    def detect(self, image):
        a, b = self.base.detect(image), self.pilot.detect(image)
        take = []
        for i, box in enumerate(b.xyxy):
            duplicate = False
            for known, score in zip(a.xyxy, a.confidence):
                intersection = np.maximum(
                    np.minimum(box[2:], known[2:]) - np.maximum(box[:2], known[:2]), 0
                ).prod()
                smaller = min(
                    np.prod(box[2:] - box[:2]), np.prod(known[2:] - known[:2])
                )
                if score >= 0.35 and intersection / max(1, smaller) >= 0.6:
                    duplicate = True
                    break
            if not duplicate:
                take.append(i)
        if not take:
            return a
        boxes = np.concatenate([a.xyxy, b.xyxy[take]])
        confidence = np.r_[a.confidence, b.confidence[take]]
        labels = a.labels + [b.labels[i] for i in take]
        if not hasattr(a, "source_at"):
            raise ValueError("The pilot comparison requires source-aware detections")
        sources = [a.source_at(i) for i in range(len(a))] + [
            b.source_at(i) for i in take
        ]
        keep = detector.nms(boxes, confidence, 0.45)
        return detector.Detections(
            boxes[keep],
            confidence[keep],
            [labels[i] for i in keep],
            [sources[i] for i in keep],
        )


def peak_rss_mib():
    try:
        import resource
    except ImportError:
        return None
    import sys

    divisor = 1024**2 if sys.platform == "darwin" else 1024
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / divisor, 1)


def run_case(case, model, resolution, fps, began, paced):
    spec = case.spec
    options = dict(coverage="wide", hybrid_motion=True)
    if "motion_resolution" in inspect.signature(pipeline.RoundSession).parameters:
        options["motion_resolution"] = resolution
    elif resolution != "legacy":
        raise ValueError("This counter version does not support native motion")
    session = pipeline.RoundSession(
        model, case.rule, spec["start"], spec["end"], fps, 0.3, **options
    )
    segment_lags, last_tick = [], spec["start"] - session.pre_roll
    frame_lags = []

    def frame(at, *_):
        nonlocal last_tick
        last_tick = at
        if paced:
            frame_lags.append(
                time.perf_counter() - began - (at - spec["start"] + session.pre_roll)
            )

    for seg in case.segments:
        if seg.end <= session.tick:
            continue
        available = seg.end - spec["start"] + session.pre_roll
        if paced:
            time.sleep(max(0.0, began + available - time.perf_counter()))
        session.feed(seg, on_frame=frame)
        if paced:
            segment_lags.append(max(0.0, time.perf_counter() - began - available))
        if session.complete:
            break
    analysis = session.analysis()
    crossings = [
        c | {"at": round(c["at"] - spec["start"], 4)} for c in analysis.crossings
    ]
    problem = counting_problem(analysis)
    matches = match_events(crossings, spec["truth"])
    return {
        "case": spec["id"],
        "count": analysis.count,
        "manualCount": len(spec["truth"]),
        "events": crossings,
        "eventMatch": matches,
        "problem": problem,
        "passesRegression": problem is None
        and matches["allMatch"]
        and analysis.frames == analysis.expected_frames,
        "frames": analysis.frames,
        "expectedFrames": analysis.expected_frames,
        "busySeconds": round(analysis.seconds, 3),
        "timings": analysis.timings,
        "motion": analysis.motion,
        "rejected": analysis.rejected,
        "lastCaptureTick": last_tick - spec["start"],
        "maxSegmentComputeLagSeconds": (
            round(max(segment_lags, default=0), 3) if paced else None
        ),
        "p95FrameLatencySeconds": (
            round(float(np.percentile(frame_lags, 95)), 3) if frame_lags else None
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--motion-resolution", choices=("legacy", "native"), default="legacy"
    )
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--fps", type=float, default=8.0)
    parser.add_argument("--model", default="yolox-s")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    parser.add_argument("--models-dir", default="/app/models")
    parser.add_argument(
        "--pilot-weights",
        type=Path,
        help="Offline single-class ensemble comparison only",
    )
    parser.add_argument(
        "--pilot-only", action="store_true",
        help="Compare the single-class model alone; requires --pilot-weights",
    )
    parser.add_argument("--paced", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 8 or not 1 <= args.fps <= 15:
        parser.error("Workers must be 1..8; fps must be 1..15")
    if args.pilot_only and not args.pilot_weights:
        parser.error("--pilot-only requires --pilot-weights")
    cv2.setNumThreads(1)
    raw = args.cases.read_bytes()
    cases = [load_case(args.root, spec) for spec in json.loads(raw)["cases"]]
    if not cases or len({c.spec["id"] for c in cases}) != len(cases):
        parser.error("Replay cases must be nonempty and have unique IDs")
    if args.pilot_only:
        model = detector.YoloxDetector(str(args.pilot_weights), 2, device=args.device)
        model.class_index = np.array([0], np.int64)
        model.class_names = ["vehicle"]
        model.name = "native-vehicle-v2"
    else:
        model = detector.build(args.model, args.models_dir, 2, args.device)
    if args.pilot_weights and not args.pilot_only:
        model = PilotEnsemble(model, args.pilot_weights, args.device)
    model.detect(np.zeros((640, 640, 3), np.uint8))
    model = MeteredDetector(model)
    began = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(
            pool.map(
                lambda c: run_case(
                    c, model, args.motion_resolution, args.fps, began, args.paced
                ),
                cases,
            )
        )
    wall = time.perf_counter() - began
    report = {
        "schema": 1,
        "model": model.name,
        "counterVersion": VERSION,
        "motionResolution": args.motion_resolution,
        "workers": args.workers,
        "cameraCases": len(cases),
        "fps": args.fps,
        "paced": args.paced,
        "usesPredictionCache": False,
        "excludes": ["network", "API", "initial overlay OCR", "model startup/warmup"],
        "wallSeconds": round(wall, 3),
        "actualInferenceCalls": model.calls * (2 if args.pilot_weights and not args.pilot_only else 1),
        "pilotOnly": args.pilot_only,
        "detectorInvocations": model.calls,
        "inferenceCallSecondsIncludingLockWait": round(model.seconds, 3),
        "peakProcessRssMiB": peak_rss_mib(),
        "pilotWeightsSha256": (
            hashlib.sha256(args.pilot_weights.read_bytes()).hexdigest()
            if args.pilot_weights
            else None
        ),
        "manifestSha256": hashlib.sha256(raw).hexdigest(),
        "sourceSha256": {c.spec["id"]: c.hashes for c in cases},
        "cases": results,
    }
    args.output.write_text(json.dumps(report, indent=2))
    print(
        json.dumps(
            {k: v for k, v in report.items() if k not in ("sourceSha256", "cases")}
        )
    )
    for result in results:
        print(
            json.dumps({k: v for k, v in result.items() if k != "motion"}), flush=True
        )


if __name__ == "__main__":
    main()
