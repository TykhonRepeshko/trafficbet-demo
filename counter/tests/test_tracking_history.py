"""A real ByteTrack ID must not erase measured crossings during confirmation."""
import numpy as np
import pytest
from tbcounter.detector import Detections
from tbcounter.rules import Definition, Point, CrossingCounter
from tbcounter.tracking import Tracker

RULE = Definition('test', Point(.1,.5), Point(.9,.5), ('A_to_B','B_to_A'), ('car',), notes='Synthetic confirmed crossing through the visible road.')


def run(rows, recover=True, fps=15):
    tracker = Tracker(fps, .3)
    counter = CrossingCounter(RULE, 999., 1005., 100, 100, stitch_gap=0)
    for i, (boxes, scores) in enumerate(rows):
        now = 1000.+i/fps
        dets = Detections(np.array(boxes, np.float32).reshape(-1,4), np.array(scores, np.float32), ['car']*len(scores))
        current = tracker.update(dets, now)
        early = tracker.take_early_observations()
        for box in current:
            assert box.track_id >= 0
            history = [(at, b.label, b.confidence, b.xyxy, b.source)
                       for at, b in early if b.track_id == box.track_id] if recover else None
            counter.observe(box.track_id, box.label, box.confidence, box.xyxy, now, box.source, history=history)
    return counter


def rows(xs=(40,), scores=(.9,.9,.9)):
    return [([(x, y-30, x+20, y) for x in xs], [score]*len(xs)) for y,score in zip((48,52,56),scores)]


@pytest.mark.parametrize('fps',[5,8,12,15])
def test_crossing_during_id_confirmation_is_recovered_from_real_observations(fps):
    assert run(rows(), recover=False, fps=fps).count == 0
    result = run(rows(), fps=fps)
    assert result.count == 1 and result.rejected == 0
    assert result.crossings[0]['at'] == pytest.approx(1000.+.5/fps)


def test_two_neighbouring_vehicles_keep_separate_crossings():
    result = run(rows((15,65)))
    assert result.count == 2 and result.duplicates == 0


def test_early_weak_evidence_does_not_become_a_confirmed_vehicle():
    result = run(rows(scores=(.31,.31,.9)))
    assert result.count == 0 and result.rejected == 1
    assert run(rows(scores=(.31,.9,.9))).count == 1


def test_ambiguous_overlapping_histories_are_not_used_to_invent_crossings():
    assert run(rows((40,45))).count == 0


def test_missing_observation_breaks_the_history_chain():
    data = rows()
    data.insert(1,([],[]))
    data += [([(40,30,60,60)],[.9])]
    assert run(data).count == 0


def test_a_measurement_cannot_supply_pre_crossing_history_to_two_ids():
    import supervision as sv
    def observed(boxes, ids):
        d=sv.Detections(np.array(boxes,np.float32),confidence=np.full(len(ids),.9,np.float32),
                        class_id=np.zeros(len(ids),np.int64),
                        data={"observation_source":np.array(["detector"]*len(ids))})
        d.tracker_id=np.array(ids)
        return d
    outputs=iter([
        observed([[40,18,60,48]],[-1]),
        observed([[40,22,60,52],[40,22,60,52]],[1,-1]),
        observed([[40,26,60,56]],[2]),
    ])
    tracker=Tracker(15,.3)
    tracker.tracker.update=lambda *args,**kwargs:next(outputs)
    empty=Detections.empty()
    tracker.update(empty,1000.)
    assert tracker.take_early_observations()==[]
    tracker.update(empty,1000.+1/15)
    first=tracker.take_early_observations()
    assert [(at,b.track_id) for at,b in first]==[(1000.,1)]
    tracker.update(empty,1000.+2/15)
    later=tracker.take_early_observations()
    assert [(at,b.track_id) for at,b in later]==[(1000.+1/15,2)]


def test_recovered_history_never_rewinds_an_existing_stitched_identity():
    counter = CrossingCounter(RULE, 999., 1005., 100, 100)
    counter.observe(1, 'car', .9, (40, 10, 60, 40), 1000.)
    counter.observe(1, 'car', .9, (40, 16, 60, 46), 1000.1)
    # Confirmation is late, but the old trajectory is already known. Resolve
    # the stitch at 1000.2 before considering older pre-ID measurements.
    history = [(999.9, 'car', .9, (40, 4, 60, 34), 'detector')]
    counter.observe(2, 'car', .9, (40, 22, 60, 52), 1000.2, history=history)
    assert counter.alias == {2: 1}
    assert counter.count == 1
    assert counter.crossings[0]['at'] == pytest.approx(1000.1 + .1 * 4/6)
    assert counter.tracks[1].strong == 3  # old pre-ID evidence was not replayed
    assert counter.tracks[1].last_at == 1000.2


def test_history_far_from_the_line_cannot_supply_extra_confirmation_votes():
    counter = CrossingCounter(RULE, 999., 1005., 100, 100, stitch_gap=0)
    history = [(1000., 'car', .9, (40, 10, 60, 40), 'detector')]
    counter.observe(1, 'car', .9, (40, 16, 60, 46), 1000.1, history=history)
    counter.observe(1, 'car', .31, (40, 22, 60, 52), 1000.2)
    assert counter.count == 0 and counter.rejected == 1
    assert counter.tracks[1].strong == 1
