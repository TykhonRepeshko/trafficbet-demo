import json
from dataclasses import replace
from types import SimpleNamespace
import pytest
from tbcounter.inference import definition_hash, load_presets, select_preset
from tbcounter.rules import Definition, Point
from tbcounter.config import load
from tbcounter.main import Counter

RULE = Definition(
    "road",
    Point(0.1, 0.5),
    Point(0.9, 0.5),
    ("A_to_B", "B_to_A"),
    ("car",),
    notes="Reviewed test geometry for detector selection.",
)
SOURCE = "a" * 64


def raw_preset(model="yolox-m"):
    return json.dumps(
        {
            SOURCE: {
                "model": model,
                "coverage": "full",
                "definitionHash": definition_hash(RULE),
            }
        }
    )


def test_preset_requires_exact_source_and_frozen_geometry():
    presets = load_presets(raw_preset())
    assert select_preset(presets, SOURCE, RULE).model == "yolox-m"
    assert select_preset(presets, "b" * 64, RULE) is None
    assert (
        select_preset(presets, SOURCE, replace(RULE, line_end=Point(0.8, 0.6))) is None
    )
    assert (
        select_preset(
            presets,
            SOURCE,
            replace(RULE, notes="Changed approved rule with a separate review."),
        )
        is None
    )


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        "null",
        "broken",
        '{"camera49":{}}',
        '{"'
        + SOURCE
        + '":{"model":"download-me","coverage":"full","definitionHash":"'
        + ("b" * 64)
        + '"}}',
    ],
)
def test_invalid_presets_fail_closed(raw):
    with pytest.raises(ValueError):
        load_presets(raw)


def test_config_bounds_cuda_sessions_and_rejects_hybrid_presets(monkeypatch):
    monkeypatch.setenv("WORKER_TOKEN", "x" * 32)
    monkeypatch.setenv("DEVICE", "cuda")
    monkeypatch.setenv("MODEL", "yolox-s")
    monkeypatch.setenv("HYBRID_MOTION_ENABLED", "false")
    monkeypatch.setenv("SOURCE_INFERENCE_PRESETS", raw_preset())
    assert load().source_presets[SOURCE].coverage == "full"
    data = json.loads(raw_preset())
    data["b" * 64] = {
        "model": "yolox-tiny",
        "coverage": "line",
        "definitionHash": definition_hash(RULE),
    }
    monkeypatch.setenv("SOURCE_INFERENCE_PRESETS", json.dumps(data))
    with pytest.raises(ValueError, match="two model"):
        load()
    monkeypatch.setenv("SOURCE_INFERENCE_PRESETS", raw_preset())
    monkeypatch.setenv("HYBRID_MOTION_ENABLED", "true")
    with pytest.raises(ValueError, match="HYBRID"):
        load()


def test_shared_cuda_cache_builds_each_requested_model_once(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from tbcounter import main

    calls = []
    monkeypatch.setattr(
        main.detector_mod,
        "build",
        lambda name, *args: calls.append(name) or SimpleNamespace(name=name),
    )
    worker = Counter.__new__(Counter)
    worker.cfg = SimpleNamespace(
        model="yolox-s", device="cuda", models_dir="/unused", detector_threads=1
    )
    worker.detector_lock = threading.Lock()
    worker.gpu_detectors = {}
    names = ["yolox-s", "yolox-m"] * 12
    with ThreadPoolExecutor(max_workers=6) as pool:
        models = list(pool.map(lambda name: worker.detector(model=name), names))
    assert sorted(calls) == ["yolox-m", "yolox-s"]
    assert len({id(m) for m in models}) == 2
    assert all(m.name == n for m, n in zip(models, names))
