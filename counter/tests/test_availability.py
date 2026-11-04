from types import SimpleNamespace

from tbcounter.main import NO_CLOCK_REASON, NO_LINE_REASON, Counter


def camera(successes, failures, profile):
    return SimpleNamespace(clock_state="ok" if successes >= 2 else ("missing" if successes == 0 and failures >= 3 else "probing"),
                           profile=profile)


def test_rounds_are_offered_only_with_clock_and_line():
    assert Counter.wanted_availability(camera(0, 3, {"id": 1})) == (False, NO_CLOCK_REASON)
    assert Counter.wanted_availability(camera(1, 0, None)) == (None, "")
    assert Counter.wanted_availability(camera(2, 0, None)) == (False, NO_LINE_REASON)
    available, _ = Counter.wanted_availability(camera(2, 0, {"id": 7}))
    assert available is True


def test_a_previously_readable_clock_does_not_keep_a_stalled_feed_available(monkeypatch):
    from tbcounter.main import NO_SOURCE_REASON
    monkeypatch.setattr('tbcounter.main.time.monotonic',lambda:1000.)
    cam=camera(100,0,{'id':7});cam.fetcher=SimpleNamespace(last_segment_at=954.)
    assert Counter.wanted_availability(cam)==(False,NO_SOURCE_REASON)
    cam.fetcher.last_segment_at=990.
    assert Counter.wanted_availability(cam)[0] is True


def test_fresh_video_resumes_an_automation_pause_without_waiting_for_metadata_refresh(monkeypatch):
    monkeypatch.setattr('tbcounter.main.time.monotonic',lambda:1000.)
    calls=[];w=Counter.__new__(Counter)
    w.cfg=SimpleNamespace(auto_calibration_enabled=False)
    w.api=SimpleNamespace(availability=lambda sid,enabled,reason:calls.append(enabled))
    w.maybe_probe_coverage=lambda cam:None
    cam=camera(100,0,{'id':7});cam.id=52;cam.info={'roundsEnabled':True};cam.availability=None;cam.fetcher=SimpleNamespace(last_segment_at=900.);cam.recalibrate=False;cam.calibration=None
    w.manage_camera(cam);w.manage_camera(cam)
    assert calls==[False] and cam.info['roundsEnabled'] is False
    cam.fetcher.last_segment_at=999.
    w.manage_camera(cam);w.manage_camera(cam)
    assert calls==[False,True] and cam.info['roundsEnabled'] is True
