"""Observation origin is independent of the predicted vehicle class.

Legacy generic observations stay conservative unless their producer explicitly
identifies them as detector output. Motion support never supplies class votes.
"""

DETECTOR = "detector"
PIXEL_MOTION = "pixel_motion"
MEASURED_MOTION = "measured_motion"
SOURCES = (DETECTOR, PIXEL_MOTION, MEASURED_MOTION)


def observation_source(label: str, source: str | None = None) -> str:
    if source is None:
        return PIXEL_MOTION if label == "vehicle" else DETECTOR
    if source not in SOURCES:
        raise ValueError(f"Unknown observation source: {source!r}")
    return source
