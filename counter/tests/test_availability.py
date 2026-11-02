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
