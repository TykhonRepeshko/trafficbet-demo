import os

import cv2
import pytest

from conftest import FIXTURES
from tbcounter import clock
from tbcounter.clock import OverlayClock, detect_offset, local_to_utc, parse_time_of_day


def test_parse_time_tolerates_ocr_artifacts():
    assert parse_time_of_day("2026-11-0115:10:47") == 15 * 3600 + 10 * 60 + 47
    assert parse_time_of_day("2926-11-01 15:10:47\n") == 54647
    assert parse_time_of_day("25:10:47") is None
    assert parse_time_of_day("no time") is None


def test_offset_and_day_rollover():
    fetched = 1793541000.0  # 2026-11-01T13:50:00Z (approx.)
    local = (fetched + 3600 - 30) % 86400  # UTC+1, 30 s latency
    assert detect_offset(int(local), fetched) == 3600
    assert abs(local_to_utc(int(local), 3600, fetched) - (fetched - 30)) < 1
    near_midnight = 1793577590.0  # 23:59:50Z → local 00:59:20 next day
    loc = (near_midnight + 3600 - 30) % 86400
    assert abs(local_to_utc(int(loc), 3600, near_midnight) - (near_midnight - 30)) < 1


def test_ocr_reads_real_overlay():
    strip = cv2.imread(os.path.join(FIXTURES, "e18_overlay.png"), cv2.IMREAD_GRAYSCALE)
    frame = cv2.copyMakeBorder(strip, 0, 548, 0, 0, cv2.BORDER_CONSTANT, value=90)  # back to 1024×576
    c = OverlayClock()
    assert c._discover(frame) and c.region_name == "top_right"
    roi = c.roi
    assert roi[2] > 0.75  # the time token sits at the right edge
    assert clock.ocr_time(frame, roi) == 15 * 3600 + 10 * 60 + 47


def test_anchor_real_segment_to_the_frame():
    data = open(os.path.join(FIXTURES, "e18_segment.ts"), "rb").read()
    # Displayed 15:10:47 → 15:10:48 local (UTC+1); pretend we fetched it 25 s after capture of its end.
    capture_tick = 1793542248.0  # 2026-11-01T14:10:48Z
    c = OverlayClock()
    anchor = c.anchor_segment(data, capture_tick + 12.12 + 25 - 0.3, 12.12)
    assert anchor is not None, "overlay clock should anchor the real segment"
    assert anchor.utc_offset_minutes == 60 and c.region_name == "top_right"
    assert anchor.displayed == "15:10:48"
    assert anchor.precision <= 0.03  # one frame at 25 fps
    # The second ticks ~0.3 s after the first frame in this segment.
    assert capture_tick - 0.5 < anchor.anchor_utc + 0.3 < capture_tick + 0.5
    assert 20 < anchor.latency < 30


def test_no_clock_on_blank_video(monkeypatch):
    monkeypatch.setattr(clock, "ocr_time", lambda gray, region, variants=(0, 1): None)
    data = open(os.path.join(FIXTURES, "e18_segment.ts"), "rb").read()
    c = OverlayClock()
    assert c.anchor_segment(data, 1793541080.0, 12.12) is None and c.failures == 1


def test_inconsistent_ocr_is_rejected(monkeypatch):
    calls = {"n": 0}

    def fake(gray, region, variants=(0, 1)):
        calls["n"] += 1
        return 100 if calls["n"] <= 3 else 107  # never a clean s → s+1 tick: misread digits, not time
    monkeypatch.setattr(clock, "ocr_time", fake)
    c = OverlayClock()
    c.region_name = "top_right"
    data = open(os.path.join(FIXTURES, "e18_segment.ts"), "rb").read()
    assert c.anchor_segment(data, 1793541080.0, 12.12) is None


def test_single_misread_is_tolerated(monkeypatch):
    real = clock.ocr_time
    state = {"first": True}

    def flaky(gray, region, variants=(0, 1)):
        if state["first"]:  # the very first read is garbage; majority of the first three frames wins
            state["first"] = False
            return 54659
        return real(gray, region, variants)
    monkeypatch.setattr(clock, "ocr_time", flaky)
    data = open(os.path.join(FIXTURES, "e18_segment.ts"), "rb").read()
    anchor = OverlayClock().anchor_segment(data, 1793542248.0 + 12.12 + 25 - 0.3, 12.12)
    assert anchor is not None and anchor.displayed == "15:10:48"
