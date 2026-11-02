from types import SimpleNamespace
from tbcounter.quality import counting_problem


def analysis(**changes):
    return SimpleNamespace(
        **(
            {
                "count": 0,
                "crossings": [],
                "quality_issues": [],
                "motion": {
                    "method": "semantic_optical_flow_v1",
                    "warmupFrames": 80,
                    "requiredWarmupFrames": 32,
                },
            }
            | changes
        )
    )


def test_old_unobserved_zero_cannot_settle_a_bet():
    assert counting_problem(analysis(motion={})).startswith("unverified_zero:")


def test_quiet_road_zero_with_motion_check_is_allowed():
    assert counting_problem(analysis()) is None


def test_unclassified_motion_or_merge_invalidates_even_positive_counts():
    for issue in (
        "unclassified_motion_at_line",
        "ambiguous_vehicle_merge",
        "vehicle_lost_near_line",
    ):
        assert counting_problem(
            analysis(count=3, crossings=[{}, {}, {}], quality_issues=[issue])
        ).startswith("unreliable_tracking:")


def test_cold_background_cannot_produce_a_confident_zero():
    assert "warmup" in counting_problem(
        analysis(motion={"warmupFrames": 2, "requiredWarmupFrames": 32})
    )


def test_count_must_match_evidence():
    assert "mismatch" in counting_problem(analysis(count=2, crossings=[{}]))


def test_unconfirmed_crossing_cannot_disappear_into_a_successful_zero():
    assert "unconfirmed_vehicle_crossing" in counting_problem(analysis(rejected=1))
