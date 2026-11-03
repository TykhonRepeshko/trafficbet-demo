import numpy as np
from dev import pilot_finetune


def test_native_tile_predictions_return_original_frame_coordinates(monkeypatch):
    seen=[]
    def fake(model,image,classes,threshold):
        seen.append(image.shape)
        return np.array([[5.,10.,15.,20.]]), np.array([.9])
    monkeypatch.setattr(pilot_finetune,'predict',fake)
    boxes,scores=pilot_finetune.predict_tiled(None,np.zeros((500,1280,3),np.uint8),1)
    assert len(seen)==3 and all(shape[1]<=640 for shape in seen)
    assert boxes.shape==(3,4) and len(scores)==3
    assert boxes[:,0].max()>600


def test_partial_predictions_are_unscored_but_complete_background_has_false_positives(monkeypatch):
    class Model:
        def eval(self):
            pass

    rows = [{'id':'partial','partialLabels':True}, {'id':'empty','partialLabels':False}]
    def sample(root, row):
        return row['id'], np.array([[1.,1.,11.,11.]]) if row['partialLabels'] else np.zeros((0,4))
    def predict(model, image, classes):
        return (np.array([[1.,1.,11.,11.],[20.,20.,30.,30.]]), np.array([.9,.8])) if image=='partial' else (np.array([[20.,20.,30.,30.]]),np.array([.8]))
    monkeypatch.setattr(pilot_finetune,'sample',sample)
    monkeypatch.setattr(pilot_finetune,'predict',predict)
    report = pilot_finetune.evaluate(Model(),rows,None)
    assert (report['tp'],report['fp'],report['fn'])==(1,1,0)
    assert report['unverifiedPredictionsOnPartialFrames']==1
    assert report['completeFrames']==1
