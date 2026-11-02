from tbcounter.rules import (
    CrossingCounter,
    Definition,
    Point,
    crossing_candidate,
    valid_definition,
)

START = 1700000000.0
END = START + 60


def test_numpy_coordinates_preserve_capture_epoch_precision_and_json():
    import json
    import numpy as np

    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    counter.observe(
        9, "car", np.float32(0.9), np.array([480, 380, 520, 430], np.float32), START + 1
    )
    counter.observe(
        9,
        "car",
        np.float32(0.9),
        np.array([480, 420, 520, 470], np.float32),
        START + 1.5,
    )
    counter.observe(
        9, "car", np.float32(0.9), np.array([480, 480, 520, 530], np.float32), START + 2
    )
    assert counter.count == 1
    assert START + 1.5 < counter.crossings[0]["at"] < START + 2
    json.dumps(counter.crossings)


def test_coarse_vehicle_is_valid_only_for_all_motor_vehicle_rules():
    before, after = Point(0.5, 0.4), Point(0.5, 0.6)
    all_classes = ("car", "van", "bus", "truck", "motorcycle")
    assert (
        crossing_candidate(
            rule(classes=all_classes),
            before,
            after,
            START,
            START + 1,
            START,
            END,
            "vehicle",
        )
        is not None
    )
    assert (
        crossing_candidate(
            rule(classes=("car",)),
            before,
            after,
            START,
            START + 1,
            START,
            END,
            "vehicle",
        )
        is None
    )
    counter = CrossingCounter(rule(classes=all_classes), START, END, 1000, 1000)
    for i in range(7):
        counter.observe(
            8, "vehicle", 0.7, (480, 350 + i * 25, 520, 450 + i * 25), START + i * 0.125
        )
    assert (
        counter.count == 0
    ), "coarse candidates need a longer confirmation than classified vehicles"
    counter.observe(8, "vehicle", 0.7, (480, 525, 520, 625), START + 7 * 0.125)
    assert counter.count == 1


def test_integer_pixel_anchor_can_pass_through_the_line_without_losing_crossing():
    for points, expected in (
        ([450, 500, 550], 1),
        ([450, 500, 450], 0),
        ([500, 550, 600], 0),
    ):
        counter = CrossingCounter(rule(), START, END, 1000, 1000)
        for i, y in enumerate(points):
            counter.observe(4, "car", 0.9, (480, y - 80, 520, y), START + i * 0.125)
        assert counter.count == expected


def rule(**kw):
    base = dict(
        label="Cross the marked line",
        line_start=Point(0.1, 0.5),
        line_end=Point(0.9, 0.5),
        directions=("A_to_B", "B_to_A"),
        classes=("car", "truck"),
        anchor="bottom_center",
        time_basis="capture_utc",
        notes="Include both lanes; exclude parked vehicles and uncertain crossings.",
    )
    base.update(kw)
    return Definition(**base)


# Mirrors TestCrossingRulesFiniteLineDirectionAndTimeBoundaries in backend/internal/app/evaluation_test.go
def test_go_parity_boundaries_direction_class():
    before, after = Point(0.5, 0.4), Point(0.5, 0.6)
    c = crossing_candidate(
        rule(), before, after, START - 1, START + 1, START, END, "car"
    )
    assert c is not None and c.at == START and c.direction == "A_to_B"
    assert (
        crossing_candidate(rule(), before, after, END - 1, END + 1, START, END, "car")
        is None
    )  # exclusive end
    assert (
        crossing_candidate(
            rule(),
            Point(0.95, 0.4),
            Point(0.95, 0.6),
            START,
            START + 1,
            START,
            END,
            "car",
        )
        is None
    )
    assert (
        crossing_candidate(
            rule(), before, Point(0.5, 0.5), START, START + 1, START, END, "car"
        )
        is None
    )  # touch
    assert (
        crossing_candidate(rule(), before, after, START, START + 1, START, END, "bus")
        is None
    )
    assert (
        crossing_candidate(
            rule(directions=("B_to_A",)),
            before,
            after,
            START,
            START + 1,
            START,
            END,
            "car",
        )
        is None
    )


def test_reverse_direction_and_interpolated_time():
    c = crossing_candidate(
        rule(),
        Point(0.3, 0.7),
        Point(0.3, 0.4),
        START + 10,
        START + 13,
        START,
        END,
        "truck",
    )
    assert c.direction == "B_to_A" and abs(c.at - (START + 12)) < 1e-9


def test_definition_validation_matches_backend():
    assert valid_definition(rule())
    assert not valid_definition(rule(notes="too short"))
    assert not valid_definition(rule(line_end=Point(0.12, 0.51)))  # shorter than 0.05
    assert not valid_definition(rule(anchor="center"))
    assert not valid_definition(rule(classes=("car", "car")))
    assert not valid_definition(rule(classes=("bicycle",)))
    assert not valid_definition(rule(line_start=Point(-0.1, 0.5)))


