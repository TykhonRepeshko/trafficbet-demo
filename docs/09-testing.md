# Repeatable project checks

Run from the project folder in PowerShell:

```powershell
.\check.cmd
```

The launcher selects installed or bundled PowerShell 7 without changing the execution policy. The check script uses installed Go/Node/npm or the prepared portable runtimes. Use Node.js 24 LTS for Angular builds and frontend regression tests. It does not install dependencies, start or stop the application, connect to the application database, change saved settings, or contact camera providers.

Default checks run uncached Go tests (`-count=1`), `go vet`, Angular regression tests, the Angular production build, and both Compose configuration checks when a Compose CLI is available. PostgreSQL tests are explicitly skipped with their count reported. An inherited `TEST_DATABASE_URL` or `DATABASE_URL` is removed while checking, so it cannot silently select another database. Process environment changes are restored afterwards.

Frontend regression tests use Node's test runner and Angular dependency injection to exercise the actual application classes. They cover exact round deadlines, invalid timing and archived-camera restrictions, camera navigation and background refresh, expired or stale authentication responses, manual settlement evidence/framing requirements, and HLS engine selection/lifecycle/recovery. Player cases inject repeated outages, frozen media, unchanged playlists, expired handles, pause/background transitions and stale callbacks, and verify that resolution comes from decoded video metadata. Theme cases exercise system/manual preferences, storage failures, cross-tab updates, cleanup and the CSP-compatible before-paint script. Run them independently from `frontend` with `node --test src/app/tests/frontend-regressions.test.mjs src/app/tests/video-player-regressions.test.mjs src/app/tests/theme-regressions.test.mjs`. They do not use a browser renderer or replace visual interaction checks.

Additional homepage and round-entry regressions are in `homepage-regressions.test.mjs` and `round-entry-regressions.test.mjs`, and the main runner includes them. They cover exact entry cutoffs/countdowns, source ownership and availability, partial request failures, stale-request cancellation, overlapping refresh prevention, practice choices without credit requests, strict round/side URL validation, explicit submission, and bounded/cancelled focus after an asynchronously loaded round. These are dependency-injection and controlled-DOM tests, not rendered browser checks.

Include the separate design-preview build when preview sources have changed:

```powershell
.\check.cmd -Preview
```

Preview assets are written to `frontend/dist/trafficbet-preview`, preserving the production output. Neither build proves that a page looks correct or that a live player works in a browser.

## Native PostgreSQL integration tests

Automatic-round regressions are included in the main runner as `round-schedule-regressions.test.mjs`. PostgreSQL scheduler cases cover concurrent instances, persistent settings, restart/downtime recovery, later cycles with a test clock, existing manual rounds, archive/restore, rollback/retry, access control and unchanged balances. See [current preparation](20-local-preparation.md). Test clock advancement is restricted to the internal test helper and never accepted by the API.

The optional native integration check accepts only the prepared QA database `trafficbet_tests` on `127.0.0.1:55432`. It authenticates using only `POSTGRES_PASSWORD` from the ignored `.env`, verifies that the server's `data_directory` is this checkout's `.tools/pgdata-qa`, and refuses any other cluster before tests create schemas. Application PostgreSQL uses port 55433 and is never a fallback.

If the QA cluster has already been prepared, start it with:

```powershell
& .\.tools\postgresql-runtime\pgsql\bin\pg_ctl.exe -D .\.tools\pgdata-qa -l .\.tools\postgresql-qa.log -o '-h 127.0.0.1 -p 55432' -w start
.\check.cmd -IntegrationTests -Preview
& .\.tools\postgresql-runtime\pgsql\bin\pg_ctl.exe -D .\.tools\pgdata-qa -m fast -w stop
```

Do not substitute `.local-data/postgres`, a production URL or another port. Do not stop the QA cluster if another check is using it. The script does not initialize a missing cluster or create a missing database. A fresh checkout can use the isolated Docker workflow below, or have a dedicated local QA cluster prepared separately with the generated local database password.

