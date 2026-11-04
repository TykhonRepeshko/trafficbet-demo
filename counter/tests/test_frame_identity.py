import json
from pathlib import Path
import pytest
from tbcounter.rules import CrossingCounter, Definition, Point

BASE = 1000.
RULE = Definition('test', Point(.1,.5), Point(.9,.5), ('A_to_B','B_to_A'), ('car','truck'), notes='Reviewed synthetic straight road for identity and footprint regressions.')


@pytest.mark.parametrize('reverse_rows', [False, True])
def test_real_052_remaining_car_crosses_once_without_merging_a_visible_neighbour(reverse_rows):
    data=json.loads(Path(__file__).with_name('fixtures').joinpath('stitch-052.json').read_text())
    counter=CrossingCounter(Definition.from_json(data['definition']),BASE,BASE+30,data['width'],data['height'])
    for f in data['frames']:
        at=BASE+f['at'];tracks=list(reversed(f['tracks'])) if reverse_rows else f['tracks']
        counter.begin_frame(at,[t['id'] for t in tracks])
        for t in tracks:counter.observe(t['id'],t['class'],t['confidence'],tuple(t['box']),at,'detector')
    target=[c for c in counter.crossings if c['trackId']==16]
    assert len(target)==1
    assert target[0]['at']==pytest.approx(BASE+17.3436, abs=.002)
    assert 16 not in counter.alias


def observe_frame(counter, offset, tracks):
    at=BASE+offset
    counter.begin_frame(at,[tid for tid,_,_,_ in tracks])
    for tid,cls,score,box in tracks:counter.observe(tid,cls,score,box,at,'detector')


def test_truly_lost_track_can_still_be_stitched_in_a_later_frame():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    observe_frame(c,1,[(1,'car',.9,(470,380,530,430))])
    observe_frame(c,1.2,[(1,'car',.9,(470,410,530,470))])
    observe_frame(c,1.5,[(2,'car',.9,(470,470,530,530))])
    assert c.alias=={2:1} and c.count==1


def test_nearby_cars_crossing_at_different_times_are_not_duplicate_boxes():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    for n in range(6):
        first=470+40*n;second=390+40*n
        observe_frame(c,1+n*.1,[(1,'car',.9,(470,first-60,530,first)),
                              (2,'car',.9,(470,second-60,530,second))])
    assert c.count==2 and c.duplicates==0


def test_body_and_glare_tracks_still_count_once_when_present_together():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    for n in range(5):
        bottom=470+20*n
        observe_frame(c,1+n*.1,[(1,'car',.9,(470,bottom-50,530,bottom)),
                              (2,'car',.9,(450,bottom-70,550,bottom))])
    assert c.count==1 and c.duplicates==1
    assert not c.alias


def test_a_car_beside_a_truck_is_not_removed_as_its_glare():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    for n in range(5):
        y=470+20*n
        observe_frame(c,1+n*.1,[(1,'truck',.9,(400,y-200,650,y)),
                              (2,'car',.9,(570,y-50,630,y))])
    assert c.count==2 and c.duplicates==0


def test_duplicate_evidence_has_bounded_storage_after_the_crossing():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    for n in range(200):
        y=470+min(n*20,300)
        observe_frame(c,1+n*.1,[(1,'car',.9,(470,y-50,530,y))])
    assert c.count==1
    state=c.tracks[1]
    assert len(state.observations)<=32
    assert max(at for at,_ in state.observations)<=state.crossing['at']+.25


def initial_patch():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    c.observe(1,'car',.9,(500,390,510,400),BASE,'detector')
    return c


def test_a_bad_first_patch_is_replaced_only_after_three_stable_strong_boxes():
    c=initial_patch()
    for n in range(3):
        y=450+5*n
        c.observe(1,'truck',.9,(470,y-150,570,y),BASE+.1+n*.1,'detector')
        assert c.footprint_resets==(1 if n==2 else 0)
        assert c.count==0
    c.observe(1,'truck',.9,(478,370,578,520),BASE+.5,'detector')
    assert c.count==1 and c.crossings[0]['class']=='truck'
    assert c.crossings[0]['at']==pytest.approx(BASE+.3+.2*40/60)


def test_a_footprint_jump_across_the_line_cannot_create_a_crossing():
    c=initial_patch()
    for n in range(5):
        y=520+5*n
        c.observe(1,'truck',.9,(470,y-150,570,y),BASE+.1+n*.1,'detector')
    assert c.footprint_resets==1 and c.count==0


@pytest.mark.parametrize('fault',['weak','gap','spatial_jump','motion'])
def test_unreliable_footprint_changes_do_not_replace_the_initial_shape(fault):
    c=initial_patch()
    for n in range(3):
        x=470+(300 if fault=='spatial_jump' and n==1 else 0)
        score=.31 if fault=='weak' and n==1 else .9
        at=BASE+.1+n*(.4 if fault=='gap' else .1)
        origin='pixel_motion' if fault=='motion' else 'detector'
        c.observe(1,'truck',score,(x,300,x+100,450),at,origin)
    assert c.footprint_resets==0 and c.count==0


