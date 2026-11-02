"""MPEG-TS segment decoding with PyAV. Presentation timestamps are returned in seconds."""
from __future__ import annotations

import io
from collections.abc import Iterator

import av
import numpy as np

PTS_WRAP = (1 << 33) / 90000.0  # MPEG-TS 33-bit 90 kHz clock
DECODER_THREADS = 2


def _open(data: bytes):
    container = av.open(io.BytesIO(data), format="mpegts")
    stream = container.streams.video[0]
    # FFmpeg would otherwise start one thread per host CPU for every decoder; with a dozen
    # concurrent decoders (fetchers, OCR, rounds, calibration) that starves the detector.
    stream.thread_type = "AUTO"
    stream.codec_context.thread_count = DECODER_THREADS
    return container, stream


def frames(data: bytes) -> Iterator[tuple[float, "av.VideoFrame"]]:
    """Yield (pts_seconds, frame) for every decodable video frame in presentation order."""
    container, stream = _open(data)
    try:
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            yield float(frame.pts * stream.time_base), frame
    finally:
        container.close()


def first_frames_gray(data: bytes, seconds: float, rows: int | None = None) -> list[tuple[float, np.ndarray]]:
    """Grey frames covering the first `seconds` of a segment (optionally only the top/bottom rows needed for OCR)."""
    out: list[tuple[float, np.ndarray]] = []
    start = None
    for pts, frame in frames(data):
        if start is None:
            start = pts
        if pts - start > seconds:
            break
        gray = frame.to_ndarray(format="gray")
        out.append((pts, gray))
    return out


def probe(data: bytes) -> tuple[float | None, int, int]:
    """First video PTS and frame size of a segment."""
    for pts, frame in frames(data):
        return pts, frame.width, frame.height
    return None, 0, 0


def pts_delta(later: float, earlier: float) -> float:
    """Difference between two PTS values, tolerant of the 33-bit wrap."""
    delta = (later - earlier) % PTS_WRAP
    return delta - PTS_WRAP if delta > PTS_WRAP / 2 else delta