Integration tests use the `TestPostgres` name prefix. Each test creates a uniquely named schema and removes that schema afterwards. The runner reports actual selected passes/skips and fails if an explicit integration run contains skipped tests or executes none. Failures return exit code 1; skipped categories remain visibly separate from passes.

`TestPostgresHTTPFullCreditLifecycle` exercises the actual HTTP handlers and PostgreSQL through registration, stake debit, a synthetic winning payout, a second stake, cancellation/refund, logout and a fresh login. It reconciles every ledger operation, checks single application of retries and verifies administrator access restrictions. Only its isolated fixture's timestamps are advanced to test settlement; its synthetic result is not evidence about a public camera. A separate native HTTP lifecycle check was also performed during development; deterministic fixture checks are the repeatable contract.

Administrator directory regressions walk all 63 fixture accounts across multiple pages, including entries beyond the old 50-account limit, and cover literal wildcard/apostrophe searches, SQL-like text, bounded/duplicate query parameters, page clamping and secret-free administrator-only responses. Camera restoration regressions verify archive/public hiding, role/body restrictions, availability restoration, one audit entry on retries and unchanged prediction/balance history. Frontend cases cover page/search cancellation, server-clamped pages, failed requests without stale rows, archive confirmation and authenticated restore requests.

Stake-volume PostgreSQL regressions aggregate 255 predictions across multiple cameras and rounds, covering repeat submissions, empty sources, archived and deadline-closed pending stakes, settled/voided history, lifecycle updates, total reconciliation and administrator-only secret-free snapshots. Overflow and negative-volume guards also have a unit check. `admin-volume-regressions.test.mjs` is included in the main frontend runner and covers five-second polling, non-overlap, visibility suspension/resumption, disposal, stale-data errors/recovery, stable row identities, snapshot-based phases, the authenticated read and preview aggregate integrity.

Individual-stake cases traverse 63 camera-scoped predictions across pages, verify member identity, round ownership, complete filtered totals, status changes, malformed parameters, role restrictions and page clamping after a refund. Removed-source tests verify catalog invisibility, non-restorability, retained user/credit history and separate historical volume; a new source still archives and restores normally. Frontend cases cover camera/round selection, stale private-response cancellation, page/status resets, server scope validation, polling errors/recovery, disposal, query transport and preview details.

## Isolated Docker integration tests

With Docker Desktop installed and its Linux engine ready, run:

```powershell
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f docker-compose.test.yml down
```

This uses the separate `trafficbet-tests` project, an ephemeral PostgreSQL test database, no host database ports, and no application volume. It also builds the signature-verified minimal production decoder and runs real H.264/MP4 checks using a separate synthetic fixture generator. Restricted-role regressions create and remove their own new database/login, check actual PostgreSQL permission denials and verify a transactional account/opening ledger. The regular check script validates Compose syntax only. It reports unavailable engines and unexecuted container tests explicitly; a valid configuration is not evidence that an image builds or a container starts.

## Disposable Docker full-stack smoke check

With Docker's Linux engine ready, run in PowerShell 7:

```powershell
.\scripts\smoke-docker.ps1
```

This builds the actual production frontend/API images, starts the separate `trafficbet-smoke` project on `127.0.0.1:4201`, and uses a temporary PostgreSQL filesystem in memory. Fresh passwords and a worker token exist only in the checking process and disposable containers. The script passes an empty environment file, so it does not load the application's `.env` or use its database volume. Existing smoke resources or an occupied port are refused before starting anything.

The check exercises the production nginx proxy, health, static JavaScript/CSS MIME types, security headers, registration and HttpOnly cookies, role restrictions, private account history, actual stake debits, prediction idempotency, cancellation refunds, ledger reconciliation, logout revocation and login persistence. A separate migration service prepares the schema; the HTTP API uses an independently authenticated runtime login. The script verifies rejected schema/history/migration operations and the unprivileged decoder/evidence filesystem. Cleanup removes only the isolated smoke project it created, even after a failed assertion. Image/build caches remain available. The native application on port 4200 and its saved accounts remain untouched.

