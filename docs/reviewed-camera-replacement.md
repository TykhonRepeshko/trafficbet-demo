# Reviewed camera replacement — 3 November 2026

The prepared local database now has six active Caltrans views. The previous
six cameras are temporarily archived, including the former Bay Bridge view.
Their records, source settings, schedules, counting profiles and completed
round history remain attached to their original IDs. Pending rounds were
voided through the admin API, which refunds pending stakes transactionally.

| Local ID | View | City |
| --- | --- | --- |
| 45 | SR-57 · Ball Road | Anaheim |
| 46 | I-405 · MacArthur Boulevard | Santa Ana |
| 47 | SR-57 · SR-22 | Orange |
| 48 | SR-91 · SR-55 | Anaheim |
| 49 | I-405 · Jamboree Road | Irvine |
| 50 | SR-241 · Santiago Canyon | Silverado |

Open `http://localhost:4200/`. **Cameras** is shown only in the admin desktop
and mobile navigation; regular users use the Play screen. Admins can open
`http://localhost:4200/streams` for the directory.

Automatic counting is configured for the six sources. Each has a separate
operator-approved reference, line and road polygon(s), with both directions and
all vehicle classes enabled. The local CUDA worker uses YOLOX-S at 5 sample
frames/second, without the hybrid privacy-mosaic motion mode. Automatic line
replacement is disabled to preserve this reviewed geometry. Prediction windows
last 30 seconds with a 30-second closing gap and a one-minute cadence.

Source clock crops are bound to exact source fingerprints in
`counter/tbcounter/source_clocks.py`. Unknown or changed sources use fresh clock
discovery. Clock, coverage, tracking confirmation and framing gates still apply;
a doubtful interval is refunded. These settings are for the requested local
virtual-credit test, not a measured or certified counting-accuracy claim.

## Repeat the local import

The reviewed definitions, attribution and source links are stored in
`reviewed-cameras-20261103.json`. The original bootstrap catalog is unchanged:
this is an explicit, reviewed update to an existing installation, not a startup
operation that silently replaces operator settings.

Start the prepared application, then run:

```powershell
python scripts/import-reviewed-cameras.py          # Show the plan
python scripts/import-reviewed-cameras.py --apply  # Apply via audited admin APIs
```

The script uses the existing local admin credential privately from `.env`,
matches source URLs to avoid duplicate records, refuses unexpected active
sources and refuses to overwrite modified source settings. It preserves old
schedule settings so the normal admin restore action remains available.
Snapshots and result receipts are saved under the ignored
`.tools/camera-activation-20261103/` directory. Import does not enable rounds.

## Verification

- All five sources decoded 1280×720 H.264 frames through the application's
  scoped media gateway; all five HLS sequences advanced and thumbnails loaded.
- All six archived sources returned HTTP 404 from the public media gateway.
- Old camera metadata, saved schedule settings and completed round history
  were compared before and after the update.
- Go unit tests: 216 passed; isolated PostgreSQL tests: 92 passed; Angular
  regressions: 179 passed. Go vet, production/preview builds and Compose syntax
  checks passed. The isolated container smoke suite was not rerun.
- A consistent private database backup was saved before the change under
  `.local-data/backups/`; its ledger check found no mismatches.

The source operator can interrupt a stream. The earlier 15-minute qualification
observed periodic HTTP 403 responses that required reopening the public HLS
master. Successful playback is separate from approved counting accuracy.

## Counting activation verification

The final live check completed at 21:42 Prague time on 3 November 2026.
All five cameras had accepting rounds and successful automatic counts on their
new profiles. On a separate test account, every camera completed winning and
losing predictions; uncertain and interrupted rounds refunded correctly. All
32 test bets completed (8 won, 8 lost, 16 void); no test bets remained pending.
Balance/ledger totals matched and a fresh sign-in preserved the balance.

The counter's 30 targeted tests passed, including different reference/live
resolutions, strict JSON for rejected framing evidence, source-clock isolation
and HLS master reopening after a segment failure. Five short recorded-source
replays at 5 fps detected crossings in both directions without weak crossings.
These are functional checks, not manually labelled counting-accuracy scores.
Runtime receipts are under `.tools/new-counter-20261103/` (ignored by Git).
The application and local CUDA worker remain running.

## Line review and counted-car highlighting

MacArthur now uses reviewed profile 29 (version 2), with its line and road mask
extended over the outer lanes. SR-57/SR-22 uses profile 30 (version 3), with an
upstream line so the far carriageway crosses inside the image. Published rounds
keep their frozen profiles. SR-241 uses reviewed profile 31 (version 1), with
both carriageways included and a fingerprint-bound clock crop.

