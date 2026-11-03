from types import SimpleNamespace

from tbcounter.config import load
from tbcounter.main import Counter
import pytest


def test_operator_can_preserve_saved_lines(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "x" * 32)
    monkeypatch.setenv("AUTO_CALIBRATION_ENABLED", "false")
    assert load().auto_calibration_enabled is False
    counter = Counter.__new__(Counter)
    counter.cfg = SimpleNamespace(auto_calibration_enabled=False)
    counter.maybe_probe_coverage = lambda cam: None
    cam = SimpleNamespace(
        clock_state="ok",
        info={"roundsEnabled": True},
        profile={"id": 7},
        recalibrate=True,
        calibration=None,
    )
    counter.manage_camera(cam)
    assert cam.profile == {"id": 7}
    assert cam.calibration is None


def test_calibration_remains_opt_in_configurable(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "x" * 32)
    monkeypatch.delenv("AUTO_CALIBRATION_ENABLED", raising=False)
    assert load().auto_calibration_enabled is True


def test_cuda_is_explicit_and_model_selection_is_validated(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "x" * 32)
    monkeypatch.setenv("DEVICE", "cuda")
    monkeypatch.setenv("MODEL", "yolox-s")
    assert load().device == "cuda"
    monkeypatch.setenv("DEVICE", "anything")
    with pytest.raises(ValueError, match="DEVICE"):
        load()


def test_native_motion_processing_is_opt_in_and_validated(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "x" * 32)
    monkeypatch.delenv("MOTION_RESOLUTION", raising=False)
    assert load().motion_resolution == "legacy"
    monkeypatch.setenv("MOTION_RESOLUTION", "native")
    assert load().motion_resolution == "native"
    monkeypatch.setenv("MOTION_RESOLUTION", "invalid")
    with pytest.raises(ValueError, match="MOTION_RESOLUTION"):
        load()
