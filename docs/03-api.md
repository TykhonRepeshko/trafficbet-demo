# API contract

Base URL: `http://localhost:4200/api`. Angular uses one origin through its native dev proxy or Docker Nginx. The direct native API listens only on `127.0.0.1:8080`; Docker does not publish its port. Design preview replaces the API in memory and does not validate this contract.

## Format and authentication

Request bodies are JSON. The parser rejects unknown fields, duplicate/case-fold-equivalent field names, trailing JSON values and nesting beyond 64 levels. Bodies are limited to 64 KiB; request duration is bounded. Browser mutations require the exact `Origin` matching `FRONTEND_ORIGIN` and `Content-Type: application/json`. CLI clients must send `Origin: http://localhost:4200` and retain the session cookie.

`trafficbet_session` is an opaque cookie with `HttpOnly`, `SameSite=Strict`, `Path=/api` and a 12-hour lifetime. Only its hash is stored in PostgreSQL. Tokens are not returned in JSON or stored in localStorage. Native HTTP uses `COOKIE_SECURE=false`; production requires HTTPS and secure cookies. Sessions rotate on login/registration, and at most five active sessions per user are retained.

Errors use `{ "error": { "code": "...", "message": "..." } }`. `401` means no valid session, `403` a role/Origin rejection, `409` a conflict and `429` a request limit. Internal database details are not returned to clients.

## Accounts

| Method and path | Action |
| --- | --- |
| `POST /auth/register` | Create a normal user/session with 10,000 virtual credits |
| `POST /auth/login` | Authenticate email/password |
| `POST /auth/logout` | Revoke the current server session |
| `GET /me` | Current user |
| `GET /me/ledger?limit=100` | Own operations, newest first; default 50, maximum 200 |

Registration body:

```json
{
  "email": "user@example.com",
  "displayName": "Demo player",
  "password": "my-unique-long-password"
}
```

Email is normalized and limited to 254 bytes. The display name must contain 2-80 Unicode code points without control characters. The password requires at least 12 Unicode code points and at most 72 UTF-8 bytes. Role and balance fields are rejected. A successful response is `201 { "user": { ... } }` plus a cookie. Account, opening ledger entry, audit and session commit atomically; the previous session is replaced. Email ownership is not verified; SMTP and recovery are not implemented.

Login accepts `{ "email": "...", "password": "..." }` and returns `{ "user": { ... } }` plus a fresh cookie. A user contains `id`, `email`, `displayName`, `role`, `balanceCredits` and `createdAt`, without password hash or session token.

Ledger entries are `{ id, betId?, marketId?, reason, deltaCredits, balanceAfter, createdAt }`. Reasons are `opening`, `stake`, `payout` and `refund`. Credits are positive; debits are negative. The server chooses the user from the session; callers cannot request another user's ledger.

## Public data

| Method and path | Result |
| --- | --- |
| `GET /health` | `{ "ok": true }` after PostgreSQL ping |
| `GET /streams` | Active cameras |
| `GET /streams/{id}` | Active camera |
| `GET /streams/{id}/markets?status=open` | Rounds for an active camera |
| `GET /streams/{id}/metrics?limit=50` | Measurements, maximum 200 |

Public responses hide upstream addresses. Supported sources expose a camera gateway path in `streamUrl`, and a gateway snapshot path in `thumbnailUrl` when configured. YouTube is an exception: only canonical `https://www.youtube.com/watch?v={11-character-ID}` is exposed. Complete URLs are admin-only. Public `sourcePageUrl`, `termsUrl` and attribution must never contain secrets.

A market includes `bettingClosesAt`, `windowStart`, `windowEnd`, status and optional `actualCount`/`voidReason`. Old accepted predictions remain visible after source archiving through user/admin history.

## Media gateway

These paths have the `/api` prefix, accept `GET`/`HEAD`, and serve only active cameras:

| Path | Format |
| --- | --- |
| `/media/streams/{id}/index.m3u8` | HLS playlist with rewritten nested links |
| `/media/streams/{id}/resource/{opaque-token}` | Short-lived nested HLS resource |
| `/media/streams/{id}/snapshot` | JPEG/PNG/WebP frame |
| `/media/streams/{id}/mjpeg` | Bounded MJPEG connection |
| `/media/streams/{id}/clip.mp4` | MP4 clip with one bounded HTTP Range |

Query parameters are rejected; there is no general URL proxy. `Cache-Control: no-store` allows reloading the same path. MP4 Range is validated against upstream `Content-Range`; invalid ranges are rejected. Limits: playlist 1 MiB, snapshot 5 MiB, segment/MP4 20 MiB, AES key 16 bytes, eight concurrent outbound requests and an eight-second upstream timeout. Opaque handles expire after ten minutes of inactivity; valid access renews the idle lifetime so continuous viewing does not stop at ten minutes. They remain scoped to source/camera and capped at 4,096 entries. MJPEG is bounded by time/body/frame count; the frontend reconnects every seven seconds.

