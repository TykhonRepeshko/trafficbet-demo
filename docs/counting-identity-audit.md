# Vehicle identity audit and remaining 052 miss

Serving version `1.4.0-exp.8`, 4 November 2026. This follows the
[half-second pulse change](counting-pulse-and-recall.md). The subsequent
[047 line and range update](line-047-and-ranges.md) changes that camera
geometry; the recorded counts below retain their original frozen definitions.

## Result and counting changes

The reviewed 30-second 052 recording now matches all 17 adjudicated events,
including the car at 17.34 seconds that version 7 missed. It adds that event
without losing any of version 7's 16 events. The manual review was adjudicated
after algorithm differences were examined; this sample is not an independent
accuracy certification. The separately reviewed 049 two-event control remains
2/2. The prior 047 15-second control remains 13 and the dense 052 control remains
33, with corrected identities and a refined truck footprint/crossing time.

The remaining miss came from joining a new car to another ID still present in
the same frame. The counter now declares all frame IDs before processing rows,
so row order and a weak observation of the neighbouring ID cannot cause that
join. A genuinely disappeared track can still be stitched to a later fragment.

A lost ID can also return after a stitch. If two members of the joined identity
coexist, the counter removes that association and rebuilds their separate
trajectories from their own measured observations. Raw repair history is bounded
to 96 observations per ID. Rebuilding cannot create another stitch. A conflict
after a crossing, or with truncated history, sets
`conflicting_vehicle_identities`; the existing quality/refund path then prevents
a verified settlement. Repair before the crossing preserves the independent
cars. The real 052 regression covers the previously false reverse-direction
crossing caused by interleaving two approaching cars' anchor points.

A wrong small initial patch no longer poisons a truck's footprint permanently.
Only a track with at most two accepted boxes and no observed passage can replace
that initial shape. Replacement needs three consecutive strong neural boxes,
adjacent within 0.25 seconds and with IoU at least 0.5. The old anchor and votes
are discarded before replaying those measured boxes. The footprint jump itself
cannot cross the line. Established tracks and already counted cars retain the
original area gate and cannot reset to count again.

Duplicate suppression keeps the existing 0.35-second geometric guard and 0.6
containment criterion for compatible classes, including the generic motion
class. Two strong disjoint boxes in at least two shared captured frames establish
separate vehicles. Missing shared evidence retains the geometric guard, which
is needed for offset or fragmented headlight glare. A separate real regression
ensures that IDs 18 and 34 over one approaching car still produce one count.
A car beside a truck and closely following cars have dedicated regressions.

No confidence threshold, approved geometry, road mask, capture-clock rule,
coverage requirement or existing refund gate was weakened. Sampling remains
15 FPS with the same exact-source model/coverage presets. Green fill still lasts
only within `[crossing.at, crossing.at + 0.5)` in capture time.

## Six-camera recorded checks

Fresh continuous 30-second windows were decoded at 15 FPS for all six active
cameras, with the two-second pre-roll: 480 frames per camera. All six source-clock
readings per camera succeeded. Real neural measurements were saved once and
replayed identically through baseline `dd2fa4f` and the final serving-image
counter. Models and reviewed definitions were held fixed. Initial inference
used CPU for 045/047/048 and CUDA for 049/051/052; this comparison does not measure
inference speed. Raw before/after frame sheets were used to inspect identity,
footprint, glare and direction differences.

These are algorithm counts and quality diagnostics, not complete manual truth
for the fresh clips. A higher count alone does not establish improved recall.

| Camera | Baseline count | Current count | Current window quality |
| --- | ---: | ---: | --- |
| 045 | 63 | 68 | Unconfirmed crossings; late identity conflict |
| 047 | 19 | 19 | Unconfirmed crossing; events unchanged |
| 048 | 68 | 69 | Unconfirmed crossings; overlapping low-score boxes remain ambiguous |
| 049 | 45 | 45 | Unconfirmed crossings |
| 051 | 63 | 66 | Unconfirmed crossings; late identity conflict |
| 052 | 75 | 78 | Existing quality checks pass |

No count decreased during frame-by-frame replay of any of these six windows.
The 047 rule and road mask still cover only the reviewed right-hand carriageway.
The truck/car and direction checks are differential adjudication, without a full
independent label set for all fresh traffic. Night blur, occlusion and merged
low-score boxes still prevent a guarantee of zero missed or double-counted
vehicles in every scene. The rejected windows above cannot settle as verified
counts; their predictions follow the refund path.

## Tests and local runtime

The final serving image passed 221 counter tests; one optional test was skipped.
The 24 new cases include three compact fixtures of actual measured 052 tracking
observations: the remaining missed car, duplicate glare over one car, and a
returning original ID. Pipeline integration verifies the recovered IDs and
half-second live highlight bounds. Other cases cover row ordering, real lost
fragments, simultaneous and fragmented duplicates, neighbouring vehicles,
initial shape consensus, rejected weak/gapped/motion evidence, bounded histories,
late-conflict settlement rejection and prevention of recounting.

All 196 frontend regressions passed. There are no frontend or Go API source changes or
database schema changes in this follow-up. The rebuilt local counter identifies
as `1.4.0-exp.8`, API health reports automatic settlement enabled, and the six
active schedules remain enabled. The final live metadata audit across all six
cameras found no pulse past its half-second expiry (maximum age 0.4997 seconds).
Some identities have no measured position in their pulse interval and remain
unmarked rather than blinking later along the road.

A separate test account placed four 25-credit predictions on live 052 round 5519.
It completed with a verified count of 79: two predictions won and two lost, none
refunded or pending. Inclusive and impossible ranges, fixed Over/Under, quote
bounds, and idempotent retries before/after settlement passed. Balance moved
from 8,781 to 8,749 credits; the exact -32 delta matched the ledger and stored
payouts. No test used the ordinary viewer account. Global pending predictions
were zero after this check.

The app and CUDA counter are left running. Shared GPU load can still delay
processing, and unverifiable windows still refund. Private recordings, source
hashes, detector measurements, frame sheets and runtime receipts are under the
ignored `.tools/stitch-audit-20261104/` directory. The three small committed JSON
fixtures contain only tracking measurements and partial review notes, without
video, credentials or account data.
