# Current local preparation

Current checkpoint: 25 October 2026. Retained-video capture/playback and its admin annotation workspace are disabled. Local video files and their duplicate evidence bundles have been removed; immutable capture/annotation metadata is preserved with explicit retirement records. The footage results below are historical measurements from 20 October, not currently available files. Core stack remains Go, Angular and PostgreSQL, with password-only sign-in. There is no running detector/tracker, Python application backend or automatic settlement. Launch/account information is in the [README](../README.md).

## Counting and review boundaries

**Admin panel → Counting preparation** contains source health, immutable PNG references/rule versions, round reviews, retained-video annotations, audit and operations. Source fingerprints identify configuration, not actual camera framing or truthful capture time. Approving a profile applies only to future publications; accepted historical terms remain fixed.

Rules use a finite normalized line and the vehicle's bottom-centre anchor. For start S, end E and anchor P, signed side is `(Ex-Sx)*(Py-Sy)-(Ey-Sy)*(Px-Sx)`: A is negative, B positive. Count a track's first allowed crossing on the finite segment within `[start,end)`. Directions/classes are frozen per round. Stationary objects and touches without a side transition do not count. Trailers belong to the towing vehicle; masking, hidden crossings and uncertain class/time require review.

All six active cameras have source-matched draft profiles: version 2 for the five Norwegian cameras, revised against fresh decoded daylight references on 24 October, and version 5 for Bay Bridge, checked against a fresh decoded night frame on 25 October. Bay Bridge's line spans the motor roadway from curb to curb, including the side shoulder strips, while excluding the bicycle/pedestrian path beyond the left barrier. Fiskevollbukta, Djupdalen and Vingnes use diagonal lines to account for perspective; Fjøsangerveien, Skaret and Bay Bridge use horizontal lines at camera-specific heights. Public previews, players and fullscreen use the same saved geometry, with the existing thin, semi-transparent style. These profiles remain unapproved; road coverage alone does not establish counting accuracy or trusted capture UTC.

Camera 41's original night reference and profile 1, line `(0.04,0.65)` to `(0.96,0.65)`, are preserved with the retained footage and annotations that reference them. Later geometry does not reinterpret those records. Privacy masks obscure some vehicles and trusted capture UTC remains absent.

A versioned round can be verified and settled only against ready retained evidence matching its exact source/profile/rules, full decoded coverage, stable sampled framing plus operator review, a trusted capture anchor and coverage of the entire UTC window. MP4 integrity is rechecked. The same checks run again at settlement; checkboxes cannot bypass them. Existing unversioned accepted terms retain their original manual path. Cancellation/refunds are transactional and idempotent.

## Retained video and quality (disabled module)

`VIDEO_EVIDENCE_ENABLED` defaults to false. The API refuses capture/playback requests and the capture worker exits without acquiring a database connection or writing files. Migration 015 adds append-only retirement records; finalized capture rows and their original quality reports are unchanged. Retired material cannot be read, annotated, used for versioned settlement or copied by a new transfer rehearsal. Database archives remain, but old archives referencing the deleted footage are no longer complete video restores. A new consistent archive includes the retirement records. Any future evidence feature must cover the whole round interval and re-establish trusted timing, continuity and framing checks.

Saved matching drafts can capture 30–900 seconds through the Go HTTPS gateway. One database-locked worker serializes capture jobs. It retains numbered TS files, hashes, media sequences, receipt UTC and frozen rules, then runs bounded local-file FFmpeg/ffprobe. It validates every segment's hash and decoded frame timeline, duration/cadence, gaps, overlaps, resets and discontinuities, and creates a normalized MP4 without video re-encoding. Final MP4 frame count and hash are checked.

At most three jobs are pending. Admission reserves up to 1.5 GiB per unfinished/failed/interrupted capture inside a 6 GiB application budget, including temporary decoder files. Ready jobs use recorded retained size. Interrupted jobs retain full reservations because crash leftovers can exceed their last byte count. Final reports are immutable; the application refuses a full budget rather than deleting history. These are application limits, not a filesystem hard quota.

Private native files are in `.local-data/video-evidence/<id>/`; Docker uses `evidence_data`. MP4 Range requests require administrator authentication and verify integrity. Missing/corrupt/nonregular files and intermediate symlinks are rejected. Decoder arguments/filenames are fixed, network protocols are disabled, subprocess secrets/output/runtime are bounded. Restarted active jobs become interrupted rather than falsely complete.

