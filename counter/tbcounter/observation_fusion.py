"""Conservative fusion of observations, never merging independent vehicles.

Existing canonical identities are authoritative. A previously unseen small
pixel fragment contained in one established detector body is supporting image
evidence, not a second newly classified vehicle. Its unverified ownership must
still be reported to the quality audit: containment cannot exclude occlusion.
Two detector identities, or a fragment with an independent history, are retained.
"""

import math

from .evidence import DETECTOR, PIXEL_MOTION, observation_source


def area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def contained(child, parent):
    width = max(0.0, min(child[2], parent[2]) - max(child[0], parent[0]))
    height = max(0.0, min(child[3], parent[3]) - max(child[1], parent[1]))
    return width * height / max(area(child), 1.0)


def fuse_observations(observations, history, aliases):
    groups = {}
    for observed in observations:
        canonical = aliases.get(observed.track_id)
        key = (
            ("known", canonical) if canonical in history else ("new", observed.track_id)
        )
        groups.setdefault(key, []).append(observed)
    selected = []
    support = []
    for key, group in groups.items():
        previous = history.get(key[1]) if key[0] == "known" else None

        def priority(item):
            source = observation_source(item.label, item.source)
            fit = (
                -abs(math.log(max(area(item.xyxy), 1) / max(area(previous.box), 1)))
                if previous
                else 0.0
            )
            return (
                source == DETECTOR and item.confidence >= 0.35,
                fit,
                source == DETECTOR,
                item.confidence,
            )

        chosen = max(group, key=priority)
        selected.append(chosen)
        support.extend(
            (item.track_id, chosen.track_id, "canonical")
            for item in group
            if item is not chosen
        )
    bodies = [
        item
        for item in selected
        if observation_source(item.label, item.source) == DETECTOR
        and item.confidence >= 0.35
        and (previous := history.get(aliases.get(item.track_id))) is not None
        and previous.detector_strong >= 2
    ]
    result = []
    for item in selected:
        # An established independent trajectory must never disappear merely
        # because it becomes occluded by another vehicle's rectangular box.
        if (
            observation_source(item.label, item.source) != PIXEL_MOTION
            or aliases.get(item.track_id) in history
        ):
            result.append(item)
            continue
        owners = [
            body
            for body in bodies
            if item.track_id != body.track_id
            and area(item.xyxy) <= area(body.xyxy) * 0.5
            and contained(item.xyxy, body.xyxy) >= 0.9
        ]
        if len(owners) == 1:
            support.append((item.track_id, owners[0].track_id, "contained_fragment"))
        else:
            result.append(item)
    result.sort(
        key=lambda item: (
            observation_source(item.label, item.source) != DETECTOR,
            -item.confidence,
            item.track_id,
        )
    )
    return result, support