Outbound access requires HTTPS port 443 and exact hosts in `MEDIA_ALLOWED_HOSTS`, with public validated DNS/IP, pinned connections, TLS-name checks and revalidation on each redirect (maximum three). The current hosts are `kamera.vegvesen.no`, `wzmedia.dot.ca.gov` and `cwwp2.dot.ca.gov`. A legacy TfL S3 rule additionally confines the old TfL host to `/jamcams.tfl.gov.uk/` if explicitly re-enabled. Client cookies/authorization are never forwarded upstream. See [source and timing boundaries](20-local-preparation.md).

## Predictions

`POST /bets` requires an `Idempotency-Key` of 16-128 ASCII letters/digits or `.`, `_`, `-`; a UUID is suitable.

```json
{ "marketId": 1, "side": "over", "stakeCredits": 100 }
```

`side` is `over` or `under`. Stake is an integer from 1 through 100,000. The backend checks account, balance, active continuous source type, open status, safe observation gap and entry deadline. Response: `{ "bet": { ... }, "user": { ... } }` with the updated balance.

The same user/key/body returns the existing prediction without another debit, including after cutoff, settlement or cancellation. Changed parameters with an existing key return `409`. `GET /bets/my` returns only the session user's history.

## Administrator

All `/admin/*` routes require the user's current admin role from PostgreSQL.

| Method and path | Action |
| --- | --- |
| `GET /admin/users?page=1&pageSize=25&q=` | Searchable, counted account page, without secrets |
| `GET /admin/streams` | All cameras/full upstream URLs |
| `POST /admin/streams` | Create a camera |
| `PUT /admin/streams/{id}` | Update a camera |
| `DELETE /admin/streams/{id}` | Archive without deleting history |
| `PATCH /admin/streams/{id}/restore` | Restore availability of the original camera |
| `GET /admin/markets?streamId=1&status=open` | List rounds |
| `POST /admin/markets` | Create a draft/open round |
| `PATCH /admin/markets/{id}/settle` | Confirm a count manually |
| `PATCH /admin/markets/{id}/void` | Cancel and refund pending stakes once |
| `GET /admin/bets?marketId=1` | Prediction ledger |
| `GET /admin/stake-volume` | Consistent stake totals by camera, round and outcome |
| `GET /admin/stake-volume/bets?streamId=41&marketId=41&status=pending&page=1&pageSize=25` | Administrator-only paginated member-level predictions |

The account page response is `{ "items": [...], "total": 63, "page": 1, "pageSize": 25, "totalPages": 3 }`. `q` searches literal substrings in name/email (case-insensitive according to the database collation), or an exact numeric ID. SQL wildcard characters are literal search text. Search values, limit and offset are bound PostgreSQL parameters. Page size defaults to 25 and accepts 1–200; page defaults to 1 and accepts 1–1,000,000. Search accepts at most 254 Unicode code points without controls. Duplicate directory parameters are rejected. Count and rows share a read-only snapshot; a page beyond the current result set is clamped to its last page. An empty result has page 1 and totalPages 1. Ordering is newest registration first, with ID as a deterministic tie-breaker. Requests without `page`, `pageSize` or `q` retain the legacy array contract (`limit=50`, maximum 200).

Restoration accepts an empty JSON body `{}` and requires the same administrator role and Origin protections as other mutations. It changes only availability and the update timestamp, records `stream.restored` once per restoration, and leaves the source, camera identity, rounds and balances intact. Repeating a restore on an available camera succeeds without another audit entry. Restoration does not certify source health or validate a counting interval.

Stake volume is an administrator-only, non-cacheable read: `{ "asOf": "...", "totals": { ... }, "cameras": [ ... ] }`. A single PostgreSQL statement aggregates the full prediction history independently of list pages. Amounts contain `totalBetCount`, `totalStakeCredits`, `pendingBetCount`, `pendingStakeCredits`, `pendingOverBetCount`, `pendingOverCredits`, `pendingUnderBetCount`, `pendingUnderCredits`, `settledStakeCredits` and `refundedStakeCredits`. Pending means prediction status `pending`, including expired entry deadlines and archived cameras. Settled stakes are the original stakes of `won`/`lost` predictions; refunded stakes are those of `void` predictions. These are stake volumes, not account balances, payout amounts or profit. Consequently total stake volume equals pending + settled + refunded stake volume.

