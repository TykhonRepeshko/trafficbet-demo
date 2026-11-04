"""Compare sampling rates on the same local, clock-qualified camera recordings.

Read-only with respect to cameras, accounts and settlement. Inference is repeated
for every FPS; no prediction cache. Without manual events this reports count
stability and throughput, not a counting-accuracy score.
"""

from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
import cv2
import numpy as np
from dev.replay_benchmark import inside, match_events, MeteredDetector
from tbcounter.detector import build
from tbcounter.pipeline import RoundSession
from tbcounter.quality import counting_problem
from tbcounter.rules import Definition, valid_definition
from tbcounter.segments import Segment, SegmentBuffer
from tbcounter.source_clocks import source_clock
from tbcounter import video


def load_recording(root, folder, profile, seconds):
    manifest = inside(root, f"{folder}/{profile['cameraId']}-segments.json")
    clock = source_clock(profile)
    buffer = SegmentBuffer(1800)
    hashes = []
    readable = []
    for row in json.loads(manifest.read_text(encoding="utf-8-sig")):
        data = inside(manifest.parent, row["file"]).read_bytes()
        pts, w, h = video.probe(data)
        anchor = clock.anchor_segment(data, row["fetchedAt"], row["duration"])
        readable.append(anchor is not None)
        buffer.add(
            Segment(
                row["seq"],
                row["duration"],
                data,
                row["fetchedAt"],
                bool(row.get("discontinuity", False)),
                anchor,
                pts,
                w,
                h,
            )
        )
        hashes.append(hashlib.sha256(data).hexdigest())
    rule = Definition.from_json(profile["definition"])
    if not valid_definition(rule):
        raise ValueError("Invalid reviewed geometry")
    for segment in buffer.snapshot():
        if segment.anchor is None:
            continue
        start = segment.start + 2
        coverage = buffer.coverage(start - 2, start + seconds)
        if coverage.covered:
            return dict(
                profile=profile,
                rule=rule,
                segments=coverage.segments,
                start=start,
                end=start + seconds,
                clockReadings=readable,
                sourceSha256=hashes,
            )
    raise ValueError(
        f"No continuous {seconds + 2:g}s clock-qualified window for {profile['cameraId']}"
    )


def run_case(case, model, fps):
    p = case["profile"]
    session = RoundSession(
        model,
        case["rule"],
        case["start"],
        case["end"],
        fps,
        0.3,
        coverage=p.get("coverage", "line"),
    )
    first_seen = set()

    def progress(value):
        first_seen.update(
            (b["trackId"] for f in value["highlights"] for b in f["boxes"])
        )

    began = time.perf_counter()
    for segment in case["segments"]:
        session.feed(segment, on_progress=progress)
    progress(session.progress())
    a = session.analysis()
    events = [c | {"at": round(c["at"] - case["start"], 4)} for c in a.crossings]
    truth = p.get("manualEvents")
    return dict(
        cameraId=p["cameraId"],
        model=model.name,
        fps=fps,
        count=a.count,
        rejected=a.rejected,
        problem=counting_problem(a),
        events=events,
        frames=a.frames,
        expectedFrames=a.expected_frames,
        computeSeconds=round(time.perf_counter() - began, 3),
        timings=a.timings,
        countedWithoutHighlight=sorted(
            {c["trackId"] for c in a.crossings} - first_seen
        ),
        manualMatch=match_events(events, truth) if truth is not None else None,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--segments-dir", default="soak")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=float, nargs="+", default=[8, 12, 15])
    parser.add_argument("--window-seconds", type=float, default=30)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--model", default="yolox-s")
    args = parser.parse_args()
    if (
        not 1 <= args.workers <= 8
        or any((not 1 <= v <= 15 for v in args.fps))
        or (not 5 <= args.window_seconds <= 300)
    ):
        parser.error("workers 1..8, fps 1..15 and window 5..300 seconds required")
    profiles = json.loads(
        inside(args.root, args.profiles).read_text(encoding="utf-8-sig")
    )
    if not profiles or len({p["cameraId"] for p in profiles}) != len(profiles):
        parser.error("Profiles must have distinct camera IDs")
    cv2.setNumThreads(1)
    cases = [
        load_recording(args.root, args.segments_dir, p, args.window_seconds)
        for p in profiles
    ]
    models = {}
    for name in {p.get("model", args.model) for p in profiles}:
        model = build(name, "/app/models", 1, args.device)
        model.detect(np.zeros((640, 640, 3), np.uint8))
        models[name] = MeteredDetector(model)
    results = []
    for fps in args.fps:
        calls = sum(m.calls for m in models.values())
        began = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            rows = list(
                pool.map(
                    lambda c: run_case(
                        c, models[c["profile"].get("model", args.model)], fps
                    ),
                    cases,
                )
            )
        result = dict(
            fps=fps,
            burstWallSeconds=round(time.perf_counter() - began, 3),
            inferenceCalls=sum(m.calls for m in models.values()) - calls,
            cases=rows,
        )
        results.append(result)
        print(json.dumps(result), flush=True)
    report = dict(
        model=args.model,
        device=args.device,
        workers=args.workers,
        windowSeconds=args.window_seconds,
        usesPredictionCache=False,
        excludes=["network", "initial OCR", "model startup", "HTTP delivery"],
        accuracyLabelled=all(("manualEvents" in p for p in profiles)),
        inputs=[
            {
                k: v
                for k, v in c.items()
                if k in ["profile", "clockReadings", "sourceSha256", "start", "end"]
            }
            for c in cases
        ],
        results=results,
    )
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