def test_counter_counts_first_allowed_crossing_per_track_only():
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    box = lambda y: (480.0, y - 50, 520.0, y)  # bottom-centre x=500
    for i, y in enumerate(
        [400, 450, 520, 560, 490, 530]
    ):  # crosses down, back up, down again
        counter.observe(1, "car", 0.9, box(y), START + 1 + i)
    for i, y in enumerate([300, 350, 380]):  # never reaches the line
        counter.observe(2, "car", 0.9, box(y), START + 1 + i)
    assert counter.count == 1
    assert (
        counter.crossings[0]["trackId"] == 1
        and counter.crossings[0]["direction"] == "A_to_B"
    )


def test_counter_uses_majority_class():
    counter = CrossingCounter(rule(classes=("truck",)), START, END, 1000, 1000)
    counter.observe(7, "truck", 0.9, (480, 300, 520, 400), START + 1)
    counter.observe(7, "car", 0.3, (480, 400, 520, 470), START + 2)
    counter.observe(7, "truck", 0.8, (480, 470, 520, 560), START + 3)
    assert counter.count == 1 and counter.crossings[0]["class"] == "truck"


def test_weak_tracks_never_count():
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    counter.observe(3, "car", 0.3, (480, 400, 520, 450), START + 1)
    counter.observe(
        3, "car", 0.3, (480, 500, 520, 560), START + 2
    )  # crosses, but never confidently seen
    assert counter.count == 0 and counter.rejected == 1


def test_ballooning_box_does_not_create_a_crossing():
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    counter.observe(4, "car", 0.9, (480, 380, 520, 420), START + 1)
    counter.observe(4, "car", 0.9, (482, 390, 522, 430), START + 2)
    counter.observe(
        4, "car", 0.6, (200, 300, 800, 900), START + 3
    )  # phantom: 225x larger, bottom below the line
    assert counter.count == 0


def test_fragmented_track_is_stitched_across_the_line():
    # Night blur: the tracker drops id 5 just before the line and starts id 9 just after it.
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    counter.observe(5, "car", 0.8, (470, 380, 530, 430), START + 1.0)
    counter.observe(5, "car", 0.7, (470, 410, 530, 470), START + 1.2)
    counter.observe(
        9, "car", 0.6, (470, 470, 530, 530), START + 1.5
    )  # new id, 0.3 s later, next to it
    counter.observe(9, "car", 0.7, (470, 500, 530, 570), START + 1.7)
    assert counter.count == 1 and counter.stitches == 1
    assert 1.2 < counter.crossings[0]["at"] - START < 1.5


def test_unrelated_or_late_tracks_are_not_stitched():
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    counter.observe(5, "car", 0.8, (470, 380, 530, 430), START + 1.0)
    counter.observe(5, "car", 0.7, (470, 410, 530, 470), START + 1.2)
    counter.observe(
        9, "car", 0.8, (100, 520, 160, 580), START + 1.4
    )  # another vehicle far away
    counter.observe(9, "car", 0.8, (100, 540, 160, 600), START + 1.6)
    counter.observe(
        11, "car", 0.8, (470, 500, 530, 560), START + 3.0
    )  # too late (1.8 s gap)
    counter.observe(11, "car", 0.8, (470, 520, 530, 580), START + 3.2)
    assert counter.count == 0 and counter.stitches == 0


def test_stitching_can_be_disabled():
    counter = CrossingCounter(rule(), START, END, 1000, 1000, stitch_gap=0)
    counter.observe(5, "car", 0.8, (470, 380, 530, 430), START + 1.0)
    counter.observe(5, "car", 0.7, (470, 410, 530, 470), START + 1.2)
    counter.observe(9, "car", 0.6, (470, 470, 530, 530), START + 1.5)
    counter.observe(9, "car", 0.7, (470, 500, 530, 570), START + 1.7)
    assert counter.count == 0


def test_duplicate_boxes_of_one_vehicle_count_once():
    # A car's body box and a larger headlight-glare box form two tracks that cross together.
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    for tid, box in ((1, (470, 0, 530, 0)), (2, (450, -20, 550, 0))):
        x1, dy1, x2, dy2 = box
        counter.observe(tid, "car", 0.8, (x1, 420 + dy1, x2, 470), START + 1.0)
        counter.observe(tid, "car", 0.8, (x1, 450 + dy1, x2, 520), START + 1.2)
    assert (
        counter.count == 1 and counter.duplicates == 1 and len(counter.crossings) == 1
    )
    assert "box" not in counter.crossings[0]


def test_side_by_side_vehicles_both_count():
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    for tid, x in ((1, 300), (2, 600)):
        counter.observe(tid, "car", 0.8, (x, 420, x + 60, 470), START + 1.0)
        counter.observe(tid, "car", 0.8, (x, 450, x + 60, 520), START + 1.2)
    assert counter.count == 2 and counter.duplicates == 0


def test_stopped_vehicle_is_not_stitched_to_a_car_beyond_the_line():
    # Queue at a junction: car 5 stands just before the line and is lost; car 9 appears just past it.
    counter = CrossingCounter(rule(), START, END, 1000, 1000)
    for k in range(4):
        counter.observe(5, "car", 0.8, (470, 420, 530, 480), START + 1.0 + 0.2 * k)
    counter.observe(9, "car", 0.8, (470, 470, 530, 530), START + 2.0)
    counter.observe(9, "car", 0.8, (470, 475, 530, 535), START + 2.2)
    assert counter.count == 0 and counter.stitches == 0
