"""Explicit detector presets bound to one source and one frozen counting rule."""

from __future__ import annotations
from dataclasses import dataclass
import hashlib
import json
import re
from .rules import Definition


@dataclass(frozen=True)
class InferencePreset:
    model: str
    coverage: str
    definition_hash: str


def definition_hash(rule: Definition) -> str:
    return hashlib.sha256(
        json.dumps(
            rule.to_json(), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


def load_presets(raw: str) -> dict[str, InferencePreset]:
    try:
        data = json.loads(raw or "{}")
    except (ValueError, TypeError) as exc:
        raise ValueError("SOURCE_INFERENCE_PRESETS must be a JSON object") from exc
    if not isinstance(data, dict) or len(data) > 8:
        raise ValueError("SOURCE_INFERENCE_PRESETS must contain at most 8 sources")
    result = {}
    for source, value in data.items():
        if not re.fullmatch("[a-f0-9]{64}", source) or not isinstance(value, dict):
            raise ValueError("Each inference preset needs an exact source fingerprint")
        if set(value) != {"model", "coverage", "definitionHash"}:
            raise ValueError(
                "Each inference preset needs model, coverage and definitionHash"
            )
        if value["model"] not in (
            "yolox-tiny",
            "yolox-nano",
            "yolox-s",
            "yolox-m",
        ) or value["coverage"] not in ("line", "wide", "grid", "full"):
            raise ValueError("Invalid inference preset model or coverage")
        if not isinstance(value["definitionHash"], str) or not re.fullmatch(
            "[a-f0-9]{64}", value["definitionHash"]
        ):
            raise ValueError("Each inference preset needs an exact definitionHash")
        result[source] = InferencePreset(
            value["model"], value["coverage"], value["definitionHash"]
        )
    return result


def select_preset(
    presets, source_fingerprint: str, rule: Definition
) -> InferencePreset | None:
    preset = presets.get(source_fingerprint)
    return (
        preset
        if preset is not None and preset.definition_hash == definition_hash(rule)
        else None
    )
