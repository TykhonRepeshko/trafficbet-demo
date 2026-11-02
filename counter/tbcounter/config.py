from __future__ import annotations

import os
from dataclasses import dataclass

VERSION = "1.0.0"


def _float(name: str, default: float, low: float, high: float) -> float:
    raw = os.environ.get(name, "")
    value = float(raw) if raw.strip() else default
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


@dataclass(frozen=True)
class Config:
    api_base: str
    worker_token: str
    model: str
    models_dir: str
    sample_fps: float
    conf_threshold: float
    detector_threads: int
    processors: int
    calibration_seconds: float
    min_calibration_tracks: int
    buffer_seconds: float
    poll_seconds: float
    log_level: str
    wide_coverage: bool = True

    @property
    def worker_name(self) -> str:
        return f"trafficbet-counter/{VERSION} {self.model}"


def load() -> Config:
    token = os.environ.get("WORKER_TOKEN", "")
    cfg = Config(
        api_base=os.environ.get("API_BASE", "http://backend:8080").rstrip("/"),
        worker_token=token,
        model=os.environ.get("MODEL", "yolox-tiny"),
        models_dir=os.environ.get("MODELS_DIR", "/app/models"),
        sample_fps=_float("SAMPLE_FPS", 5.0, 1.0, 15.0),
        conf_threshold=_float("CONF_THRESHOLD", 0.3, 0.05, 0.95),
        detector_threads=int(_float("DETECTOR_THREADS", 4, 1, 32)),
        processors=int(_float("PROCESSORS", 2, 1, 8)),
        calibration_seconds=_float("CALIBRATION_SECONDS", 120, 30, 600),
        min_calibration_tracks=int(_float("MIN_CALIBRATION_TRACKS", 8, 3, 100)),
        buffer_seconds=_float("BUFFER_SECONDS", 420, 120, 1800),
        poll_seconds=_float("POLL_SECONDS", 5, 1, 60),
        log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        wide_coverage=os.environ.get("WIDE_COVERAGE", "true").strip().lower() not in ("0", "false", "no", "off"),
    )
    if len(cfg.worker_token) < 32:
        raise ValueError("WORKER_TOKEN must contain at least 32 characters")
    if cfg.model not in ("yolox-tiny", "yolox-nano", "rfdetr-nano", "rfdetr-small", "rfdetr-medium", "rfdetr-large"):
        raise ValueError("MODEL must be yolox-tiny, yolox-nano or an Apache-2.0 RF-DETR size (rfdetr-nano|small|medium|large)")
    return cfg
