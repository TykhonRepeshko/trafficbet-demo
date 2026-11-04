# Counted-vehicle pulse and missed-crossing follow-up

Historical follow-up: `1.4.0-exp.7`, 4 November 2026.
The current [identity audit](counting-identity-audit.md) describes `1.4.0-exp.8`,
which resolves the remaining reviewed 052 miss and adds multi-camera checks.

## Half-second display

The filled translucent green rectangle has no outline. Both the counter payload
and the player enforce `crossing.at <= displayedCaptureTime < crossing.at + 0.5`.
Approaching vehicles, missing clocks, stale positions and future frames remain
hidden. Interpolation uses adjacent measured positions of the same counted ID,
with a maximum 0.31-second gap and 0.25-second stale hold, within that pulse.
Later positions never restart the pulse. Late class confirmation can publish
previously measured positions at the actual crossing time; it cannot create a
new pulse farther down the road. Existing frame, box and byte budgets remain.

Live metadata checked across all six cameras contained only confirmed crossing
IDs and ages below 0.5 seconds (maximum in the final live audit: 0.4999 seconds).
Some counted IDs had no measured position within their pulse interval; those
remain unmarked rather than receiving a later, misleading pulse. Frontend
regressions cover the exact expiry boundary, independent IDs, late positions,
missing crossing times, and stale samples.

## Recovering crossings hidden by ID confirmation

Pinned ByteTrack waits for consecutive observations before exposing a track ID.
A vehicle can cross the line before that ID exists. The worker retains at most
0.6 seconds of real, unassigned neural detections, matches adjacent frames with
same-class IoU >= 0.35, and requires a unique match in both directions. Gaps,
ambiguous overlaps and non-neural observations cannot restore history. Each
measurement can be owned by only one trajectory.

The counter resolves stitching using the current confirmed observation first.
It restores history only for a new independent trajectory whose measured
positions actually cross the finite approved line during the window. Existing
stitched trajectories are never rewound. History entirely before or after the
line cannot add confirmation votes or change other tracks. Existing confidence,
class, area, road-mask, capture-clock and tracking gates remain intact.

A broader prototype recovered more events but altered identity stitching on a
fresh dense night sample. It was replaced by this conservative variant. No model
confidence threshold or refund criterion was lowered.

## Recorded comparison

The baseline is commit `010f3c3`; both variants consume identical actual neural
detections at 15 FPS. This isolates tracking changes, without claiming an
inference speed improvement.

| Recording | Window | Baseline | Serving fix | Review scope |
| --- | --- | ---: | ---: | --- |
| 052, initial Imperial night sample | 30 s | 15 | 16 | 17 visually adjudicated events; one known miss remains |
| 049, previous night control | 30 s | 2 | 2 | Both manually reviewed events retained |
| 052, fresh dense night sample | 15 s | 33 | 33 | Exact counted IDs, classes, directions and times unchanged |
| 047, fresh right-side sample | 15 s | 13 | 13 | Exact counted IDs, classes, directions and times unchanged |

The initial 052 manual review was incomplete. Frame-by-frame review of the
algorithm differences confirmed two additional approaching cars at about
9.85 and 17.34 seconds, making 17 actual crossings. This is adjudication after
seeing differences, not an independent held-out accuracy score. The serving
fix recovers the 9.85-second car without dropping any previous event. The
17.34-second car remained missed in that version. The later
[identity-stitching fix](counting-identity-audit.md) recovers it and matches
all 17 adjudicated events in this recording. Fresh samples are differential regression checks, without a
complete manual label set. These small samples do not certify every vehicle or
all cameras under all lighting and occlusion conditions.

## Runtime and validation

Sampling remains 15 FPS, with YOLOX-M/full-frame for 049 and 052 and YOLOX-S/line
for 045, 047, 048 and 051. Exact-source, frozen-definition presets now retain
all six reviewed modes, avoiding redundant coverage probes. A source or rule
change invalidates the corresponding preset. The worker also stops processing
a round immediately when the authoritative API rejects progress because the
round is already closed; transient network errors still allow valid work.

The final serving image passed 197 counter tests, with one optional test skipped.
All 196 frontend regressions and production/preview builds passed. Tests include
real ByteTrack crossings at 5/8/12/15 FPS, adjacent vehicles, ambiguous matches,
weak evidence, gaps, unique measurement ownership, preserved stitch timing,
history away from the line, pulse expiry, and closed-round cancellation.

Four new predictions on a dedicated test account all refunded because their
window start was missing from the buffer under the existing coverage gate.
The balance stayed at 8,781 credits, ledger delta was zero, no prediction
remained pending, and idempotent retries did not debit again. This run verifies
refunds, not a new successful win/loss settlement. Prior replacement-camera
win/loss/refund validation remains documented in the camera report.

Heavy concurrent GPU load still causes processing delay and can make a round
unverifiable. The update does not establish real-time throughput on a saturated
GPU. All six active schedules remain enabled; archived 050 and historical bets
remain intact. Local app and counter are left running for inspection.

Private recordings, detector measurements, adjudication sheets, test logs and
runtime receipts are kept in the ignored `.tools/counting-pulse-20261104/`.
