"""Closed rounds must release the detector, while temporary display failures do not lose a valid count."""
from types import SimpleNamespace
import pytest
import requests
from tbcounter import api
from tbcounter.main import Counter, LiveJob


@pytest.mark.parametrize('failure,expected_frames',[(api.Conflict('closed'),0),(requests.ConnectionError('offline'),2),(None,2)])
def test_closed_progress_stops_obsolete_work_without_cancelling_on_transient_errors(failure, expected_frames):
    worker=Counter.__new__(Counter)
    delivered=[]
    def publish(*args):
        if failure is not None:
            raise failure
    worker.api=SimpleNamespace(progress=publish)
    worker.detector=lambda **kwargs:object()
    worker.finalize_round=lambda *args,**kwargs:delivered.append('counted')
    worker.finish=lambda *args,**kwargs:delivered.append('invalid')
    class Session:
        tiled=None
        complete=False
        frames=0
        def feed(self, segment, on_progress):
            on_progress({'vehicleCount':1})
            self.frames+=1
            self.complete=self.frames==2
        def progress(self):
            return {'vehicleCount':1}
        def analysis(self):
            return SimpleNamespace(count=1)
    session=Session()
    job=LiveJob(SimpleNamespace(id=52),{'id':123},session,'yolox-m')
    worker.jobs={123:job}
    worker.inflight={123:object()}
    worker.advance_round(job,[object(),object()],object())
    assert session.frames==expected_frames
    assert delivered==([] if isinstance(failure,api.Conflict) else ['counted'])
    assert worker.jobs=={} and worker.inflight=={}
