import pytest
import requests
from tbcounter.hls import StreamFetcher
from tbcounter.segments import SegmentBuffer
from tbcounter.source_clocks import source_clock, REVIEWED_CROPS


def test_reviewed_clock_state_is_isolated_and_unknown_source_discovers_afresh():
    fingerprint = next(iter(REVIEWED_CROPS))
    a = source_clock({'sourceFingerprint': fingerprint})
    b = source_clock({'sourceFingerprint': fingerprint})
    a.successes = 12
    a.offset = -28800
    assert b.successes == 0 and b.offset is None
    changed = source_clock({'sourceFingerprint': fingerprint + '-changed'})
    assert changed.roi is None and changed.region_name is None


def test_segment_error_reopens_master_instead_of_reusing_expired_source_session(monkeypatch):
    clock = type('Clock', (), {'anchor_segment': lambda *args: None})()
    fetcher = StreamFetcher(45, 'http://localhost/master', None, SegmentBuffer(120), clock)
    fetcher.variant_url = 'http://localhost/old-session'
    calls = []
    playlist = b'#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:10,\nsegment.ts\n'
    def get(url, limit):
        calls.append(url)
        if url == 'http://localhost/master':
            return b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nnew-session\n'
        if url.endswith('session'):
            return playlist
        if len([c for c in calls if c.endswith('segment.ts')]) == 1:
            raise requests.HTTPError('expired source session')
        return b'video'
    monkeypatch.setattr(fetcher, '_get', get)
    monkeypatch.setattr('tbcounter.hls.video.probe', lambda data: (1.,1280,720))
    with pytest.raises(requests.HTTPError):
        fetcher.poll_once()
    assert fetcher.variant_url is None
    fetcher.poll_once()
    assert 'http://localhost/master' in calls
    assert fetcher.variant_url == 'http://localhost/new-session'
    assert fetcher.buffer.has(1)


def test_stalled_successful_playlist_reopens_master_and_recovers_fresh_segments(monkeypatch):
    now=[0.]
    monkeypatch.setattr('tbcounter.hls.time.monotonic',lambda:now[0])
    clock=type('Clock',(),{'anchor_segment':lambda *args:None})()
    fetcher=StreamFetcher(47,'http://localhost/master',None,SegmentBuffer(120),clock)
    fetcher.variant_url='http://localhost/frozen-session';calls=[]
    def get(url,limit):
        calls.append(url)
        if url.endswith('/master'):return b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nfresh-session\n'
        if url.endswith('session'):
            seq=1 if 'frozen' in url else 2
            return f'#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:{seq}\n#EXTINF:10,\nsegment.ts\n'.encode()
        return b'video'
    monkeypatch.setattr(fetcher,'_get',get)
    monkeypatch.setattr('tbcounter.hls.video.probe',lambda data:(1.,1280,720))
    fetcher.poll_once();assert fetcher.buffer.has(1)
    now[0]=29.;fetcher.poll_once();assert fetcher.variant_url.endswith('frozen-session')
    now[0]=30.;assert fetcher.poll_once()==1.;assert fetcher.variant_url is None
    fetcher.poll_once();assert fetcher.buffer.has(2);assert fetcher.variant_url.endswith('fresh-session')
    assert calls.count('http://localhost/master')==1
    now[0]=31.;fetcher.poll_once();assert fetcher.variant_url.endswith('fresh-session')


@pytest.mark.parametrize('displayed',['14:14:12','14:14:13','14:14:22','14:14:23','14:14:32','14:14:33'])
def test_047_timestamp_crop_excludes_scene_under_the_clock(displayed):
    import json
    from pathlib import Path
    import cv2
    import numpy as np
    root=Path(__file__).parent/'fixtures/caltrans_d12_047'
    meta=json.loads((root/'manifest.json').read_text())
    strip=cv2.imread(str(root/(displayed.replace(':','-')+'.png')),cv2.IMREAD_GRAYSCALE)
    assert strip is not None
    frame=np.zeros((meta['height'],meta['width']),np.uint8)
    frame[:strip.shape[0],meta['left']:]=strip
    reader=source_clock({'sourceFingerprint':meta['sourceFingerprint']})
    hh,mm,ss=map(int,displayed.split(':'))
    assert reader._read_time(frame,reader.roi)==hh*3600+mm*60+ss


def test_expired_old_segment_does_not_prevent_buffering_newer_footage(monkeypatch):
    clock=type('Clock',(),{'anchor_segment':lambda *args:None})()
    fetcher=StreamFetcher(49,'http://localhost/master',None,SegmentBuffer(120),clock)
    fetcher.variant_url='http://localhost/session'
    def get(url,limit):
        if url.endswith('/session'):return b'#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:10,\nexpired.ts\n#EXTINF:10,\nfresh.ts\n'
        if url.endswith('/expired.ts'):raise requests.HTTPError('expired')
        return b'fresh video'
    monkeypatch.setattr(fetcher,'_get',get)
    monkeypatch.setattr('tbcounter.hls.video.probe',lambda data:(1.,1280,720))
    with pytest.raises(requests.HTTPError):fetcher.poll_once()
    assert not fetcher.buffer.has(1)
    assert fetcher.buffer.has(2)
    assert fetcher.variant_url is None


def test_gateway_busy_retries_the_same_handle_with_a_bounded_wait():
    from types import SimpleNamespace
    calls=[];waits=[]
    class Response:
        headers={'Retry-After':'2'}
        def __init__(self,status):self.status_code=status
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def close(self):pass
        def raise_for_status(self):
            if self.status_code!=200:raise requests.HTTPError('busy')
        def iter_content(self,size):yield b'video'
    responses=iter([Response(503),Response(503),Response(200)])
    session=SimpleNamespace(get=lambda url,**kw:(calls.append(url) or next(responses)))
    fetcher=StreamFetcher(49,'http://localhost/master',session,SegmentBuffer(120),None)
    fetcher.stop_event=SimpleNamespace(wait=lambda seconds:(waits.append(seconds) or False))
    assert fetcher._get('http://localhost/resource/handle',100)==b'video'
    assert calls==['http://localhost/resource/handle']*3
    assert waits==[2.,2.]
