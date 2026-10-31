# Security

The current deployment is for localhost. Virtual credits do not remove the need to protect accounts, persistent data and outbound requests. This document distinguishes implemented protections from work required before public operation.

Current image findings, migration/runtime privileges and transfer proof are recorded in [Docker verification](23-docker-verification.md). Source timing and real annotation limits are in [local preparation](20-local-preparation.md).

## Implemented controls

| Area | Controls |
| --- | --- |
| Secrets | Setup generates independent random passwords/worker token in ignored `.env`; backend secrets are not inherited by frontend/dependency scripts |
| Registration | Validated email/name/password; public requests cannot choose role/balance; user, 10,000 credits, ledger, audit and session commit atomically |
| Passwords | bcrypt; all account-creation paths require valid UTF-8, at least 12 Unicode code points, at most 72 UTF-8 bytes and a non-whitespace character; historical login verification remains compatible |
| Sessions | Random 256-bit token in HttpOnly/SameSite=Strict cookie; only hash in DB; 12-hour lifetime, rotation, cap of five sessions and server logout |
| Authorization | Current DB role on each authenticated request; own predictions/ledger only; admin user list omits hashes/tokens |
| CSRF/CORS | Exact configured Origin for browser mutations and JSON Content-Type; no wildcard credentialed CORS |
| Request limits | Login/registration limits by peer/account; Nginx limits auth/media requests |
| JSON/API | Bounded body/time; unknown fields, ambiguous duplicate names and trailing JSON rejected; generic internal errors |
| Balance | Transactions/locks, nonnegative constraint, integer payouts and bounded stake/odds/payout |
| Retry delivery | Per-user Idempotency-Key; same intent does not debit twice, changed intent conflicts |
| History | Append-only ledger/audit with UPDATE/DELETE rejection triggers; camera archiving preserves relationships |
| Rounds | Minimum 30-second cutoff lead, no entries at/after cutoff, settlement after interval end; no duplicate settlement |
| Cancellation | Open/draft rounds refund pending stakes once with a persisted reason; placement/settlement/cancellation serialize; refunds/ledger/status/audit commit together |
| Sources | Public API exposes only scoped gateway paths or strict YouTube ID; complete upstreams are admin-only |
| SSRF | Exact HTTPS host allowlist, all DNS/IP answers checked, private/loopback/link-local/special ranges blocked, pinned IP/TLS-name validation and redirect revalidation |
| Media | No arbitrary URL proxy; rewritten bounded HLS handles, constrained sizes/time/ranges/formats/concurrency; client cookies/authorization never forwarded |
| Browser | No localStorage secrets; checked media URLs; restrictive CSP; optional YouTube fixed nocookie host and sandbox iframe |
| Network | Native API/database on loopback; Docker publishes only frontend on 127.0.0.1; internal worker API blocked by Nginx and protected by a separate token |
| Containers | API/Nginx non-root, read-only filesystem, dropped capabilities, no-new-privileges and resource limits; actual isolated full-stack startup and HTTP checks passed |
| AI boundary | Worker token separated from browser sessions; identical interval retry is idempotent, conflicting result rejected; metric alone cannot settle a round |

The current `MEDIA_ALLOWED_HOSTS` value is `kamera.vegvesen.no,wzmedia.dot.ca.gov,cwwp2.dot.ca.gov`. Empty configuration disables outbound proxying. A retained legacy TfL S3 rule restricts the old TfL host to `/jamcams.tfl.gov.uk/` if explicitly enabled, so a future allowlist entry cannot expose arbitrary objects on that shared host. Public attribution fields and URLs must not contain secrets. Credentials for private cameras are not supported.

Preview has no server security boundary: its temporary role/data live in browser memory and a banner identifies the mode. Native Angular dev-server behavior also does not replace production Nginx policies.

## Exact limits