This is an HTTP and container check. It does not render pages, automate a browser or verify external video playback.

For a separate consistent native-to-Docker restore and durable-volume rehearsal, run `.\scripts\verify-docker-transfer.ps1`. It refuses unfinished capture snapshots, preserves accounts/ledger proof and copies/verifies finalized retained footage into a separately named evidence volume. It does not select Docker for normal use. See [Docker verification](23-docker-verification.md) for exact scope, cleanup, image findings and rollback boundaries.

## HTTP and visual checks

The frontend regression suite also checks the video component's engine selection and lifecycle. A non-empty native `canPlayType()` result is not sufficient in Chrome: use supported `hls.js`/MSE first, and native HLS only as a fallback. Include `video-player-regressions.test.mjs` when running Node checks independently. These tests use controlled media objects; they do not establish rendered browser playback. A valid manifest, downloaded segment or successful video decode likewise does not test the browser's chosen playback engine.

For a running local stack, confirm `/api/health`, register a separate test account, check its ledger, and verify that normal users cannot call admin routes. Use temporary test data and inspect the full prediction/settlement/refund workflow in the isolated database. Confirm live HLS playlists advance and that expired or recorded media is rejected. Live source availability is external and is not part of deterministic unit tests.

Check the home, camera detail, registration, account, predictions and admin pages at desktop and mobile widths. Confirm loading/error/empty states, entry deadlines, authentication expiry and live-player interaction. Browser automation was previously blocked for this local URL; it must not be replaced by another access route to evade that restriction. Report any remaining visual checks separately from completed build and HTTP checks.

## Long live-camera observations

The long-observation probe measures sources through the running gateway; the current retained-video results are summarized in [local preparation](20-local-preparation.md). The probe polls advancing playlists, downloads and decodes new segments, retains sparse frames, and records every request error/retry. Keeping the same child-playlist handle throughout also exercises renewal beyond ten minutes. Unlike deterministic tests, this check contacts external sources and takes real wall-clock time.

Use `--snapshot-interval 60 --check-framing` for the replacement-camera method. Numerical background/gradient correlations and FFT alignment are sampled approximately every two seconds of decoded presentation time, with bounded candidate snapshots. They are QA evidence to review with the actual frames; they do not certify fixed camera hardware or replace a validated ingestion-quality detector. Keep source clocks and privacy masking intact.

Request recovery, advancing timestamps and successful decoding are separate observations. The probe's retry policy is not the browser player's retry implementation. A gap between downloaded segments does not by itself establish a visible browser freeze, and successfully downloaded segments do not prove complete coverage of the counting interval. Do not turn a check with recovered errors into a claim of uninterrupted viewing or guaranteed source uptime.

## Separate WebRTC / HLS experiment

`streaming-lab-regressions.test.mjs` is included in the main runner. It exercises direct-route administrator guards, explicit player startup, presence expiry, teardown, reference selection, preview restrictions and the narrowly scoped iframe CSP. These are controlled class/security checks, not a rendered external-player test.

The optional `scripts/check-streaming-lab.py` observes the one fixed public camera used by the lab. It is separate from the application and never accepts a source URL or camera credentials. It validates exact HTTPS hosts, pins validated public DNS answers for each connection, verifies TLS, filters private remote ICE candidates and requests a receive-only video track. Install its optional Python dependencies in the project-local `.tools/rtc-qa` directory rather than the application's runtime:

```powershell
python -m pip install --only-binary=:all: --target .tools/rtc-qa aiortc==1.15.0 av==17.1.0 numpy==2.4.6 Pillow==12.2.0
python scripts/check-streaming-lab.py --seconds 960
```

