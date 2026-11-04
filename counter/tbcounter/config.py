from __future__ import annotations

import os
from dataclasses import dataclass, field
from .inference import InferencePreset, load_presets

VERSION = "1.4.0-exp.9"


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
    auto_calibration_enabled: bool = True
    hybrid_motion: bool = False
    device: str = "cpu"
    motion_resolution: str = "legacy"

    source_presets: dict[str, InferencePreset] = field(default_factory=dict)

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
        wide_coverage=os.environ.get("WIDE_COVERAGE", "true").strip().lower()
        not in ("0", "false", "no", "off"),
        auto_calibration_enabled=os.environ.get("AUTO_CALIBRATION_ENABLED", "true")
        .strip()
        .lower()
        not in ("0", "false", "no", "off"),
        hybrid_motion=os.environ.get("HYBRID_MOTION_ENABLED", "false").strip().lower()
        in ("1", "true", "yes", "on"),
        device=os.environ.get("DEVICE", "cpu").strip().lower(),
        source_presets=load_presets(os.environ.get("SOURCE_INFERENCE_PRESETS", "")),
        motion_resolution=os.environ.get("MOTION_RESOLUTION", "legacy").strip().lower(),
    )
    if len(cfg.worker_token) < 32:
        raise ValueError("WORKER_TOKEN must contain at least 32 characters")
    if cfg.model not in (
        "yolox-tiny",
        "yolox-nano",
        "yolox-s",
        "yolox-m",
        "rfdetr-nano",
        "rfdetr-small",
        "rfdetr-medium",
        "rfdetr-large",
    ):
        raise ValueError(
            "MODEL must be yolox-tiny|nano|s|m or rfdetr-nano|small|medium|large"
        )
    if cfg.device not in ("cpu", "cuda"):
        raise ValueError("DEVICE must be cpu or cuda")
    if cfg.motion_resolution not in ("legacy", "native"):
        raise ValueError("MOTION_RESOLUTION must be legacy or native")
    if cfg.device == "cuda" and not cfg.model.startswith("yolox-"):
        raise ValueError("The CUDA image currently supports YOLOX models only")
    if cfg.hybrid_motion and cfg.source_presets:
        raise ValueError("SOURCE_INFERENCE_PRESETS require HYBRID_MOTION_ENABLED=false")
    if (
        cfg.device == "cuda"
        and len({cfg.model} | {p.model for p in cfg.source_presets.values()}) > 2
    ):
        raise ValueError("CUDA inference presets may load at most two model sessions")
    return cfg
