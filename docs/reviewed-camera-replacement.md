# Reviewed local cameras — 4 November 2026

The prepared database has six active, distinct Caltrans sources. Camera 046
(MacArthur Boulevard) is temporarily archived because the operator turned it
toward an information sign. Its records and history are preserved, together
with the previously archived cameras 38–42 and 44. Camera 050 (Santiago Canyon)
is now archived after repeated night-glare failures; replacement 052 preserves
050's 167 markets, 8 predictions and original counting profile. Open 046 rounds were voided
through the audited admin API. No accepted prediction terms were repriced.

| Local ID | View | Profile / version | Scope |
| --- | --- | --- | --- |
| 45 | SR-57 · Ball Road | 39 / 2 | Foreground carriageway, verge to median |
| 47 | SR-57 · SR-22 | 38 / 7 | Central/right carriageways beyond the median |
| 48 | SR-91 · SR-55 | 27 / 2 | Both carriageways |
| 49 | I-405 · Jamboree Road | 40 / 3 | Foreground carriageway, median to right verge |
| 51 | SR-91 · Harbor Boulevard | 35 / 1 | Main carriageways below the bridge |
| 52 | SR-57 · Imperial Highway | 41 / 2 | Left main carriageway only; separated ramp excluded |

Source metadata and attribution live in `reviewed-cameras.json`. Public camera
lists also suppress repeated source fingerprints or provider-page URLs, while
admin records retain their original IDs. The active database catalog has no
repeated source URLs or fingerprints. Regular users have no Cameras navigation
tab; public camera detail pages remain available for watching the live counter.

## Counting and display

The latest [three-camera line review](three-camera-lines.md) aligns 045, 049 and
052 with the user's screenshots. Each counts only crossings of its finite line;
road-mask entry and crossings beyond the endpoints do not count. The table above
shows the current profiles; the earlier validation records below retain the
geometry and model settings used at their respective audit times.

Camera 047 now uses the screenshot-aligned horizontal line from (0.36, 0.55)
to (1.00, 0.55), across the central/right carriageways beyond the median. Its
expanded road mask excludes the opposing left motorway. Profile 38/v7 and the
wider prediction choices are described in [the 047 follow-up](line-047-and-ranges.md).

Camera 051 excludes the crossing street above the Harbor Boulevard bridge.
Its timestamp crop is bound to its exact source fingerprint. The worker's
coverage comparison selected wider detection for this view (7 crossings versus
5 with line-only detection in its probe). Candidate SR-73 and SR-241 views were
not registered after night glare or clock failures appeared during review.

The local CUDA worker uses YOLOX-S at 15 sampled frames/second, with
six processors. Automatic calibration and hybrid motion remain disabled.
Thirty-second counting windows retain a 30-second entry safety gap and a
one-minute cadence. Upstream HLS segments and capture-clock verification still
introduce source delay; UI polling cannot remove that delay.

Public counters are visible without placing a stake. Worker progress and viewer
polling now update every second. Filled green rectangles are sampled about every
0.2–0.25 seconds, and a newly counted identity forces an immediate box even between
regular samples. Packing protects its first visible box instead of blindly
removing every other frame. Display metadata stays within 320 frames, 640 boxes
and the existing 64 KiB storage limit. Green means the confirmed vehicle crossed
the frozen line; vehicles approaching the line do not yet receive that mark.
Uncounted, stale and future boxes remain hidden. Manual pauses remain respected.

These checks establish functionality, not a manually labelled accuracy score
for every visible vehicle. Night glare and occlusion remain limitations. Capture
clock, continuous coverage, tracking and framing gates remain enabled; uncertain
rounds refund stakes rather than manufacturing a verified count. Quiet night
windows can remain unverified when independent evidence cannot support zero.

## Prediction ranges

Four finite nearby ranges now contain at most fifteen integer counts each; quiet
cameras use smaller bands. At reference 80 the choices are 45–59, 60–74, 75–89
and 90–104. Custom ranges and exact counts remain available. The versioned demo
rule `demo_normal_v2` uses a truncated discrete normal distribution, a 15% model
margin, downward rounding and a 1×–10× return cap. Local Over/Under schedules
now publish 1.70×. References continue following recent successful AI counts.

Migration 019 accepts both historical `demo_geometric_v1` predictions (their
original cap and stored payout) and new capped v2 predictions. Immutable accepted
terms and server quote checks remain in force. All 75 pre-update predictions
had identical immutable-term hashes after restart; ledger discrepancies were zero.

## Repeat the catalog import

```powershell
python scripts/import-reviewed-cameras.py          # Show the plan
python scripts/import-reviewed-cameras.py --apply  # Audited import/archive
```