Each camera has its original `streamId`, title, city and availability, the same amount fields, and a `rounds` array. This array includes every round holding pending stakes, plus rounds currently accepting predictions on available cameras. Each round includes its `marketId`, title, threshold, status, cutoff/counting window and amount fields. Historical totals include settled/voided rounds even though those rounds are omitted from the current-round array. Cameras are ordered by unsettled volume, then availability and title. No user identity or upstream camera URL is included. `asOf` is the database statement time (or server time for an empty catalog); phases in the UI are evaluated at that snapshot. The panel polls every five seconds while mounted and visible, avoids overlapping requests, cancels on navigation, and marks retained data stale on a failed refresh.

Removed sources with financial history are excluded from the working camera array and counted in `historicalTotals` (the same amount fields); their amounts remain included in `totals`. Such records cannot be edited/restored through the catalog API. Ordinary archived current/future cameras remain in the camera array and retain archive/restore behavior. User prediction and credit histories continue to reference their original source.

The individual-prediction endpoint requires `streamId`; `marketId` is optional and must belong to that camera. `status` defaults to `pending` and accepts `pending`, `won`, `lost`, `void` or `all`. Page defaults to 1 (maximum 1,000,000); size defaults to 25 (maximum 200). Duplicate, unknown, invalid or unbounded parameters return 400. A missing/removed camera or mismatched round returns 404. Every value is bound to fixed SQL. Count, matching stake sum and rows share a read-only repeatable-read snapshot. Pages beyond the current result count are clamped to the last page.

The response is `{ asOf, streamId, marketId?, status, items, total, stakeCredits, page, pageSize, totalPages }`. Each item has the prediction fields plus `streamId`, `displayName` and `email`; password hashes, session tokens and account balances are absent. `stakeCredits` sums every matching prediction, independently of pagination. Responses are non-cacheable and require an administrator role. The UI polls only the selected scope, preserves filter/page state on refresh, clears rows when changing context, cancels stale requests, pauses while hidden and stops when closed. Data retained after a failed refresh is explicitly marked stale.

Camera fields: `title`, `city`, `country`, `locationLabel`, `description`, `streamType`, `streamUrl`, `thumbnailUrl`, `sourceOwner`, `sourcePageUrl`, `termsUrl`, optional coordinates and `isActive`. Playback supports HLS, MP4, images, MJPEG and strict YouTube. RTSP and arbitrary iframe playback are not implemented. Upstreams require HTTPS without credentials; all HLS/CDN hosts must be approved. PUT should omit `id`, `createdAt` and `updatedAt`.

Market fields: `streamId`, `title`, `threshold`, `bettingClosesAt`, `windowStart`, `windowEnd`, `oddsOver`, `oddsUnder` and `status` (`draft` or `open`). Require `bettingClosesAt + 30 seconds <= windowStart < windowEnd`; open rounds must close in the future. Omitted cutoff defaults to `windowStart - 30 seconds`. New rounds require an active HLS/YouTube/MJPEG source. Odds range from 1 to 100 with at most two decimal places; threshold/count are integers from 0 through 100,000,000.

Settlement accepts the following body only at or after `windowEnd`:

```json
{
  "actualCount": 47,
  "verification": {
    "captureTimeVerified": true,
    "coverageVerified": true,
    "framingVerified": true,
    "evidenceNote": "Source clock and full interval reviewed; the defined northbound crossing line remained visible."
  }
}
```

All three confirmations must be true. The trimmed note requires 20–2,000 Unicode code points without control characters. Missing/false confirmations are rejected by both the API and store. Confirmation records the operator's review, not an automatic evidence guarantee. If pan/tilt/zoom changes or hides the counting zone during the interval, void/refund the round instead.

For versioned rounds, the latest verified round review must also identify retained video evidence matching the exact published source and counting rule. Both review and settlement check full decoded coverage, trusted capture UTC covering the entire round, framing status and actual MP4 SHA-256. Relative playback/receipt time cannot pass the UTC gate. Earlier unversioned accepted terms preserve their original manual path.

Settlement atomically fixes outcome, payouts, ledger, manual measurement and the actor's audit event containing the verification note and policy version. Repeated settlement is rejected. Payout includes stake, uses integer arithmetic with half rounded up, and is capped at 10,000,000 credits. Identical manual counts may share one camera/interval metric; a conflicting count rolls back settlement.

Cancellation accepts `{ "reason": "Camera evidence is incomplete" }`, requiring 5-500 Unicode code points without controls. Open/draft rounds become `void`; pending bets become `void`, with original stake refunds, ledger entries and actor audit in one transaction. The Market response includes `voidReason`. Identical retries succeed without another refund; a changed reason or settled market conflicts. This operation preserves original deadlines/history. Draft publication and corrections to settled outcomes are not implemented.