| Boundary | Limit |
| --- | --- |
| Login, 15-minute window | 10 attempts per peer/canonical email, 100 per peer; successful login clears/refunds its rate budget |
| Registration, 15-minute window | 5 attempts per peer/email, 20 per peer |
| Nginx login/registration | 5 requests/minute, burst 5 |
| Nginx media | 10 requests/second, burst 30 |
| JSON body/nesting | 64 KiB / 64 levels |
| API request context | 10 seconds |
| HTTP headers | 16 KiB; read-header timeout 5 seconds |
| HTTP read/write/idle timeout | 10 / 15 / 60 seconds |
| Stake | 1-100,000 integer credits |
| Odds | 1-100, at most two decimal places |
| Potential payout | At most 10,000,000 credits; integer calculation, half rounded up |
| Threshold/count | 0-100,000,000 integer vehicles |
| Observation lead | At least 30 seconds; seed uses two minutes |
| Cancellation reason | 5-500 Unicode code points, no controls |
| Media playlist/image/segment | 1 MiB / 5 MiB / 20 MiB |
| Media outbound concurrency/timeout | 8 requests / 8 seconds |
| Media redirects | At most 3, each revalidated |
| HLS handles | 4,096 entries, 10-minute inactivity expiry renewed only by valid scoped access, source/camera scoped |
| Approved media hosts | At most 64 exact DNS names; HTTPS port 443 only |
| AES key | Exactly 16 bytes |

API limiters deliberately ignore untrusted forwarded headers. They are local to one process. Backend peer budgets behind a reverse proxy may be shared by several users; Nginx independently applies its per-client limits. Distributed deployment needs a trusted-proxy design and shared rate limits.

## Before public deployment

**Access.** Configure HTTPS, `COOKIE_SECURE=true`, `APP_ENV=production`, exact frontend Origin and trusted proxies. Use the current password/session controls. Connect verified email and recovery according to the deployment policy. MFA is outside the agreed scope. Registration does not verify email ownership. Opening credits do not prevent mass account creation. Production configuration forbids demo seeding.

**Database privileges.** Docker now runs migrations in a separate short-lived service and gives the HTTP API an independent runtime login without superuser, ownership, DDL, temporary-table or migration-write rights. Immutable histories have restricted grants; the final-video state trigger also applies. The existing native local cluster still uses its owner login and performs local startup migrations. Append-only triggers do not protect against a database owner who can disable them. Strong audit integrity still needs protected administrative access and external export/integrity controls. See [Docker verification](23-docker-verification.md).

**Secrets and data.** `.env` is ignored by Git but is plaintext. Restrict file permissions, use managed/environment secrets and rotate the worker token. Preserve `.env` with `.local-data/postgres`; create backups and verify restoration regularly. The Docker volume is separate storage; `pg_dump`/`pg_restore` migration remains a separate procedure. Do not delete data to apply an application update.

**Reliability.** Add observability, alerts, database capacity controls, ledger/balance reconciliation and migration checks on a copy of data. Test proxy and container configuration in the actual deployment. In-memory rate limits require coordination across multiple API instances.

**Camera integrity and outcomes.** The source operator can interrupt or change a camera's view. Advancing HLS playlists and visible source clocks do not prove accurate capture timestamps, full coverage or an unchanged counting zone. The selected Norwegian views retained their background during qualification, but published fixed/static camera fields are unspecified. Privacy masking can limit count accuracy. There is no intentional video-delay buffer or authenticated sensor UTC archive. Bounded retained decoding checks delivered frame continuity and sampled freeze/view changes; it does not certify all framing or capture UTC. Versioned round review and settlement require matching intact retained evidence and trusted complete UTC coverage. Close entries before capture begins; cancel/refund unverifiable rounds. Manual settlement requires server-validated capture/coverage/framing confirmations and an evidence note recorded with its policy version in the atomic audit. Manual confirmation is not an automatic evidence guarantee. Audited cancellation exists; settled-result corrections/dispute handling remain future work.

**Supply chain.** Maintain Go/Angular/PostgreSQL/images and lockfiles; use `npm ci`, `govulncheck`, npm audit and container scanning in CI. Check all advisory results against imported code and deployment context, and update affected dependencies. Passing tests does not replace dependency review or a deployed security review.

## Initial administrator without demo seed

Local setup enables optional seed with a random admin password. Production forbids seed. The `create-admin` CLI creates a new administrator and never promotes an existing user. After building the Docker image, use PowerShell 7:

