# TrafficBet automatic counter

Python worker that settles rounds without a human: it calibrates a counting line per camera,
counts vehicles crossing each round's frozen line, applies quality gates and posts the result to
the backend (`/api/internal/automation/*`, `X-Worker-Token`), which pays out or refunds.

## Pipeline
1. **Media** — polls each active HLS camera through the backend gateway (`/api/media/streams/{id}/index.m3u8`),
   keeps ~7 min of segments in memory.
2. **Capture clock** — the cameras publish no `EXT-X-PROGRAM-DATE-TIME`, so each segment is anchored to the
   timestamp the camera burns into the frame (Tesseract OCR, frame-accurate second tick, ±20 ms at 25 fps).
   The time ROI is located once per camera; isolated OCR misses are bridged by the continuous media clock and
   checked against the next OCR anchor. Cameras without a readable clock are reported unavailable (no rounds).
3. **Detection** — YOLOX-Tiny by default, or YOLOX-S/M (Megvii, Apache-2.0) with ONNX Runtime CPU/CUDA, on overlapping tiles;
   RF-DETR (Roboflow, Apache-2.0 sizes) is available via `MODEL=rfdetr-*` when built with `WITH_RFDETR=1`.
4. **Tracking & rule** — ByteTrack (Roboflow `trackers`), bottom-centre anchor, first allowed crossing per track,
   exact port of the backend's `crossingCandidate`; ballooning boxes cannot create crossings. Thresholds are tuned for
   recall at night (activation 0.3, observations from 0.2, a crossing needs two observations ≥ 0.35), and *track
   stitching* continues a vehicle whose id the tracker dropped (blur, headlight glare): a new id appearing within 0.8 s
   next to an uncrossed lost track inherits it, so fragments on both sides of the line still count once.
   A join that would credit a crossing must agree with the lost track's velocity (a stopped car cannot reappear
   beyond the line), and two tracks of one vehicle (body box + headlight-glare box: same direction, ≤ 0.35 s apart,
   one box ≥ 60 % inside the other) count once. Evidence records `stitchedTracks` and `mergedDuplicates`.
5. **Live counting** — a round's segments are fed to an incremental `RoundSession` as they arrive (identical to a
   one-pass count) and its running count, crossings and segment clock anchors are posted to
   `/rounds/{id}/progress` for the play screen; the final result is posted once the window is fully covered.
6. **Quality gates → outcome** — continuous coverage of `[start−pre-roll, end)`, ≥90 % of sample frames, no camera
   movement inside the window or versus the last verified frame/reference. Otherwise `invalid` → refund.
7. **Adaptive detection coverage** — by default detection runs on tiles around the line. Every 30 minutes (day and
   night differ) a low-priority probe counts the last 45 s of footage both that way and with the whole frame added
   (`wide`: two half-frame tiles on every other frame, ~2x CPU) and keeps `wide` only if it finds ≥ 25 % and ≥ 2 more
   vehicles (e.g. E6 Vingnes at night: 3 → 7; E18: 11 → 12, not worth it; a dense junction: fewer). New rounds fall back to line-only while the processing pool is saturated.
   `WIDE_COVERAGE=false` disables the probe. Hybrid motion always uses wide approach coverage and a 10-second pre-roll; pool saturation never silently reduces its detection area. Evidence records the mode per round.
8. **Calibration** — when a camera has no profile (or moved 3 rounds in a row): ~2 min of 2×2-tiled detection,
   line perpendicular to the dominant flow where most tracks pass; uploaded with a reference frame.
   Runs in its own low-priority thread (nice 10, half the detector threads) so it never delays rounds; retries
   back off from `CALIBRATION_SECONDS` up to 30 min when there is too little traffic.
9. **Availability** — rounds are offered only when they can be settled: a camera without a readable clock or
   without a calibrated line is reported unavailable (schedule paused, open rounds refunded) and resumed automatically.

## Run
The worker is an opt-in Compose profile. Set `AUTOMATIC_SETTLEMENT_ENABLED=true` in the private `.env` and run `docker compose --profile ai up --build -d` only for an intentional AI test. Default startup keeps automatic settlement disabled. Its quality gates and OCR clock estimates require validation; they do not certify counting accuracy or independently trusted capture UTC.