The placed-prediction player receives bounded, normalized boxes for accepted
counted track IDs. Green frames follow these cars after their crossing. Their
timestamps map to the video capture clock, with short interpolation between
measured boxes. The player replays the start of the counting window and waits
when analysis is behind; stale, future and uncounted boxes are hidden. The
worker sends one box per canonical identity even after track stitching. Live
metadata does not settle a bet: the final quality-gated result still does.

Fresh source samples from all six cameras decoded successfully and their
capture clocks were readable. One-segment GPU replays observed crossings in both
directions for every view, including the revised lines, with zero rejected weak
crossings in those samples. SR-241 produced 7 crossings in approximately 7.3
seconds, compared with 16–33 for the urban sources. Its first complete live
30-second counts were 21, 23, 18, 31 and 28. These observations establish lower
traffic in the checked footage, not a fixed future traffic rate.

Full Go/Angular checks, isolated database integration, Go vet, production build
and Compose syntax passed. Targeted counter tests cover synchronized highlights,
identity deduplication and payload limits. Source interruptions and weak tracks
still cause refunds. In particular, the revised SR-57/SR-22 view had repeated
invalid full rounds during this check; successful short replay is not evidence
of reliable full-round settlement. Current live receipts are in the ignored
`.tools/line-review-20261103/` directory; rerun `.tools/final-camera-audit.py`
against this prepared local database to refresh the camera audit.

The final browser check showed three green vehicle boxes synchronized to the
SR-241 frame at 13:47:47 source time, with live AI count 3. The same round
finished with a verified count of 26 and the test range lost correctly. An
earlier UI round won at 88 vehicles; a doubtful SR-241 round refunded. All
nine newly placed test bets finished: 3 won, 3 lost and 3 void; balances matched
and survived a fresh sign-in. The browser was restored to the existing demo
player account. Per-car text labels were removed to keep small cars visible.

## Camera 047: right-hand road and public counter

At the user's request, camera 047 now uses profile 33 (version 5). The only road
polygon lies in the right-hand part of the image. The left motorway is excluded
before tracking; the line runs from normalized (0.53, 0.60) to (1.00, 0.40).
Its diagonal placement leaves time for cars entering from the right frame edge
to establish a confirmed track. The right mask includes the outer visible lanes.
A fresh 7.7-second source replay counted 13 crossings, with zero left-side tracks
and zero rejected weak crossings. This is a functional sample, not a manually
labelled accuracy measurement. The reviewed definition is saved in
`counter/dev/profiles/caltrans_sr57_sr22_right.json`. Published rounds retain
the profile that was frozen when they opened.

The read-only AI counter is now shown without a bet, both in the Play preview
and on `/streams/47` (and other supported camera pages). It observes the current
counting window independently of the future round in the prediction form. The
number and green boxes follow the displayed capture time. It keeps the frozen
line while that window is shown, moves to the next window, cancels reads when
switching cameras, and labels missing or stale analysis. It never places a bet
or changes the viewer's virtual balance. Manual user pauses remain respected.

The source still occasionally omits a segment. Such rounds remain unverified;
the public counter labels this condition and settlement retains the refund gate.
Runtime and test receipts for this update are under the ignored
`.tools/right-road-047-20261103/` directory.

The 047 timestamp crop was narrowed to (y0=0.018, y1=0.070, x0=0.870,
x1=1.000) to avoid scene content underneath the transparent/red overlay. Six
real timestamp headers are pinned in `counter/tests/fixtures/caltrans_d12_047/`.
The tested saved segments became readable with this crop; the source can still
produce unreadable intervals, which remain subject to the normal verification
gates. A frozen HTTP-200 HLS playlist now reopens its public master after three
missed target-duration intervals (at least 30 seconds), without fabricating
segments or timestamps. Final checks: 191 Angular regressions, 22 targeted
counter/clock tests and the production frontend build passed. The CUDA counter
was rebuilt and restarted after draining rounds; all saved camera schedules
were restored. No browser test placed a new stake in this update.

After deployment, the ordinary viewer account showed the v5 line on the right
road and a live count increasing from 1 to 21 without placing a prediction. The
saved browser frame at 14:27:50 camera time contains eight green tracked-car
boxes, all on the right. This is a synchronized live progress observation, not
an assertion about the final verified total. Viewer balance stayed 9,971 cr.
