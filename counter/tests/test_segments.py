from tbcounter.clock import Anchor
from tbcounter.segments import Segment, SegmentBuffer


def seg(seq, start, dur=10.0, anchored=True, pts=None, disc=False, fetched=None):
    pts = 1000.0 + (start - 0) if pts is None else pts
    anchor = Anchor(first_pts=pts, anchor_utc=start, precision=0.02, utc_offset_minutes=60, latency=20,
                    displayed="12:00:00") if anchored else None
    return Segment(seq=seq, duration=dur, data=b"", fetched_at=fetched or start + dur + 20, discontinuity=disc,
                   anchor=anchor, first_pts=pts)


def test_continuous_chain_covers_window():
    b = SegmentBuffer(600)
    for i in range(5):
        b.add(seg(10 + i, 100.0 + 10 * i))
    cov = b.coverage(112.0, 142.0)
    assert cov.covered and [s.seq for s in cov.segments] == [11, 12, 13, 14]


def test_missing_segment_breaks_coverage():
    b = SegmentBuffer(600)
    for i in (0, 1, 3, 4):
        b.add(seg(10 + i, 100.0 + 10 * i))
    cov = b.coverage(105.0, 135.0)
    assert not cov.covered and cov.reason == "missing_or_unanchored_segment"


def test_clock_disagreeing_with_media_time_breaks_coverage():
    b = SegmentBuffer(600)
    b.add(seg(1, 100.0))
    b.add(seg(2, 111.5, pts=1010.0))  # camera clock says +11.5 s, media clock says +10 s
    assert b.coverage(105.0, 115.0).reason == "discontinuous_footage"


def test_isolated_ocr_miss_is_bridged_by_media_clock():
    b = SegmentBuffer(600)
    b.add(seg(1, 100.0, pts=1100.0))
    b.add(seg(2, 0.0, anchored=False, pts=1110.0, fetched=140.0))  # OCR failed; media clock continues
    b.add(seg(3, 120.0, pts=1120.0))
    cov = b.coverage(105.0, 125.0)
    assert cov.covered and cov.evidence()["derivedAnchors"] == 1


def test_bridge_rejects_media_jump():
    b = SegmentBuffer(600)
    b.add(seg(1, 100.0, pts=1100.0))
    b.add(seg(2, 0.0, anchored=False, pts=1300.0, fetched=140.0))
    assert not b.coverage(105.0, 115.0).covered


def test_future_window_waits_for_footage():
    b = SegmentBuffer(600)
    b.add(seg(1, 100.0))
    assert b.coverage(120.0, 150.0).reason == "footage_not_yet_available"
