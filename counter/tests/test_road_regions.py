from dataclasses import replace
import math
import pytest
from tbcounter.rules import (
    Definition,
    Point,
    crossing_candidate,
    valid_definition,
    in_road_regions,
)

RULE = Definition(
    "Road",
    Point(0.1, 0.5),
    Point(0.9, 0.5),
    ("A_to_B", "B_to_A"),
    ("car",),
    notes="Count the visible vehicle footprint inside the marked carriageways.",
)
ROAD = (Point(0.2, 0.2), Point(0.4, 0.2), Point(0.4, 0.8), Point(0.2, 0.8))


def test_road_boundary_and_excluded_sidewalk_crossings():
    rule = replace(RULE, road_regions=(ROAD,))
    assert valid_definition(rule)
    for x, expected in ((0.3, True), (0.4, True), (0.5, False)):
        assert in_road_regions(rule.road_regions, Point(x, 0.5)) == expected
        assert (
            crossing_candidate(rule, Point(x, 0.4), Point(x, 0.6), 0, 1, 0, 2, "car")
            is not None
        ) == expected
    assert Definition.from_json(rule.to_json()) == rule
    assert "roadRegions" not in RULE.to_json()


@pytest.mark.parametrize(
    "regions",
    [
        ((Point(0, 0), Point(1, 1)),),
        ((Point(0, 0), Point(1, 1), Point(0, 1), Point(1, 0)),),
        ((Point(0, 0), Point(0.5, 0.5), Point(1, 1)),),
        ((Point(0, 0), Point(math.nan, 1), Point(1, 0)),),
        (ROAD,) * 9,
    ],
)
def test_invalid_or_unbounded_road_geometry_is_rejected(regions):
    assert not valid_definition(replace(RULE, road_regions=regions))
