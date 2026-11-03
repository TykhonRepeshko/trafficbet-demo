"""Recover native frames and temporal review queues from saved pilot sessions.

Existing approximate boxes are proposals, not newly reviewed ground truth.
Every exported frame is unreviewed, retaining the original session split.
Never enlarges a 640px JPEG: decodes the original saved transport segments.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np

from tbcounter import video
from dev.replay_benchmark import inside


def scale_boxes(row, width, height):
    if row.get("boxes") is None:
        return None
    factor = np.array([width / row["width"], height / row["height"]] * 2)
    return (np.asarray(row["boxes"], float).reshape(-1, 4) * factor).round(3).tolist()


def proposals(rows, context, fps):
    """Do not invent class labels, identities or boxes for temporal neighbours."""
    groups, splits = defaultdict(list), {}
    for row in rows:
        key = row["source"], row["camera"]
        if splits.setdefault(key, row["split"]) != row["split"]:
            raise ValueError("A source session cannot cross dataset splits")
        groups[key].append(row)
    result = {}
    for key, group in groups.items():
        targets = {round(r["at"], 6): r for r in group}
        if context:
            for row in group:
                for i in range(
                    math.ceil((row["at"] - context) * fps),
                    math.floor((row["at"] + context) * fps) + 1,
                ):
                    at = max(0, i / fps)
                    if any(abs(at - known) < 0.04 for known in targets):
                        continue
                    targets[at] = row | {
                        "at": at,
                        "boxes": None,
                        "excludeReason": None,
                        "temporalNeighbour": True,
                    }
        result[key] = sorted(targets.items())
    return result


def export(annotations, sources, output, context=0.0, fps=4.0):
    if context < 0 or context > 5 or not 1 <= fps <= 15:
        raise ValueError("Context must be 0..5 seconds; fps must be 1..15")
    raw = annotations.read_bytes()
    original = json.loads(raw)
    groups = proposals(original["records"], context, fps)
    output.mkdir(parents=True, exist_ok=False)
    (output / "images").mkdir()
    exported = []
    for (source, camera), targets in groups.items():
        directory = inside(sources, f"{source}/{camera}")
        rows = json.loads((directory / "segments.json").read_text())
        origin, index, session_hashes = None, 0, []
        for segment in rows:
            data = inside(directory, segment["file"]).read_bytes()
            session_hashes.append(hashlib.sha256(data).hexdigest())
            if origin is None:
                origin = video.probe(data)[0]
            for pts, frame in video.frames(data):
                at = video.pts_delta(pts, origin)
                if index >= len(targets):
                    break
                if at + 1e-5 < targets[index][0]:
                    continue
                target, row = targets[index]
                if at - target > 0.08:
                    raise ValueError(
                        f"Missing source frame near {source}/{camera}/{target}"
                    )
                image = frame.to_ndarray(format="bgr24", threads=1)
                height, width = image.shape[:2]
                name = f"{hashlib.sha256(str((source, camera)).encode()).hexdigest()[:12]}-{index:04d}"
                relative = f"images/{name}.png"
                ok, encoded = cv2.imencode(".png", image)
                if not ok:
                    raise ValueError("Cannot encode native frame")
                payload = encoded.tobytes()
                inside(output, relative).write_bytes(payload)
                exported.append(
                    row
                    | {
                        "id": name,
                        "at": at,
                        "target": target,
                        "file": relative,
                        "width": width,
                        "height": height,
                        "boxes": scale_boxes(row, width, height),
                        "roiTop": round(row["roiTop"] * height / row["height"]),
                        "reviewed": False,
                        "reviewMethod": "Pending native-frame review. Scaled pilot boxes are proposals only.",
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "sequenceId": f"{source}/{camera}",
                        "trackAnnotations": None,
                        "parentImageSha256": row["sha256"],
                        "parentRecord": row["id"],
                        "boxProvenance": (
                            "unlabelled neighbour"
                            if row.get("temporalNeighbour")
                            else "scaled approximate pilot boxes"
                        ),
                    }
                )
                index += 1
            if index >= len(targets):
                break
        if index != len(targets):
            raise ValueError(f"Incomplete source session {source}/{camera}")
        for item in exported:
            if item["source"] == source and item["camera"] == camera:
                item["sourceSegmentSha256"] = session_hashes
    report = {
        "schema": 2,
        "records": exported,
        "parentAnnotationsSha256": hashlib.sha256(raw).hexdigest(),
        "description": "Native frames and temporal annotation queue. No automatic truth labels.",
        "requiredReview": [
            "vehicle body boxes excluding glare",
            "consistent per-sequence vehicle IDs",
            "occlusion and privacy-mask visibility",
            "crossing time intervals and direction",
        ],
        "limitations": [
            "Reuses existing sessions; adds temporal frames, not independent test sessions.",
            "Source splits preserved. Unreviewed proposals must not enter training or evaluation.",
        ],
    }
    (output / "annotations.json").write_text(json.dumps(report, indent=2))
    return {"frames": len(exported), "sessions": len(groups), "reviewed": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--context-seconds", type=float, default=0.0)
    parser.add_argument("--sequence-fps", type=float, default=4.0)
    args = parser.parse_args()
    cv2.setNumThreads(1)
    print(
        json.dumps(
            export(
                args.annotations,
                args.sources,
                args.output,
                args.context_seconds,
                args.sequence_fps,
            )
        )
    )


if __name__ == "__main__":
    main()