```
docker build -t trafficbet-counter counter
docker run --rm --read-only --tmpfs /tmp trafficbet-counter python -m pytest -q -p no:cacheprovider tests
docker run --rm --tmpfs /tmp trafficbet-counter python -m tbcounter.dryrun --url <upstream m3u8> --annotate --out /tmp/out
```
Env: `API_BASE` (http://backend:8080), `WORKER_TOKEN`, `MODEL` (yolox-tiny), `SAMPLE_FPS` (5), `CONF_THRESHOLD` (0.45),
`PROCESSORS` (2), `DETECTOR_THREADS` (4), `CALIBRATION_SECONDS` (120), `LOG_LEVEL`. Compose samples at 8 fps.
For the saved native Windows database, set `AUTOMATIC_SETTLEMENT_ENABLED=true` in the private `.env`, start Docker Desktop, then use `start.cmd`. The launcher starts Go/Angular/PostgreSQL natively and the counter through `docker-compose.counter-local.yml`; `stop.cmd` stops both. This mode preserves approved counting geometry with `AUTO_CALIBRATION_ENABLED=false`. Existing draft lines must first be reviewed and approved in the admin panel. Cameras without a readable capture clock are paused automatically. No database is transferred or initialized in Docker.

For NVIDIA acceleration, set `COUNTER_DEVICE=cuda` and `COUNTER_MODEL=yolox-s` in the private `.env`. The native launcher adds `docker-compose.counter-gpu.yml`, builds with `WITH_CUDA=1` and grants the container GPU access. For the full Docker stack use `docker compose -f docker-compose.yml -f docker-compose.counter-gpu.yml --profile ai up --build -d`. The CUDA image needs a compatible NVIDIA driver; an unavailable CUDA provider fails startup instead of silently using CPU. One locked inference session is shared across processing threads to bound VRAM use. Models are downloaded and SHA-256 checked at build time, never at runtime; neither footage nor accounts are uploaded to an AI service.

Counting preparation supports optional `roadRegions`: up to eight simple polygons of 3–12 normalized points. Draw them over carriageways to exclude sidewalks, medians and water. Geometry is validated by Go and Python; the frozen crossing must fall inside a region (boundaries included). Empty regions preserve the full-frame behavior of earlier rules. Regions are saved and approved as new immutable versions; existing rounds keep their accepted geometry.
PyAV frame conversion and OpenCV use one thread per operation; BLAS/OpenMP pools are bounded in the image so parallel cameras stay within the container's PID limit.
Docker Compose runs `PROCESSORS=4`, `DETECTOR_THREADS=2`, `OMP_THREAD_LIMIT=1` and `cpus: 9`: total detector, decoder
(2 threads each) and OCR threads stay below the CPU quota, which avoids CFS throttling. On an Apple M4 Docker VM a
30-second round takes 20–35 s under load (≈150–200 ms per 5 fps frame once work spills onto efficiency cores).
`dev/mock_backend.py` is a contract mock of the automation API + media gateway for local end-to-end tests.

## Known limits
`HYBRID_MOTION_ENABLED=true` enables experimental support for pixelated traffic. It adds a 10-second pre-roll, moving block-textured region candidates and measured optical-flow/foreground continuation. Coarse candidates use the `vehicle` class (no asserted subtype), require eight confident observations, and count only when the frozen rule includes all five motor-vehicle classes. The image is never unpixelated. Unexplained line motion, ambiguous associations/merges and lost near-line tracks invalidate the whole round, including a partial positive count. Without the motion check, a zero result is unverified and refunded. These heuristics are not a measured accuracy guarantee; compare complete intervals with independent manual counts before relying on a camera. Validation footage stays in ignored local tooling, not retained-video evidence or source control.

The semantic detector alone often misses privacy-pixelated vehicles; motion assistance also fails when objects merge, the image loses usable motion cues or a candidate cannot be tracked consistently. Night/low light lowers recall. A larger model or a larger raw candidate count is not proof of a complete count. Current night replays still contain incomplete positive counts and correctly remain invalid. This is an experimental counter, not an accuracy-validated automatic game result service. Production-quality use needs independent annotated intervals across lighting conditions, camera-specific acceptance metrics and, where necessary, training on privacy-blurred vehicles or a more suitable source.

Version 1.2 seeds coarse trajectories before the line, retains dark foreground instead of treating it as shadow, and prevents weak semantic proposals from suppressing coarse candidates. Foreground warnings can be reconciled against a subsequently confirmed crossing using measured boxes; a classification first appearing after the line cannot clear a missed crossing. Stitched counter IDs are carried into the completed-track set. Unresolved ambiguity still invalidates the entire interval. OCR anchor precision describes image timing only, not vehicle-count or crossing-time accuracy.

Version 1.3 separates provisional tracking warnings from final unresolved identities. Fallback motion association is not evaluated for an ID directly measured in the same frame. Independent foreground trajectories audit coherent crossings and lost approaches; overlapping boxes alone do not prove a merge. A pre-window median background suppresses afterimages, and small stationary remnants can be reconciled with a recently observed pass under bounded spatial and temporal conditions. The conservative line-band guard remains in place for fragmented objects. Weak unconfirmed crossings cannot disappear into an accepted zero. A clear single-vehicle replay completes as counted; a replay with a missed truck remains invalid. These are regression checks, not a general accuracy certification.

Version 1.3.1 refines foreground boxes using measured mosaic cells only for an already classified vehicle, so smooth headlight glare does not enlarge its body anchor. Long illuminated extensions can be linked to the same foreground identity observed around a confirmed body crossing. A classified body still approaching before the line at the end of the window does not become a counted pass merely because its headlights crossed earlier. Unclassified or lost identities remain invalid; dense and heavily pixelated night footage still needs a better validated detector.

Version 1.4.0-exp.1 carries observation provenance separately from class names: neural detector, coarse pixel motion or measured continuation. Motion confidence cannot become a neural classification vote. Fusion retains one observation per existing canonical trajectory and treats a new small pixel fragment inside one established detector body as support. Containment alone cannot exclude another occluded vehicle, so unverified fragment ownership still invalidates the interval. Independent trajectories and two neural identities are retained for auditing. No unvalidated pilot model is selected by the serving configuration.

`COUNTER_MOTION_RESOLUTION=legacy` remains the Compose default. The experimental `native` mode crops approved road regions without downscaling the motion image; all counting coordinates remain in the original frame. It is not an accuracy upgrade by itself: initial night replays regress on glare and missed bodies, so do not enable it merely to avoid refunds.

Offline tools do not contact the application or change balances:

```sh
python -m dev.replay_benchmark --cases /reports/cases.json --root /sources --output /reports/replay.json --workers 5
python -m dev.replay_benchmark --cases /reports/cases.json --root /sources --output /reports/paced.json --workers 5 --paced
python -m dev.native_dataset --annotations /pilot/annotations.json --sources /sources --output /reports/native-review --context-seconds 1 --sequence-fps 4
```

Run them in the counter image with read-only source mounts, a writable report directory and `--network none`. CUDA benchmarks also require the CUDA image and `--gpus all`; use `--device cpu` for CPU tests. The benchmark performs real inference without a prediction cache, checks one-to-one crossing times against reviewed event intervals, and measures concurrent compute. Paced replay models segment availability; it excludes network, API and initial OCR, and is not a live uptime test. The optional `--pilot-weights` flag compares a single-class ensemble; add `--pilot-only` to compare that detector alone. Both are offline comparisons, without changing the serving model.

Native dataset export decodes original segments, preserves session splits and exports adjacent frames. Scaled boxes and propagated tracklets are proposals, and every included frame requires visual review before training. It adds temporal coverage, not independent test sessions. `dev.pilot_finetune` supports explicitly partial labels: unknown negatives do not supply objectness gradients, and an uncertain empty frame cannot become background truth. Empty and positive examples use the same crop-scale augmentation; negative sampling can be balanced across cameras. Partial-label metrics report known-positive recall and false positives on complete images, with unmatched partial predictions separately unscored. They are not whole-scene precision or mAP. Training dependencies remain separate from the serving image, and better frame recall alone does not establish correct vehicle counts.


The prepared November 2026 local CUDA setup uses YOLOX-S at 15 fps. Public live
progress updates every second. Green display boxes are sampled every 0.2–0.25 seconds,
with an immediate sample for newly counted identities; payload packing protects
their first observation. The full 30-second window fits the 320-frame buffer,
with at most 640 boxes and the existing 64 KiB API limit. Only confirmed counted
identities are green. This does not certify detection of every vehicle at night.
See `docs/reviewed-camera-replacement.md` in the repository for current geometry,
source limitations and local validation receipts.


Exact-source inference overrides are supplied by `SOURCE_INFERENCE_PRESETS`
(`COUNTER_SOURCE_PRESETS` in Compose). Entries require a source fingerprint,
`model`, `coverage` and a canonical `definitionHash`. A changed frozen rule does
not inherit the override. CUDA supports at most two shared sessions. The reviewed
049 and 052 presets use baked YOLOX-M weights and full-frame context; no pilot/custom
weights are selected. See `docs/reviewed-inference-presets.json` in the repository.

To compare sampling rates on retained local recordings without predictions being
cached or account/API changes, run `python -m dev.fps_benchmark --help`. The input
profiles select explicit geometry, source fingerprints and optional per-camera
models. Accuracy metrics are emitted only for cases supplied with manual events.


The Imperial Highway replacement for camera 050 uses an exact-source sharp
greyscale timestamp reader. Blur/Otsu sometimes closes the top of a small `5`
and produces a plausible `6`; 26 retained timestamp strips cover the regression.
Only that source uses the sharp-only variant. Unknown/changed fingerprints
retain default discovery and preprocessing. A clock tick must still be observed,
and capture latency, continuity, framing and tracking gates remain unchanged.