Existing settings are checked before reuse. Camera availability does not approve
new geometry or enable new schedules. Reference images, reviewed profiles and
runtime receipts belong to this prepared database. Preserve `.env` together
with `.local-data`; start with `scripts/start.ps1 -Local` and stop with
`scripts/stop-local.ps1`.

## Validation and cleanup

The current checks passed: 223 Go unit tests, 95 isolated PostgreSQL
integration tests, 195 Angular regressions, Go vet, production and design
preview builds, Compose syntax, and 154 counter tests (one optional test skipped).
The legacy payout test verifies that a stored 20× v1 prediction still pays its
original return, while v2 values above 10× are rejected. Live test receipts,
per-camera results and the accounting audit are under the ignored
`.tools/camera-review-20261104/` directory.

Cleanup removed 1,530.7 MiB: the unused full PostgreSQL installation, old build
binaries, an accidental duplicate Go cache, and old camera-search media. The
active PostgreSQL runtime, saved database, private backups, models, source code
and labelled datasets were retained. The catalog was consolidated into one
current JSON file rather than retaining duplicate dated copies.


The final live test completed 12 predictions on a separate test account: four
won, four lost and four refunded; none remained pending. Balance/ledger totals
matched, and idempotent retries after settlement did not debit again. Every
counted track ID in the post-restart live audit had green display metadata;
camera 047 had zero boxes on the excluded left side. Camera 051 completed
verified live rounds, including counts 4, 6, 2 and 10; some other windows still
refunded for weak tracking. Cameras 049/050 remained problematic in night footage,
with frequent unverified zero results. These are retained as an explicit limit,
not reported as successful counting.

The browser confirmed live green boxes and a visible public count of 1 on both
047 (right-only v6 line) and 051, without placing a viewer-account stake. The
ordinary viewer balance remained 10,041 cr. A transient HLS seek now retains the
last mapped count/window until mapping returns, preventing an early final-count
reveal or a premature switch to the next round. Missing video clocks still hide
boxes; the bounded final-result timeout remains in effect.


## Final counting audit and 15 FPS deployment

The final configuration uses 15 FPS and six processors. Six simultaneous
30-second recorded windows completed in 38.901 seconds, including real decoding,
tracking and progress-payload construction. The comparison on the same footage
with the small model everywhere took 21.424 / 33.066 / 41.421 seconds at
8 / 12 / 15 FPS. These are measured throughput results on this host; initial
OCR, network delivery and startup are excluded. Source hashes and exact profiles
are retained in the ignored audit receipts. Most cases are not manually labelled,
so changes in their counts must not be described as accuracy scores.

Camera 049 now has a line crossing the road rather than following its direction,
and its mask includes both visible carriageways in Pre-position 1. On a separately
reviewed two-event night sample, cropped YOLOX-S missed both events. Full-frame
YOLOX-M at 15 FPS matched both with no extras. A small hand-reviewed sample does
not certify general accuracy. Confirmed live rounds subsequently counted 3, 1
and 4 vehicles with the larger model, profile 36/v2 and all quality gates intact.

`reviewed-inference-presets.json` contains the non-secret reviewed detector
setting. To apply it locally, set `COUNTER_SOURCE_PRESETS` to that JSON in `.env`.
It is bound to the exact source fingerprint and the canonical hash of the frozen
counting definition. Editing the source or definition invalidates the preset;
review it again before reusing the setting. CUDA allows at most two shared model
sessions. The generic model remains YOLOX-S; only 049 uses YOLOX-M/full-frame.
The larger model's actual name is recorded in each round's evidence.

The CUDA Compose override defaults to 15 FPS when `COUNTER_SAMPLE_FPS` is empty;
CPU defaults remain unchanged. Set an explicit FPS to override this choice.
The independent `dev.fps_benchmark` tool can reproduce comparisons using local
saved media; it does not contact cameras, modify accounts or settle predictions.

The visual marker is now a filled, translucent green rectangle with no outline
or rounded corners. The browser confirmed it on 049 with public live count 1,
without signing in or staking. Clock values in live metadata retain their full
precision: millisecond rounding previously could move a valid crossing onto the
exclusive end boundary and make the API reject its progress update.

The audit also closed public draft-round disclosure, rejected future crossings
beyond `processedUntil`, serialized progress writes with settlement, and prevented
recent counts under an older counting profile from setting a new profile's
reference threshold. Duplicate crossing calculations use a bounded temporal
search and a cache invalidated on observation. Design preview now implements
range-options, so its Play form can load the same narrow v2 choices.

