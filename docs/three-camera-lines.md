# Screenshot lines for cameras 045, 049 and 052

Reviewed on 4 November 2026; original geometry deployment `1.4.0-exp.8`.
The later [manual counting check](manual-three-camera-counting.md) finds and fixes
extra IDs on 045 and 052 in `1.4.0-exp.9`. The original replay totals below are
functional measurements before that correction, not manual vehicle truth.
Coordinates are normalized to the complete video frame, before CSS resizing.
The user's green marks specify the finite segment and selected carriageway.

## Camera 052 after the later camera pan

The operator changed the Imperial Highway view later on 4 November. Profile
**42 / v3** replaces the previous 052 line for future rounds, following the user's
new screenshot: **(0.223, 0.550) → (0.505, 0.674)**, from the median toward the near
shoulder across the foreground main carriageway. Its road mask was realigned to
this view and excludes opposing traffic, the far-left loop and the right slip
road. Detection and road-mask entry still do not count; only a confirmed crossing
of the finite segment counts once per vehicle.

A fresh 30-second source-clock-qualified replay at 15 FPS decoded all **480/480**
frames, counted 26 crossings, rejected none and raised no quality problem. Every
counted identity had display metadata. This is a functional check, not a manual
accuracy score. The existing finite-segment, no-crossing and recrossing
regressions pass with the updated profile: **234 tests passed, 1 optional skip**.

The exact new definition hash is rebound to the existing YOLOX-M / full-frame
preset in `reviewed-inference-presets.json` and the private local configuration.
The worker was rebuilt/restarted; inference FPS, timing/coverage gates and odds
settings stay unchanged. Future schedule wording describes the foreground line;
7,249 previously published round terms and frozen rules were compared unchanged.
The original geometry below remains the historical record of the earlier view.

## Earlier approved screenshot geometry

| Camera | Approved local profile | Line start → end | Counting scope |
| --- | --- | --- | --- |
| 045 · Ball Road | 39 / v2 | (0.260, 0.590) → (0.615, 0.475) | Foreground carriageway, near verge to median |
| 049 · Jamboree | 40 / v3 | (0.270, 0.440) → (0.735, 0.600) | Foreground carriageway, median to right verge |
| 052 · Imperial | 41 / v2 | (0.195, 0.680) → (0.570, 0.570) | Left main carriageway, left verge to central divider |

The corresponding road masks exclude the other carriageways. Camera 045 also
excludes the foreground crossing street; 049 excludes the frontage road and
pavement; 052 excludes the separate far-left ramp and triangular island.
The exported definitions are in `counter/dev/profiles/`.

Counts still require a confirmed bottom-centre crossing of the finite published
line in capture UTC, once per vehicle identity. Detection, entry into the road
mask and movement on one side do not increment the counter. Crossing the line's
infinite extension beyond either endpoint does not count. The mask filters
observations; it is not a second counting boundary. Green fill retains its
half-second post-crossing lifetime.

## Recorded and live checks

Fresh official HLS recordings were decoded at 15 FPS, with two seconds of
pre-roll and a 30-second counting window: 480/480 frames per camera. Every
recorded segment had a readable source-clock anchor. Actual CUDA inference
produced the following functional results, without cached predictions:

| Camera | Existing inference setting | Count | Rejected crossings | Quality problem | Compute seconds |
| --- | --- | --- | --- | --- | --- |
| 045 | YOLOX-S / line | 63 | 0 | None | 16.451 |
| 049 | YOLOX-M / full frame | 68 | 0 | None | 9.851 |
| 052 | YOLOX-M / full frame | 48 | 0 | None | 12.199 |

All counted identities had display metadata. These clips have no complete manual
vehicle labels, so the totals are not accuracy scores. Detector modes remain
unchanged; their reviewed presets were rebound to the new exact definition
hashes in `reviewed-inference-presets.json` and the private local configuration.

All 222 counter tests passed in the serving image; one optional test was skipped.
The added regression loads all three profiles and checks a real segment passage,
recrossing without a second count, movement without crossing, exclusion of the
opposite road, and crossings beyond both segment endpoints without an ROI mask.

Live results using the new frozen profiles included 78 on 045 (round 6115),
79 on 049 (6100), and 51 on 052 (6101). Browser checks confirmed all three lines
on live video and visible public AI count/history. Some live windows still fail
tracking or upstream-media checks and refund through the existing quality path;
no confidence, timing, coverage or refund safeguard was weakened.

## Application and preservation

The profiles were approved for future publications through the audited admin
API. Their initial reference counts are 63, 68 and 48 respectively; later
successful counts continue updating future references normally. Source URLs,
model choices, timing and odds are unchanged. Existing published snapshots and
accepted prediction terms retain their previous geometry and values. Their
immutable-term and snapshot hashes were checked before and after the update.

The six schedules remain enabled. API, frontend, database and CUDA counter are
left running locally. Private recordings, hashes, tests and runtime receipts
are retained under ignored `.tools/three-lines-20261104/`.
