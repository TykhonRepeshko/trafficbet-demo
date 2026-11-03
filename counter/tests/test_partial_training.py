"""Training-only gradient checks; serving image has no Torch dependency."""
import pytest

torch = pytest.importorskip('torch')
from dev.pilot_finetune import partial_objectness_loss


def test_unknown_objects_are_not_background_but_known_positives_still_learn():
    loss = partial_objectness_loss(torch.nn.BCEWithLogitsLoss(reduction='none'))
    loss.set_batch([True, False], 3)
    predictions = torch.zeros((6, 1), requires_grad=True)
    target = torch.tensor([[0.], [1.], [0.], [0.], [1.], [0.]])
    loss(predictions, target).sum().backward()
    assert predictions.grad[:, 0].tolist() == [0., -.5, 0., .5, -.5, .5]


def test_classification_is_not_masked_even_when_shape_matches_objectness():
    loss = partial_objectness_loss(torch.nn.BCEWithLogitsLoss(reduction='none'))
    loss.set_batch([True], 2)
    prediction = torch.zeros((2, 1), requires_grad=True)
    loss(prediction, torch.zeros_like(prediction))
    classification = loss(prediction, torch.zeros_like(prediction))
    classification.sum().backward()
    assert prediction.grad[:, 0].tolist() == [.5, .5]


def test_changed_yolox_loss_contract_fails_instead_of_silently_masking_labels():
    loss = partial_objectness_loss(torch.nn.BCEWithLogitsLoss(reduction='none'))
    loss.set_batch([True], 3)
    with pytest.raises(ValueError, match='anchor shape'):
        loss(torch.zeros((2, 1)), torch.zeros((2, 1)))
