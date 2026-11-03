"""Offline source trial: local saved segments and frozen visual labels only.

No HTTP client, backend token, database connection, camera registration or
settlement side effects. Counting uses media-relative time; source UTC/clock
qualification is a separate required check, not implied by matching a count.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import cv2
import numpy as np

from dev.replay_benchmark import inside, load_case, match_events
from tbcounter import detector, pipeline, video
from tbcounter.caltrans_clock import CaltransClock, CaltransHeaderReader
from tbcounter.segments import Segment, continuous
from tbcounter.quality import counting_problem
from tbcounter.rules import Definition, valid_definition


def reviewed_truth(review, start, end):
    if review.get("anchor") != "bottom_center":
        raise ValueError("Visual labels must use the profile's bottom-centre anchor")
    events = review.get("events", [])
    if len({event["id"] for event in events}) != len(events):
        raise ValueError("Duplicate manual event id")
    out = []
    for event in events:
        a, b = event["earliestPtsSeconds"], event["latestPtsSeconds"]
        if not 0 <= a <= b or event["direction"] not in ("A_to_B", "B_to_A"):
            raise ValueError("Invalid reviewed interval")
        if a >= end or b < start:
            continue
        if a < start or b >= end:
            raise ValueError("A manual interval straddles the counting-window boundary")
        out.append({"id": event["id"], "earliest": a-start, "latest": b-start,
                    "direction": event["direction"], "description": event["description"],
                    "lane": event.get("lane", "")})
    return out


def qualify_clock(root, manifest_relative, out):
    manifest = inside(root, manifest_relative)
    rows = json.loads(manifest.read_text(encoding="utf-8-sig"))
    reader, clock = CaltransHeaderReader(), CaltransClock()
    segments, samples, anchors = [], [], []
    origin, tick = None, 0.0
    for row in rows:
        data = inside(manifest.parent, row["file"]).read_bytes()
        first_pts, width, height = video.probe(data)
        anchor = clock.anchor_segment(data, row["fetchedAt"], row["duration"])
        segments.append(Segment(row["seq"], row["duration"], data, row["fetchedAt"],
                                discontinuity=bool(row.get("discontinuity", False)),
                                anchor=anchor, first_pts=first_pts, width=width, height=height))
        anchors.append({"seq":row["seq"], "anchor":None if anchor is None else anchor.__dict__})
        for pts, frame in video.frames(data):
            if origin is None:
                origin = pts
            at = video.pts_delta(pts, origin)
            if at+1e-6 < tick:
                continue
            while tick <= at+1e-6:
                tick += .5
            value = reader.read(frame.to_ndarray(format="gray", threads=1))
            samples.append({"at":round(at,4), "displayed":None if value is None else value.local.isoformat()})
    boundaries = []
    for a, b in zip(segments, segments[1:]):
        okay, gap = continuous(a, b)
        boundaries.append({"from":a.seq, "to":b.seq, "continuous":okay, "gapSeconds":round(gap,4)})
    report = {"scope":"Operator-rendered clock recognition and media continuity only; not authenticated UTC.",
              "segments":len(rows), "anchoredSegments":clock.successes, "sampledFrames":len(samples),
              "readableFrames":sum(v["displayed"] is not None for v in samples),
              "clockContinuous":bool(boundaries) and all(v["continuous"] for v in boundaries),
              "boundaries":boundaries, "anchors":anchors, "readings":samples}
    out.mkdir(parents=True, exist_ok=True)
    (out / "clock-results.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k not in ("anchors", "readings")}), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--segments", required=True)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--labels", type=Path)
    parser.add_argument("--clock-only", action="store_true")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--fps", type=float, default=8)
    parser.add_argument("--motion", choices=("legacy", "native", "off"), default="native")
    parser.add_argument("--coverage", choices=pipeline.COVERAGES, default="full")
    parser.add_argument("--window", choices=("all", "calibration", "held_out"), default="all")
    parser.add_argument("--model", choices=("yolox-s", "yolox-tiny"), default="yolox-s")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    if not 1 <= args.fps <= 30:
        parser.error("fps must be between 1 and 30")
    profile = json.loads(args.profile.read_text(encoding="utf-8-sig"))
    if profile.get("status") != "offline_trial_only" or profile.get("registeredInApplication"):
        raise ValueError("This tool accepts unregistered offline profiles only")
    if args.clock_only:
        if profile["source"].get("clockReader") != "caltrans_c008_header_v1":
            raise ValueError("The clock reader must be explicitly selected by the source profile")
        qualify_clock(args.root, args.segments, args.out)
        return
    if args.labels is None:
        parser.error("--labels is required for a counting trial")
    review = json.loads(args.labels.read_text(encoding="utf-8-sig"))
    if profile["definition"] != review["definition"] or not valid_definition(Definition.from_json(profile["definition"])):
        raise ValueError("Profile and reviewed geometry must be identical and valid")
    # The rejected custom model is deliberately not loaded.
    cv2.setNumThreads(1)
    model = detector.build(args.model, "/app/models", 2, args.device)
    model.detect(np.zeros((640, 640, 3), np.uint8))
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"profileId":profile["id"], "profileSha256":hashlib.sha256(args.profile.read_bytes()).hexdigest(),
              "labelsSha256":hashlib.sha256(args.labels.read_bytes()).hexdigest(),
              "model":model.name, "fps":args.fps, "motion":args.motion, "coverage":args.coverage, "device":args.device,
              "scope":"Media-relative count trial only; not source-clock or automatic-settlement approval.", "windows":[]}
    for name, (start, end) in (("calibration", profile["validation"]["calibrationWindowSeconds"]),
                              ("held_out", profile["validation"]["heldOutCountWindowSeconds"])):
        if args.window != "all" and args.window != name:
            continue
        truth = reviewed_truth(review, start, end)
        spec = {"id":profile["id"], "segments":args.segments, "definition":profile["definition"],
                "clock":"relative", "start":float(start), "end":float(end), "truth":truth}
        case = load_case(args.root, spec)
        session = pipeline.RoundSession(model, case.rule, start, end, args.fps, .3,
                                        coverage=args.coverage, hybrid_motion=args.motion != "off",
                                        motion_resolution="native" if args.motion == "native" else "legacy")
        observations = []
        def frame(at, bgr, boxes, counter):
            observations.append({"at":round(at,4), "boxes":[{"id":b.track_id,"label":b.label,
                                  "score":round(b.confidence,4),"xyxy":b.xyxy,
                                  "source":b.source} for b in boxes]})
        began = time.perf_counter()
        for segment in case.segments:
            session.feed(segment, on_frame=frame)
            if session.complete:
                break
        analysis = session.analysis()
        crossings = [{**item, "at":item["at"]-start} for item in analysis.crossings]
        result = {"window":name, "start":start, "end":end, "manualCount":len(truth),
                  "counterCount":analysis.count, "matching":match_events(crossings, truth),
                  "crossings":crossings, "truth":truth, "qualityProblem":counting_problem(analysis),
                  "qualityIssues":analysis.quality_issues, "rejected":analysis.rejected,
                  "frames":analysis.frames, "expectedFrames":analysis.expected_frames,
                  "timings":analysis.timings, "wallSeconds":round(time.perf_counter()-began,3),
                  "segmentHashes":case.hashes, "motionEvidence":analysis.motion}
        (args.out / f"{name}-observations.json").write_text(json.dumps(observations), encoding="utf-8")
        report["windows"].append(result)
        print(json.dumps({k:v for k,v in result.items() if k not in ("crossings","truth","motionEvidence","segmentHashes")}),flush=True)
    (args.out / "results.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
