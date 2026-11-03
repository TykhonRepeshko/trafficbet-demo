import pytest
from dev.native_dataset import scale_boxes, proposals


def row(split="train"):
    return {
        "source": "session",
        "camera": 1,
        "split": split,
        "at": 10.0,
        "width": 640,
        "height": 360,
        "boxes": [[100, 100, 120, 120]],
    }


def test_native_box_proposals_use_source_dimensions():
    assert scale_boxes(row(), 1280, 720) == [[200, 200, 240, 240]]


def test_temporal_neighbours_do_not_receive_pseudo_truth_boxes():
    targets = proposals([row()], 1.0, 4.0)[("session", 1)]
    assert len(targets) == 9
    assert all(r["split"] == "train" for _, r in targets)
    assert sum(r["boxes"] is not None for _, r in targets) == 1


def test_source_session_split_is_immutable():
    with pytest.raises(ValueError, match="cannot cross"):
        proposals([row(), row("test")], 1.0, 4.0)
