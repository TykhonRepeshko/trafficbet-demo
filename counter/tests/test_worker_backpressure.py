"""Bounded admission must not leave fresh rounds behind an unbounded executor queue."""
from concurrent.futures import Future
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from tbcounter.main import Counter
from tbcounter.api import Client
from tbcounter.rules import Definition, Point

RULE=Definition('Line',Point(.1,.5),Point(.9,.5),('A_to_B','B_to_A'),('car','truck'),notes='A reviewed finite line across the road.')

def worker(cameras, processors=2):
    now=1700000000
    iso=lambda t:datetime.fromtimestamp(t,timezone.utc).isoformat()
    rows=[dict(id=i+1,streamId=cam,windowStart=iso(now),windowEnd=iso(now+30+i),countingRules={'profileId':1,'definition':RULE.to_json()}) for i,cam in enumerate(cameras)]
    w=Counter.__new__(Counter)
    w.cfg=SimpleNamespace(processors=processors,worker_name='test',sample_fps=15,conf_threshold=.3,hybrid_motion=False,model='yolox-s',source_presets={})
    w.inflight={};w.jobs={};w.done={};w.pending_results={}
    coverage=SimpleNamespace(covered=True,reason='',segments=[SimpleNamespace(seq=1)])
    w.cameras={sid:SimpleNamespace(id=sid,clock_state='ok',buffer=SimpleNamespace(coverage=lambda *args:coverage),coverage='line',info={}) for sid in set(cameras)}
    w.api=SimpleNamespace(rounds=lambda:rows)
    calls=[]
    def submit(fn,job,*args):
        calls.append(job.cam.id);return Future()
    w.pool=SimpleNamespace(submit=submit)
    w.finish=lambda *args:None
    return w,calls,now

def session(*args,**kwargs):
    return SimpleNamespace(segments=[],complete=False,coverage='line')

def test_executor_admission_is_bounded_instead_of_queueing_every_round():
    w,calls,now=worker([1,2,3,4,5,6])
    with patch('tbcounter.main.time.time',return_value=now),patch('tbcounter.main.pipeline.RoundSession',side_effect=session):
        w.schedule_rounds();w.schedule_rounds()
    assert calls==[1,2]
    assert len(w.jobs)==len(w.inflight)==2

def test_one_camera_cannot_fill_all_processors_with_overlapping_pending_windows():
    w,calls,now=worker([1,1,1,2,3],3)
    with patch('tbcounter.main.time.time',return_value=now),patch('tbcounter.main.pipeline.RoundSession',side_effect=session):w.schedule_rounds()
    assert calls==[1,2,3]
    assert len({j.cam.id for j in w.jobs.values()})==3

def test_completed_future_is_reaped_even_if_the_advance_finished_before_registration():
    w,calls,now=worker([1],1)
    done=Future();done.set_result(None);w.inflight[1]=done
    with patch('tbcounter.main.time.time',return_value=now),patch('tbcounter.main.pipeline.RoundSession',side_effect=session):w.schedule_rounds()
    assert calls==[1]
    assert not w.inflight[1].done()

def test_best_effort_display_writes_have_short_timeouts_but_final_results_keep_retry_budget():
    calls=[]
    response=SimpleNamespace(status_code=200,content=b'{}',json=lambda:{})
    client=Client('http://backend','test',SimpleNamespace(headers={},request=lambda *a,**kw:(calls.append(kw) or response)))
    client.progress(1,{});client.result(1,{})
    assert calls[0]['timeout']==(2,3)
    assert calls[1]['timeout']==(5,30)