def test_established_footprints_keep_the_area_gate():
    c=initial_patch()
    c.observe(1,'car',.9,(500,395,510,405),BASE+.05,'detector')
    c.observe(1,'car',.9,(500,400,510,410),BASE+.1,'detector')
    for n in range(4):c.observe(1,'truck',.9,(470,300,570,450),BASE+.2+n*.1,'detector')
    assert c.footprint_resets==0 and c.count==0


def test_already_counted_identity_cannot_reset_and_count_again():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    for n,y in enumerate([490,510]):c.observe(1,'car',.9,(500,y-10,510,y),BASE+n*.1,'detector')
    for n in range(4):c.observe(1,'truck',.9,(470,300,570,450),BASE+.2+n*.1,'detector')
    assert c.footprint_resets==0 and c.count==1


def test_real_052_headlight_glare_is_one_physical_car():
    data=json.loads(Path(__file__).with_name('fixtures').joinpath('glare-052.json').read_text())
    c=CrossingCounter(Definition.from_json(data['definition']),BASE,BASE+30,data['width'],data['height'])
    for frame in data['frames']:
        observe_frame(c,frame['at'],[(t['id'],t['class'],t['confidence'],tuple(t['box'])) for t in frame['tracks']])
    assert c.count==data['expectedPhysicalCount']==1
    assert c.duplicates==1


def test_fragmented_glare_without_shared_frames_keeps_the_geometric_duplicate_guard():
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    for tid,offset in [(1,1.),(2,1.2)]:
        observe_frame(c,offset,[(tid,'car',.9,(470,440,530,490))])
        observe_frame(c,offset+.1,[(tid,'car',.9,(470,460,530,510))])
    assert c.count==1 and c.duplicates==1


def test_real_052_reappearing_id_is_separated_before_it_can_reverse_another_car():
    data=json.loads(Path(__file__).with_name('fixtures').joinpath('reappearing-052.json').read_text())
    c=CrossingCounter(Definition.from_json(data['definition']),BASE,BASE+30,data['width'],data['height'])
    for frame in data['frames']:
        observe_frame(c,frame['at'],[(t['id'],t['class'],t['confidence'],tuple(t['box'])) for t in frame['tracks']])
    target=[row for row in c.crossings if row['trackId']==103]
    assert len(target)==1 and target[0]['direction']=='A_to_B'
    assert target[0]['at']==pytest.approx(BASE+25.6161,abs=.002)
    assert c.identity_splits>=1 and not c.issues
    assert 103 not in c.alias
    assert all(row['direction']=='A_to_B' for row in c.crossings)


def test_late_identity_conflict_prevents_verified_settlement():
    from tbcounter.pipeline import RoundSession
    from tbcounter.quality import counting_problem
    c=CrossingCounter(RULE,BASE,BASE+30,1000,1000)
    observe_frame(c,1.,[(1,'car',.9,(470,380,530,430))])
    observe_frame(c,1.2,[(1,'car',.9,(470,410,530,470))])
    observe_frame(c,1.5,[(2,'car',.9,(470,470,530,530))])
    assert c.alias=={2:1} and c.count==1
    observe_frame(c,1.6,[(1,'car',.9,(460,420,520,480)),(2,'car',.9,(470,480,530,540))])
    assert c.identity_splits==1 and not c.alias
    session=RoundSession(None,RULE,BASE,BASE+30,15,.3)
    session.counter=c
    assert counting_problem(session.analysis())=='unreliable_tracking: conflicting_vehicle_identities'


def test_raw_repair_histories_are_bounded():
    c=initial_patch()
    for n in range(200):observe_frame(c,1+n*.1,[(1,'car',.9,(500,390,510,400))])
    assert len(c._raw[1])==96 and 1 in c._raw_truncated


def test_coarse_motion_and_neural_boxes_of_one_car_still_count_once():
    rule=Definition('test',Point(.1,.5),Point(.9,.5),('A_to_B','B_to_A'),
                    ('car','van','bus','truck','motorcycle'),notes=RULE.notes)
    c=CrossingCounter(rule,BASE,BASE+30,1000,1000)
    for n in range(12):
        at=BASE+1+n*.1;y=460+n*5;c.begin_frame(at,[1,2])
        c.observe(1,'car',.9,(470,y-50,530,y),at,'detector')
        c.observe(2,'vehicle',.9,(450,y-70,550,y),at,'pixel_motion')
    assert c.count==1 and c.duplicates==1