All final checks passed: 223 Go unit tests, 95 isolated PostgreSQL integration
tests, 195 Angular tests, Go vet, both frontend builds, Compose validation and
154 counter tests (one optional test skipped). The new live stake scenario again
completed 12 predictions: 4 won, 4 lost, 4 refunded; idempotency and ledger totals
matched. At that audit, camera 050 still frequently refunded unverified night-zero
windows; the replacement described below addresses its source limitation.
Current receipts are in `.tools/project-audit-20261104/`.


## Camera 050 night replacement

This section records the original replacement with profile 37/v1. The current
052 geometry is profile 41/v2, selecting only the left main carriageway; see
[the screenshot line review](three-camera-lines.md).

Santiago Canyon produced 17 consecutive completed night windows with unverified
zero counts. A fresh 18.1-second recording still produced zero with both YOLOX-S
and YOLOX-M, under line and full-frame coverage. The source image has clipped
headlight glare and does not reliably expose vehicle bodies. Its clock remained
readable; loosening the zero/tracking gate would not establish a correct count.

The selected replacement is Caltrans SR-57 at Imperial Highway (official catalog
name `SR-57 : (81) SR-90`, Fullerton):

- Operator page: https://cwwp2.dot.ca.gov/vm/loc/d12/sr5781sr90.htm
- HLS: https://wzmedia.dot.ca.gov/D12/NB57Imperial.stream/playlist.m3u8
- Local camera 052, approved profile 37/v1; source 050 is archived, not overwritten.
- Line: (0.30, 0.70) to (1.00, 0.53), with both main carriageways in the road mask.
  The separated left ramp, triangular island and adjacent local streets are excluded.
- Offline definition: `counter/dev/profiles/caltrans_sr57_imperial.json`.
- Reviewed inference: YOLOX-M/full-frame at 15 FPS, bound to source fingerprint
  and frozen definition hash in `reviewed-inference-presets.json`.

The SR-73 Red Hill candidate was rejected after mostly empty night windows, and
SR-55 17th Street after missing/discontinuous media segments. No rejected
candidate was registered in the application.

The Imperial timestamp is small enough that blur/Otsu sometimes reads `5` as `6`.
A source-bound sharp greyscale reader anchored all 13 recorded segments directly
from OCR with consecutive media sequences and continuous capture UTC. No anchor
was inferred for that sample. Its 26 timestamp-only fixture strips, including
observed five-to-six transitions, are committed as regression coverage. Unknown
or changed fingerprints keep their existing preprocessing and discovery. No
unreadable digit is inferred; all existing clock and counting gates remain.

Three separate recorded 30-second windows counted 15, 15 and 10 vehicles with no
rejected weak crossings or missing highlight identities. The initial manual review listed 15 events (10 away, 5 approaching). That review
was incomplete: a subsequent frame-by-frame adjudication found two additional
approaching cars, for 17 actual events. The [follow-up](counting-pulse-and-recall.md)
records the correction, the conservative serving fix and its remaining miss. The other two windows are stability checks without hand labels.
This small night sample does not certify every vehicle under all conditions.

All 182 counter tests passed in the built serving image (one optional test
skipped), including 28 new timestamp regressions. The catalog import dry run
found six distinct active sources and no pending archive/refund actions. Private
recordings and runtime receipts remain in `.tools/camera050-20261104/`.

The local GPU can be shared with other workloads. Under heavy concurrent GPU
load, the first live replacement round counted 23 vehicles at 15 FPS but settled
about four minutes after its window. Higher sampling does not guarantee timely
results on a saturated host; keep that load limitation separate from accuracy.


Live validation completed 12 predictions on three replacement-camera rounds:
4 won, 4 lost and 4 refunded. The refund round failed the existing
`unreliable_tracking: unconfirmed_vehicle_crossing` gate; it was not silently
accepted as a count. Full-range and impossible-range predictions, both fixed
Over/Under sides, quote validation and idempotent retries before/after settlement
were checked. The own test account moved from 8,845 to 8,781 credits; the exact
-64-credit change matched the ledger and stored payouts. No test prediction was
left pending. Global ledger discrepancies were zero, and all original 050
markets and predictions remained present after archive. This validates payout
and refund behavior; it does not remove night tracking or shared-GPU limits.

The public 052 page was checked in the browser after reconnecting its automation
session: live video, the reviewed line and AI count history were visible without
signing in. All six current camera schedules are enabled; 050 remains archived
and its schedule disabled. That deployment identified as `1.4.0-exp.3`. The current pulse/recall follow-up
uses `1.4.0-exp.7`; see [current checks and limits](counting-pulse-and-recall.md).
