"""Live end-to-end dry run against an upstream HLS URL, without the backend.

python -m tbcounter.dryrun --url https://kamera.vegvesen.no/public/0329007_1/manifest.m3u8 --out /tmp/out
"""
from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone

import cv2
import requests

from . import detector as detector_mod
from . import framing, log, pipeline
from .clock import OverlayClock
from .hls import StreamFetcher
from .main import encode_reference
from .segments import SegmentBuffer


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--name", default="camera")
    p.add_argument("--model", default=os.environ.get("MODEL", "yolox-tiny"))
    p.add_argument("--fps", type=float, default=float(os.environ.get("SAMPLE_FPS", 5)))
    p.add_argument("--calibrate", type=float, default=120.0)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--out", default="/tmp/out")
    p.add_argument("--annotate", action="store_true", help="write annotated frames + a contact sheet of crossings")
    p.add_argument("--line", default="", help="x1,y1,x2,y2 normalised: skip calibration and use this line")
    a = p.parse_args()
    log.setup("INFO")
    os.makedirs(a.out, exist_ok=True)
    buffer, clock = SegmentBuffer(600), OverlayClock()
    fetcher = StreamFetcher(0, a.url, requests.Session(), buffer, clock)
    fetcher.start()
    det = detector_mod.build(a.model, os.environ.get("MODELS_DIR", "/app/models"), a.threads)
    report: dict = {"url": a.url, "model": a.model, "fps": a.fps}

    t0 = time.time()
    while clock.successes < 3 and time.time() - t0 < 120:
        time.sleep(1)
    segs = [s for s in buffer.snapshot() if s.anchor]
    report["clock"] = {"ocrSuccesses": clock.successes, "ocrFailures": clock.failures, "region": clock.region_name,
                       "utcOffsetMinutes": clock.offset // 60 if clock.offset is not None else None,
                       "segments": [{"seq": s.seq, "displayedLocal": s.anchor.displayed, "anchorUtc": iso(s.anchor.anchor_utc),
                                     "precisionMs": round(s.anchor.precision * 1000, 1), "latencySeconds": round(s.anchor.latency, 2),
                                     "source": s.anchor.source} for s in segs[-4:]]}
    print(json.dumps({"stage": "clock", **report["clock"]}, indent=1), flush=True)
    if clock.successes < 2:
        print("NO CLOCK — camera would be reported unavailable", flush=True)
        return

    if a.line:
        from .calibration import CalibrationResult
        from .rules import CLASSES, DIRECTIONS, Definition, Point
        x1, y1, x2, y2 = (float(v) for v in a.line.split(","))
        fixed = Definition("Fixed line", Point(x1, y1), Point(x2, y2), DIRECTIONS, CLASSES,
                           notes="Line supplied on the command line for a dry run.")
        last = buffer.snapshot()[-1]
        ref = next(pipeline.sample_frames([last], last.start, last.end, 1))[1]
        run = pipeline.CalibrationRun(CalibrationResult(fixed, 0, 0, 0, (0.0, 0.0)), ref, 0, 0.0)
    else:
        while True:
            segs = [s for s in buffer.snapshot() if s.anchor]
            if segs and segs[-1].end - segs[0].start >= a.calibrate:
                break
            time.sleep(2)
        run = pipeline.calibrate(det, segs, a.fps, 0.45, 8, a.name)
    report["calibration"] = {"frames": run.frames, "seconds": round(run.seconds, 1), "error": run.error}
    if run.result:
        d = run.result.definition
        report["calibration"] |= {"tracksUsed": run.result.tracks_used, "tracksSeen": run.result.tracks_seen,
                                  "coverage": run.result.coverage, "flowAxis": run.result.flow_axis, "definition": d.to_json(),
                                  "referencePngBytes": len(encode_reference(run.reference_bgr))}
        img = run.reference_bgr.copy()
        h, w = img.shape[:2]
        cv2.line(img, (int(d.line_start.x * w), int(d.line_start.y * h)), (int(d.line_end.x * w), int(d.line_end.y * h)),
                 (80, 240, 200), 3)
        cv2.imwrite(os.path.join(a.out, f"{a.name}-calibration.jpg"), img)
    print(json.dumps({"stage": "calibration", **report["calibration"]}, indent=1), flush=True)
    if not run.result:
        return

    newest = buffer.newest_end()
    start = newest + 3.0
    end = start + 30.0
    while not buffer.coverage(start - pipeline.PRE_ROLL, end).covered:
        if time.time() > end + 150:
            print(json.dumps({"stage": "count", "error": buffer.coverage(start - 2, end).reason,
                              "windowStart": iso(start - 2), "windowEnd": iso(end),
                              "buffer": [{"seq": s.seq, "dur": s.duration, "start": iso(s.start) if s.anchor else None,
                                          "end": iso(s.end) if s.anchor else None,
                                          "source": s.anchor.source if s.anchor else None} for s in buffer.snapshot()[-12:]]},
                             indent=1), flush=True)
            return
        time.sleep(2)
    cov = buffer.coverage(start - pipeline.PRE_ROLL, end)
    shots: list = []
    rule = run.result.definition

    def annotate(t, bgr, boxes, counter):
        img = bgr.copy()
        h, w = img.shape[:2]
        cv2.line(img, (int(rule.line_start.x * w), int(rule.line_start.y * h)), (int(rule.line_end.x * w), int(rule.line_end.y * h)), (80, 240, 200), 2)
        for b in boxes:
            x1, y1, x2, y2 = (int(v) for v in b.xyxy)
            counted = counter.tracks.get(b.track_id) is not None and counter._counted(counter.tracks[b.track_id])
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255) if counted else (255, 200, 0), 2)
            cv2.putText(img, f"{b.track_id} {b.label[:3]} {b.confidence:.2f} {x2 - x1}x{y2 - y1}", (x1, max(y1 - 4, 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(img, f"{iso(t)[11:23]}  count={counter.count}", (10, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        shots.append((t, counter.count, img))

    analysis = pipeline.count_round(det, cov.segments, rule, start, end, a.fps, 0.45,
                                    on_frame=annotate if a.annotate else None)
    if a.annotate and shots:
        picks, last = [], 0
        for i, (t, n, img) in enumerate(shots):
            if n > last:  # the frame where each new crossing registered, plus the one before it
                picks += [shots[max(i - 1, 0)][2], img]
                last = n
        picks = picks[:16] or [shots[len(shots) // 2][2]]
        thumbs = [cv2.resize(p, (480, int(480 * p.shape[0] / p.shape[1]))) for p in picks]
        while len(thumbs) % 4:
            thumbs.append(thumbs[-1] * 0)
        rows = [cv2.hconcat(thumbs[i:i + 4]) for i in range(0, len(thumbs), 4)]
        cv2.imwrite(os.path.join(a.out, f"{a.name}-crossings.jpg"), cv2.vconcat(rows), [cv2.IMWRITE_JPEG_QUALITY, 80])
    within = framing.compare(analysis.first_sig, analysis.last_sig)
    report["count"] = {"windowStart": iso(start), "windowEnd": iso(end), "count": analysis.count,
                       "crossings": [c | {"at": iso(c["at"])} for c in analysis.crossings],
                       "frames": analysis.frames, "expectedFrames": analysis.expected_frames,
                       "detections": analysis.detections, "tracks": analysis.tracks,
                       "timings": analysis.timings, "coverage": cov.evidence(),
                       "framingWithinWindow": within.to_json(), "stable": framing.stable(within),
                       "budget": {"secondsPerRound": analysis.timings["totalSeconds"],
                                  "fiveCamerasPerMinuteFraction": round(5 * analysis.timings["totalSeconds"] / 60, 3)}}
    print(json.dumps({"stage": "count", **report["count"]}, indent=1), flush=True)
    with open(os.path.join(a.out, f"{a.name}-report.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    fetcher.stop()


if __name__ == "__main__":
    main()