@pytest.mark.parametrize('fixture,target', [('stitch-052.json',16),('glare-052.json',None),('reappearing-052.json',103)])
def test_real_observations_flow_through_the_live_counter_and_half_second_overlay(monkeypatch,fixture,target):
    import numpy as np
    from types import SimpleNamespace
    from tbcounter import pipeline
    from tbcounter.detector import Detections
    data=json.loads(Path(__file__).with_name('fixtures').joinpath(fixture).read_text())
    frames=iter(data['frames'])
    class RecordedTracker:
        def update(self,detections,at):
            frame=next(frames)
            assert at==BASE+frame['at']
            return [SimpleNamespace(track_id=t['id'],label=t['class'],confidence=t['confidence'],
                                    xyxy=tuple(t['box']),source='detector') for t in frame['tracks']]
    monkeypatch.setattr(pipeline,'Tracker',lambda *args:RecordedTracker())
    monkeypatch.setattr(pipeline,'TiledDetector',lambda *args,**kwargs:SimpleNamespace(detect=lambda image:Detections.empty(),tiles=[]))
    session=pipeline.RoundSession(None,Definition.from_json(data['definition']),BASE,BASE+30,15,.3)
    image=np.zeros((data['height'],data['width'],3),np.uint8)
    for frame in data['frames']:
        at=BASE+frame['at'];session._frame(at,image,None);session.processed_until=at
    payload=session.progress()
    if target is None:assert payload['vehicleCount']==1
    else:assert len([c for c in payload['crossings'] if c['trackId']==target])==1
    crossings={c['trackId']:c['at'] for c in payload['crossings']}
    assert any(f['boxes'] for f in payload['highlights'])
    for frame in payload['highlights']:
        for box in frame['boxes']:
            assert crossings[box['trackId']]<=frame['at']<crossings[box['trackId']]+.5


@pytest.mark.parametrize("camera", [45, 52])
def test_real_screenshot_fragments_count_physical_vehicles_once(camera):
    from tbcounter.pipeline import RoundSession
    from tbcounter.quality import counting_problem

    data = json.loads(Path(__file__).with_name("fixtures").joinpath(f"fragment-{camera}.json").read_text())
    counter = CrossingCounter(Definition.from_json(data["definition"]), BASE, BASE + 30,
                              data["width"], data["height"])
    for frame in data["frames"]:
        at = BASE + frame["at"]
        counter.begin_frame(at, [t["id"] for t in frame["tracks"]])
        for t in frame["tracks"]:
            history = [(BASE + at, label, score, tuple(box), origin)
                       for at, label, score, box, origin in (t.get("history") or [])]
            counter.observe(t["id"], t["class"], t["confidence"], tuple(t["box"]), at,
                            "detector", history)
    assert counter.count == data["expectedPhysicalCount"]
    assert counter.duplicates == 1 and counter.rejected == 0
    session = RoundSession(None, counter.rule, BASE, BASE + 30, 15, .3)
    session.counter = counter
    assert counting_problem(session.analysis()) is None
    assert all(set(event) == {"trackId", "class", "direction", "at"}
               for event in counter.crossings)


def test_partly_overlapping_cars_in_adjacent_lanes_remain_two_vehicles():
    counter = CrossingCounter(RULE, BASE, BASE + 30, 1000, 1000)
    for n in range(6):
        y = 460 + n * 20
        observe_frame(counter, 1 + n * .1, [
            (1, "car", .9, (400, y - 70, 500, y)),
            (2, "car", .9, (450, y - 70, 550, y)),
        ])
    assert counter.count == 2 and counter.duplicates == 0


def test_weak_fragment_of_a_confirmed_car_does_not_refund_the_round():
    counter = CrossingCounter(RULE, BASE, BASE + 30, 1000, 1000)
    for n in range(6):
        y = 460 + n * 20
        observe_frame(counter, 1 + n * .1, [
            (1, "car", .9, (470, y - 60, 530, y)),
            (2, "car", .25, (468, y - 62, 532, y)),
        ])
    assert counter.count == 1 and counter.rejected == 0
    # A separate weak crossing still prevents verified settlement.
    observe_frame(counter, 2, [(3, "car", .25, (700, 410, 760, 470))])
    observe_frame(counter, 2.1, [(3, "car", .25, (700, 470, 760, 530))])
    assert counter.count == 1 and counter.rejected == 1


def test_measured_fragment_histories_are_bounded_after_a_crossing():
    counter = CrossingCounter(RULE, BASE, BASE + 30, 1000, 1000)
    for n in range(200):
        y = 460 + min(n * 20, 300)
        observe_frame(counter, 1 + n * .1, [(1, "car", .9, (470, y - 60, 530, y))])
    state = counter.tracks[1]
    assert len(state.measured_bodies) <= 32
    assert max(at for at, _ in state.measured_bodies) <= state.crossing["at"] + .25