## Automatic round schedules

`GET /api/admin/round-schedules` returns `{ asOf, schedules }`. Each item includes `streamId`, `streamTitle`, `isActive`, `supported`, the configuration below, `nextRunAt`, `lastCheckedAt`, `lastMarketId` and `awaitingVerification`. New cameras have disabled defaults; withdrawn historical sources are excluded.

`PUT /api/admin/round-schedules/{streamId}` replaces the editable settings:

```json
{
  "enabled": true,
  "countingRule": "Vehicle centers crossing the mid-frame line · both directions",
  "threshold": 3,
  "oddsOver": 1.9,
  "oddsUnder": 1.9,
  "entrySeconds": 30,
  "leadSeconds": 120,
  "countingSeconds": 30
}
```

Entry and counting durations are integer seconds from 30 to 3600; the safety gap remains 30–3600 seconds. Migration 014 converts existing saved minute values without changing their duration or published markets.

Returns `{ "saved": true }`. Both routes require an administrator session and return `Cache-Control: no-store`; PUT also requires the configured frontend Origin and JSON. Invalid fields return 400, enabling archived/unsupported sources returns 409, and missing/retired sources return 404. The worker publishes eligible rounds within ten seconds. Settings affect future rounds only; disabling preserves existing predictions. The scheduler does not settle or refund bets. See [current preparation](20-local-preparation.md) for timing bounds and concurrency behavior.

## Internal AI API

```text
POST /api/internal/streams/{id}/metrics
Content-Type: application/json
X-Worker-Token: <WORKER_TOKEN from the worker's secret environment>
```

Body: `{ "vehicleCount": 47, "intervalStart": "2026-10-17T12:00:00Z", "intervalEnd": "2026-10-17T12:10:00Z" }`. A valid worker token is required, browser Origin is rejected, and the interval must have ended. In Docker a worker calls `http://backend:8080`; Nginx blocks the public internal route.

The same camera/exact AI interval/count returns one measurement; a different count conflicts. The server assigns source `ai`. Saving a metric does not settle predictions or prove quality. The worker/model/quality pipeline is not implemented.

## Retained video and annotation

Paused as of 25 October 2026. `VIDEO_EVIDENCE_ENABLED` defaults to false: the video-evidence routes below return `503 video_evidence_disabled` after normal administrator authentication, and the capture worker performs no work. The admin video/annotation workspace is removed at this stage. Migration 015 preserves finalized records and records storage retirement separately; retired footage is excluded from reads, annotations and UTC settlement evidence even if capture is later re-enabled. The contracts below describe the dormant module, not currently available recordings.

All routes below require an administrator session and return private, non-cacheable responses. POST additionally requires the configured frontend Origin and strict JSON. No source URL, credentials or decoder command can be submitted.

| Method | Route | Operation |
| --- | --- | --- |
| GET | `/api/admin/video-evidence?before=<id>` | Twenty retained capture reports and cursor availability |
| POST | `/api/admin/video-evidence` | Queue `{streamId, profileId, durationSeconds}`; active HLS source, matching saved profile, 30–900 seconds |
| GET | `/api/admin/video-evidence/{id}` | Frozen rules, status, hashes and decoded quality report |
| GET | `/api/admin/video-evidence/{id}/clip.mp4` | Private playable clip with byte Range support; ready evidence only |
| POST | `/api/admin/video-evidence/{id}/annotation` | Save `{split, condition, timingEvidence, note, crossings, provenance?, startOffsetMs?, endOffsetMs?}` |

Annotation bounds select `[startOffsetMs,endOffsetMs)` within the parent clip; omitted end means its full duration. Events use interval-relative whole milliseconds. Each event contains `track`, `offsetMs`, `direction`, `class` and `uncertain`. The server fills the immutable evidence/profile/hash/duration and leaves capture UTC absent when untrusted. A capture-bound request cannot override those fields. At least one second must be selected. Accepted offline annotations require another operator, full decoded relative coverage, intact retained content and no unresolved uncertain events. Acceptance does not certify UTC.

Whole parent clips and clips sharing source segment SHA-256 values remain in one dataset split. Split assignment is serialized to prevent concurrent tuning/test claims. Re-encoded duplicate detection is not promised. See the [retained-video status](20-local-preparation.md) for storage, bounds, timing and actual annotation results.

Public camera responses may include `countingGuide`: a source-matched line definition, profile/version, approval flag and reference dimensions. Private operator notes, reference image bytes and approval actors are excluded. The selected approved profile takes precedence over newer drafts. Draft guides do not change published round snapshots.
