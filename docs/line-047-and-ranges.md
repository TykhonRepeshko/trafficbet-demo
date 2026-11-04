# Camera 047 screenshot alignment and wider ranges

4 November 2026. Current approved local profile: **38 / version 7**.

Camera 047's horizontal line now runs from `(0.36, 0.55)` to `(1.00, 0.55)`:
from the median across the central and right-hand carriageways, matching the
user's annotated screenshot. The road mask follows the median to include the
added lanes while excluding the opposing motorway on the left. The definition
is committed in `counter/dev/profiles/caltrans_sr57_sr22_right.json`.

A fresh continuous 30-second recording, with two seconds of pre-roll at 15 FPS,
was processed with real inference. YOLOX-S/line and YOLOX-M/full both counted
54 vehicles, with 480/480 frames, zero rejected crossings and no missing counted
highlight identities. Both passed the existing quality checks. Their measured
compute times in this local comparison were 17.760 and 11.024 seconds. This is
one replay under shared host load, without a complete independent label set;
it does not establish general throughput or per-vehicle accuracy.

The reviewed preset for the exact source and new definition hash selects
YOLOX-M/full. Only the two existing shared model types, S and M, are needed.
The schedule's initial reference was updated from 5 to the observed 54 vehicles;
subsequent verified rounds can update the reference normally. Published rounds
retain their frozen profiles and thresholds. New-profile M/full live rounds
5718 and 5724 subsequently completed verified counts of 56 and 50.

The four suggested prediction bands are slightly wider for all cameras:
`width = min(15, max(3, ceil(reference / 4)))`. At reference 80 they are
45–59, 60–74, 75–89 and 90–104; at reference 54 they are 14–27, 28–41,
42–55 and 56–69. Quiet reference 5 uses 0–2, 3–5, 6–8 and 9–11. Bands
remain finite, contiguous and within the accepted count domain. Custom ranges
remain available.

The `demo_normal_v2` pricing formula, margin and 1×–10× return limits are
unchanged. Each wider range receives its actual server quote. Accepted stakes,
bounds, odds and potential payouts are unchanged. The design preview generates
the same wider bands. A live API check on new-profile round 5706 confirmed all
four offered ranges exactly matched the corresponding range-quote responses.

Validation passed: 223 Go unit tests, Go vet, 95 isolated PostgreSQL integration
cases, 196 frontend regressions, production and preview builds, Compose syntax,
and 221 counter tests (one optional test skipped). The QA database was initially
stopped; after starting the isolated 55432 cluster, its integration suite passed.
The geometry regression now checks exclusion of opposing traffic and inclusion
of the added central lane before tracking. Hashes of all existing accepted bet
terms and historical counting snapshots matched after profile approval and the
local service updates. The native database and frontend stayed running.

The current 047 page was visually checked in the browser: live video and the
version 7 horizontal line are visible at the requested position. App and CUDA
counter are left running. Private recordings, the unannotated reference, replay
results, preservation receipts and test logs are in the ignored
`.tools/line047-20261104/` directory. Other cameras' geometry and model presets
were retained.
