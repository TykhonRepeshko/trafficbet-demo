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
3. **Detection** — YOLOX-Tiny (Megvii, Apache-2.0, ONNX Runtime CPU) on tiles around the counting line;
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
6. **Quality gates → outcome** — continuous coverage of `[start−2 s, end)`, ≥90 % of sample frames, no camera
   movement inside the window or versus the last verified frame/reference. Otherwise `invalid` → refund.
7. **Adaptive detection coverage** — by default detection runs on tiles around the line. Every 30 minutes (day and
   night differ) a low-priority probe counts the last 45 s of footage both that way and with the whole frame added
   (`wide`: two half-frame tiles on every other frame, ~2x CPU) and keeps `wide` only if it finds ≥ 25 % and ≥ 2 more
   vehicles (e.g. E6 Vingnes at night: 3 → 7; E18: 11 → 12, not worth it; a dense junction: fewer). New rounds fall back to line-only while the processing pool is saturated.
   `WIDE_COVERAGE=false` disables it; evidence records the mode per round.
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
Docker Compose runs `PROCESSORS=4`, `DETECTOR_THREADS=2`, `OMP_THREAD_LIMIT=1` and `cpus: 9`: total detector, decoder
(2 threads each) and OCR threads stay below the CPU quota, which avoids CFS throttling. On an Apple M4 Docker VM a
30-second round takes 20–35 s under load (≈150–200 ms per 5 fps frame once work spills onto efficiency cores).
`dev/mock_backend.py` is a contract mock of the automation API + media gateway for local end-to-end tests.

## Known limits
Privacy-pixelated vehicles are not detected (the line is placed where unmasked vehicles are tracked, often far from
the camera where vehicles are small); night/low light lowers recall. On a captured night window of E18 the tuned
settings counted 11 of ~11 crossings (the previous 5 fps / 0.45 settings: 7); clocks are read only from boxed overlays (thin unboxed text, e.g. DelDOT, is not yet reliable).
