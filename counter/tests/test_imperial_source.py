"""Real timestamp regressions for the night-reviewed Imperial Highway source."""
from datetime import datetime, timezone
import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from tbcounter import video
from tbcounter.clock import OverlayClock
from tbcounter.source_clocks import source_clock

FIXTURE = Path(__file__).parent / 'fixtures' / 'caltrans_d12_imperial'
META = json.loads((FIXTURE / 'manifest.json').read_text(encoding='utf-8'))


def frame(name):
    strip = cv2.imread(str(FIXTURE / name), cv2.IMREAD_GRAYSCALE)
    assert strip is not None
    result = np.zeros((META['height'], META['width']), np.uint8)
    result[:strip.shape[0], META['left']:] = strip
    return result


@pytest.mark.parametrize('sample', META['samples'], ids=lambda sample: sample['displayed'])
def test_sharp_source_clock_reads_real_fives_and_sixes(sample):
    reader = source_clock({'sourceFingerprint': META['sourceFingerprint']})
    hh, mm, ss = map(int, sample['displayed'].split(':'))
    assert reader._read_time(frame(sample['file']), reader.roi) == hh*3600 + mm*60 + ss


def test_source_override_preserves_default_for_changed_or_unknown_sources():
    reader = source_clock({'sourceFingerprint': META['sourceFingerprint']})
    assert reader.ocr_variants == (1,)
    changed = source_clock({'sourceFingerprint': META['sourceFingerprint'] + '-changed'})
    assert changed.ocr_variants == OverlayClock().ocr_variants == (0, 1)
    assert changed.roi is None


def test_real_five_to_six_transition_still_requires_an_observed_tick(monkeypatch):
    before, after = frame('03-21-35.png'), frame('03-21-36.png')
    samples = [(i/5, before if i < 4 else after) for i in range(7)]
    monkeypatch.setattr(video, 'first_frames_gray', lambda *args: samples)
    reader = source_clock({'sourceFingerprint': META['sourceFingerprint']})
    fetched = datetime(2026, 11, 4, 11, 21, 50, tzinfo=timezone.utc).timestamp()
    anchor = reader.anchor_segment(b'real-header-fixture', fetched, 2)
    assert anchor is not None and anchor.source == 'ocr'
    expected = datetime(2026, 11, 4, 11, 21, 35, tzinfo=timezone.utc).timestamp() + .3
    assert anchor.anchor_utc == pytest.approx(expected)
    assert anchor.utc_offset_minutes == -480
    samples[:] = [(i/5, before) for i in range(7)]
    assert reader.anchor_segment(b'no-tick', fetched, 2) is None
    samples[:] = [(i/5, np.zeros_like(before)) for i in range(7)]
    assert reader.anchor_segment(b'unreadable', fetched, 2) is None