The observer reports transport only. Retained decoding separately checks delivered media continuity; a 1 fps 64×36 grey sample flags repeated frames and persistent background changes. `stable_sampled` does not certify every frame or fixed camera hardware. A playable `ready` clip can have incomplete coverage. Capture diagnostics separate manifest/segment failures, capture wall duration and processing duration.

## Time and source limitations

Receipt UTC, presentation timestamps (PTS), publisher time and sensor capture UTC are distinct. On 20 October the five sampled playlists had three live segments, no end marker, no program-date-time mapping and no LL-HLS tags. Provider publication/update timestamps do not calibrate frame exposure time. Even publisher-declared program time requires validation; see [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.6) and [provider camera publication](https://www.vegvesen.no/en/fag/technology/open-data/a-selection-of-open-data/what-is-datex/publications/#webcams).

Current retained reports use `media_relative`, null `captureStart` and `captureTimeTrusted=false`. Relative clip annotations can evaluate offline counting, but cannot establish which UTC round a frame belongs to. Future time calibration must not silently reinterpret already accepted terms. Advancing HLS/visible clocks do not prove fixed framing, complete sensor coverage or trustworthy time. Source health does not automatically pause publication or settle results.

## Actual footage and annotation status

The [sanitized machine-readable report](evidence/2026-10-20-video-evidence.json) preserves numeric results without source URLs, credentials or account details:

| Capture | Retained duration | Decoded frames | Relative coverage |
| --- | ---: | ---: | --- |
| 1, initial probe | 39.680 s | 992 | Complete |
| 2, ten-minute capture | 600.157 s | 15,004 | Complete |
| 3, interrupted capture | 9.920 s | 248 | Incomplete |
| 4, five-minute retry | 300.079 s | 7,502 | Complete |

Captures 2 and 4 total 900.236 seconds / 22,506 frames, with no shared segment hashes or detected PTS gaps. Windows sleep at 19:26:26 UTC and resume at 19:33:15 UTC caused capture 3's interruption; all five observers paused. Its incomplete quality flag remains preserved. Retry 4 used temporary process-scoped idle-sleep protection, cleared afterwards without changing saved power/display/lock settings.

Three actual ten-second subintervals of capture 1 have ten provisional candidate crossings, all uncertain and labelled `assistant_assisted / needs_review`. Inspection used 2 fps contact sheets, with at least 500 ms timing uncertainty and masked class/anchors. These are real observations, not synthetic fixtures or an independently accepted benchmark. The last 9.680 seconds of capture 1 were not labelled by those intervals. Night footage alone is not representative of daylight/rain/glare.

Annotations bind to server-owned evidence/profile/hash/bounds. Subinterval offsets are relative to `[start,end)`. The same parent hash and parents sharing segment bytes cannot cross tuning/test splits, including concurrent assignments; re-encoded duplicates still require review. Independent acceptance requires a different operator, intact retained content, complete decoded relative coverage and no unresolved ambiguity. Acceptance does not authenticate UTC. No second account/assistant substitutes for a different human reviewer. Browser annotation drafts exist only in page memory.

## Recovery, verification and next prerequisites

Preserve `.env`, the database and matching retained footage privately. `scripts/database-backup.ps1` uses a consistent exported PostgreSQL snapshot and integrity manifest; its database archive does not contain video bytes. The separate transfer tool bundles finalized snapshot-referenced files, checks hashes and restores only into new isolated storage. It refuses unfinished captures and existing destinations. Exact final 20-table/99-file restoration and remaining image findings are in [Docker verification](23-docker-verification.md). Normal native storage remains selected.

The 24 October verification passes Go 1.26.10 unit tests/vet, 73 isolated PostgreSQL tests/subtests, 135 Angular regressions, production/preview builds and Compose syntax. Saved users, bets, ledger and verified metrics match their pre-change fingerprints. Linux decoder/evidence tests, 100 production Docker smoke assertions and 1,326 fresh restore assertions are described in the Docker report. All six sources were decoded for 15 minutes each; Bay Bridge recovered four transient request failures, while the other five had none. This transport observation does not test browser recovery or authenticate capture UTC. GitHub CI is configured but was not run on GitHub from this uncommitted local checkout. Rendered-browser walkthrough remains unverified; API/build/decoder checks do not replace it. See [testing](09-testing.md).

Before evaluating an AI worker: establish trusted capture-time calibration for UTC outcomes; inspect/approve usable pilot geometry; collect representative real intervals and independent human reviews (initial target 30–60); complete allowed browser verification and review remaining image findings. Domain/server/SMTP/public HTTPS are outside the local setup. MFA remains excluded. A future detector/tracker should first report observations without controlling balances or settling rounds; Go remains the authority.