The probe prompts for `continue` after its first viewing interval. This is a deliberate viewer-presence break; never remove that prompt or count the whole observation as uninterrupted playback. Its default sixteen-minute window allows more than fifteen minutes of video when continuation is prompt. Evidence is saved under `.tools/streaming-lab` in a fresh timestamped directory, excluding public viewer tokens and session SDP. Sparse stills are inspection evidence rather than an archive recording.

Frame timing uses only fingerprints occurring exactly once in each receive path. Repeated identical images are excluded as ambiguous. The result measures relative delivery at these receivers, excluding browser rendering and normal player buffering. It does not establish absolute camera-to-screen latency. The experiment is outside prediction rounds; protocol migration is deferred. Its retained numeric observation is [streaming-lab evidence](evidence/2026-10-17-streaming-lab.json).

The HLS component watches both live-playlist advancement and playback/frame progress. Transient failures use five additional attempts with 1/2/4/8/15-second backoff, followed by a visible 60-second cooldown and another bounded cycle. A successful ten-second playback observation with fresh live-source progress restores the normal recovery budget. User pause and a hidden tab suspend automatic recovery. Camera changes/destruction cancel it. Access/security failures, recorded sources, incompatible codecs and repeated unsuccessful decoder repairs remain terminal. The manual Reconnect action remains available during cooldown. Controlled tests exercise these transitions; the external probe does not execute this component.

## Verified portfolio checkpoint: 24 October 2026

- Go 1.26.10: 206 unit/subtest passes; database-disabled skips remain explicit. The separately selected PostgreSQL suite passes 73 tests/subtests with zero skips. `go vet` passes.
- Angular 21.2.25 with CLI/build tooling 21.2.28: 135 regressions, production build and preview build pass after the dependency updates. npm audit reports zero findings; govulncheck reports zero affected application calls/imports and the known unused OpenPGP module advisory.
- Disposable Linux Go/PostgreSQL/minimal-decoder suite passes on Go 1.26.10. Full-stack Docker smoke passes 100 HTTP/behavior assertions. The account workflow now uses its own controlled source/round so it cannot race the demo's 30-second entry period. Seed checks cover all six cameras, their attribution/host configuration, reference assets and 30/120/30-second schedules.
- Fresh native-to-Docker restore passes 1,326 assertions across 20 tables and 99 retained files (4 clips, 90,838,001 bytes), including database recreation and restricted runtime startup. Native storage remains selected; run-owned containers, networks and volumes are removed.
- Six cameras are observed for 900 seconds each through the native gateway, with decoding and sparse framing checks. Five complete without request errors; Bay Bridge recovers four transient errors. No missing decoded sequences, sampled frame movement or PTS gaps above 0.5 seconds are detected.
- Six revised road-span guides are checked against current decoded frames and public API version/source binding. This does not constitute a rendered Chrome walkthrough. Browser acceptance and hosted GitHub Actions execution remain separate and unverified.

Private machine reports are retained under ignored `.tools/portfolio-review-20261024/`; they are not required runtime assets. Image scan limitations remain documented rather than counted as passing security checks.

## Retained-video pause: 25 October 2026

Go unit checks/vet, 74 PostgreSQL tests/subtests with zero skips, 136 frontend regressions and the production frontend build pass. New regressions verify that disabled capture exits without database/storage access, retired content cannot be read or annotated, retirement/capture history stays immutable, and unfinished captures cannot be retired. The versioned-review interface cannot use an old evidence ID to enable settlement while video is disabled.

Native HTTP checks confirm administrator capture/playback requests return `503 video_evidence_disabled`, unauthenticated requests remain denied, and Bay Bridge exposes source-matched draft profile 5 with curb-to-curb endpoints. User, bet, ledger and verified-metric fingerprints remain unchanged. A fresh isolated Docker restore passes 27 assertions across 21 tables with zero ledger discrepancies, zero copied video files and preserved account/bet/ledger fingerprints after database recreation. This shorter assertion count reflects the removal of per-video-file copy/hash assertions; it is not a browser walkthrough or an AI evaluation.
