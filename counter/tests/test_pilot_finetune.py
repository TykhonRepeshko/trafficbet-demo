"""A pilot must not train on test frames or silently consume changed images."""

import hashlib
import json

import pytest

from dev.pilot_finetune import records


def dataset(tmp_path):
    rows = []
    for split in ("train", "val", "test"):
        image = tmp_path / f"{split}.jpg"
        image.write_bytes(split.encode())
        rows.append(
            {
                "file": image.name,
                "sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                "split": split,
                "source": split + "-session",
                "camera": 39,
                "boxes": [],
                "reviewed": True,
            }
        )
    return rows


def write(tmp_path, rows):
    path = tmp_path / "annotations.json"
    path.write_text(json.dumps({"records": rows}))
    return path


def test_separate_reviewed_sessions_are_accepted(tmp_path):
    rows = dataset(tmp_path)
    assert len(records(write(tmp_path, rows))) == 3


def test_identical_image_cannot_leak_into_another_split(tmp_path):
    rows = dataset(tmp_path)
    rows[1]["file"] = rows[0]["file"]
    rows[1]["sha256"] = rows[0]["sha256"]
    with pytest.raises(ValueError, match="same image"):
        records(write(tmp_path, rows))


def test_adjacent_frames_from_one_session_cannot_cross_splits(tmp_path):
    rows = dataset(tmp_path)
    rows[1]["source"] = rows[0]["source"]
    with pytest.raises(ValueError, match="source session"):
        records(write(tmp_path, rows))


def test_unreviewed_proposals_cannot_be_training_truth(tmp_path):
    rows = dataset(tmp_path)
    rows[0]["reviewed"] = False
    with pytest.raises(ValueError, match="reviewed"):
        records(write(tmp_path, rows))


def test_annotation_cannot_read_outside_its_dataset(tmp_path):
    rows = dataset(tmp_path)
    rows[0]["file"] = "../private.jpg"
    with pytest.raises(ValueError, match="escapes"):
        records(write(tmp_path, rows))


def test_changed_frame_invalidates_its_annotation(tmp_path):
    rows = dataset(tmp_path)
    (tmp_path / rows[0]["file"]).write_bytes(b"changed frame")
    with pytest.raises(ValueError, match="changed"):
        records(write(tmp_path, rows))


def test_unknown_empty_frame_is_not_a_training_negative(tmp_path):
    rows = dataset(tmp_path)
    rows[0]['partialLabels'] = True
    with pytest.raises(ValueError, match='verified background'):
        records(write(tmp_path, rows))