```powershell
$env:ADMIN_EMAIL = Read-Host 'Administrator email'
$env:ADMIN_PASSWORD = Read-Host -MaskInput 'Unique long password'
try {
    docker compose run --rm --entrypoint /app/create-admin -e ADMIN_EMAIL -e ADMIN_PASSWORD -e SEED_DEMO_DATA=false backend
} finally {
    Remove-Item Env:\ADMIN_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\ADMIN_EMAIL -ErrorAction SilentlyContinue
}
```

Do not put a password in `-e NAME=value`, shell history or logs. Production also requires managed secrets, HTTPS/secure cookies and separate DB roles. Use the configured migration/runtime separation for deployment; an HTTP runtime login must not receive owner privileges to create tables.

## Development verification

Historical verification on October 17, 2026 passed uncached Go unit and PostgreSQL integration tests, `go vet`, Angular component/logic regression tests, production/preview builds, current npm audit, and actual localhost health/media/auth requests. The Go vulnerability scan found no affected calls or imported packages; it still reports one advisory in an unused package of a required module. Source updates and login/logout concurrency have deterministic PostgreSQL regression coverage. The working database retained its three accounts and six migrations, with zero balance/ledger discrepancies.

The historical 20 October [Docker verification](23-docker-verification.md) records Linux Go/PostgreSQL and decoder checks, 94 production HTTP assertions, a 20-table/99-file restore and retained image findings. The updated 24 October results below supersede those test totals and scan counts. Browser visual/click checks remain separate and unverified. Local Go/PostgreSQL, Angular/build checks and the limitations of the real retained footage are summarized in [local preparation](20-local-preparation.md).

With Docker Desktop's Linux engine ready, repeat the backend suite independently:

```powershell
.\scripts\setup.ps1
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f docker-compose.test.yml down
```

Test Compose uses a separate temporary PostgreSQL in tmpfs, without host ports or the primary data volume. Never point `TEST_DATABASE_URL` at the application's working database. Repeat the production-proxy scenario with `scripts/smoke-docker.ps1`; ordinary-browser visual checks remain separate. See [Testing](09-testing.md).


## Portfolio checkpoint: 24 October 2026

The native API was rebuilt with Go 1.26.10 after the new `crypto/x509` advisory [GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809). The module minimum and Docker build stage now require that patched release. A new govulncheck run reports zero affected calls/imported packages; the unused OpenPGP module advisory remains reported.

Compatible frontend updates resolve Angular CLI/build tooling to 21.2.28, Vite to 7.3.7 and the CLI's affected transitive packages. A scoped `@angular/build` override selects Undici 7.30.1, avoiding a forced Angular major upgrade. Fresh npm audit reports zero findings; production and preview builds plus 135 frontend regressions pass.

The fresh Docker image scan is not clean: frontend has one musl finding, API has that musl finding plus unused OpenPGP inventory, and PostgreSQL has 73 findings including inherited helper inventory and the loaded XML library. Stable Alpine v3.24 currently supplies musl 1.2.6-r3; the scanner's fixed r6 package is not yet available from that repository. Do not claim the fix has been installed or switch to unrelated edge packages to suppress a finding. Exact current scope is in [Docker verification](23-docker-verification.md).

All six current cameras completed another 15-minute gateway/decoder observation. No missing decoded sequences, sampled framing changes or PTS gaps over half a second were detected. Bay Bridge had four transient request errors recovered by retries. This is transport/sampled-frame QA, not trusted capture-UTC proof or a browser acceptance test. Six corrected road-span profiles were saved as version 2 drafts without changing existing profiles, retained clips or published round snapshots.

On 25 October, retained-video capture/playback was disabled and the operator released its local storage. Finalized reports/annotations remain immutable; separate retirement records prevent deleted footage from being read, annotated or used as settlement evidence. The restricted runtime cannot insert, update or delete retirement records. A complete trusted interval is still required for versioned settlement; removing the workspace does not make checkboxes sufficient. Bay Bridge's later draft profile 5 includes the side shoulder strips from curb to curb while excluding the separated path.
