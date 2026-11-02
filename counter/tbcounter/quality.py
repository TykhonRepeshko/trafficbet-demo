"""Counting reliability checks, separate from video transport/clock coverage."""

from __future__ import annotations


def counting_problem(analysis) -> str | None:
    if analysis.quality_issues:
        return "unreliable_tracking: " + ", ".join(analysis.quality_issues)
    if getattr(analysis, "rejected", 0):
        return "unreliable_tracking: unconfirmed_vehicle_crossing"
    if analysis.count != len(analysis.crossings):
        return "unreliable_tracking: crossing_count_mismatch"
    if analysis.motion and analysis.motion.get("warmupFrames", 0) < analysis.motion.get(
        "requiredWarmupFrames", 1
    ):
        return "unreliable_tracking: incomplete_background_warmup"
    if analysis.count == 0 and not analysis.motion:
        return "unverified_zero: no independent motion check supports the zero count."
    return None
