# Local Docker verification and transfer rehearsal

The original 20 October 2026 results are retained below; see the [24 October checkpoint](#updated-checkpoint-24-october-2026) for current builds, test totals and image findings. Docker Desktop is installed in the current user's `AppData/Local/Programs/DockerDesktop` directory. Starting the installed application made its Linux engine available, version 29.8.2. This work does not change the selected native application or expose it publicly.

## Images and permissions

The stack remains separate Go API, Angular/Nginx and PostgreSQL 16 services. The API image also contains a bounded local-file decoder; it does not contain an AI model or Python business service.

Docker startup first runs the short-lived `/app/migrate` command using the database owner credentials. It applies the immutable migrations and prepares an independent `trafficbet_runtime` login. The HTTP API receives only that runtime login and sets `RUN_DATABASE_MIGRATIONS=false`. Startup checks the expected migration set and refuses an elevated role, role memberships, object/database ownership, schema/database creation, temporary-table rights and migration writes. Runtime grants allow the application's table operations and sequence use; deletion is limited to sessions and expiring transport summaries. Immutable histories have no UPDATE/DELETE grant, while finalized video records also retain their state-transition trigger. The API has no table-alteration or trigger-management rights.

`setup.ps1` adds a newly generated `POSTGRES_RUNTIME_PASSWORD` if an older local environment lacks it. It preserves all existing database/account/worker secrets. Native operation retains its existing local migration behavior; it has not been silently switched to another database or login. Docker role separation does not imply that the native local database owner has become restricted.

API and Nginx run as unprivileged users, with capabilities dropped, no new privileges and read-only root filesystems. The API's separate `/app/evidence` volume is writable by UID 65532. Normal Docker PostgreSQL has no published host port; Nginx binds only `127.0.0.1:4200`. The transfer rehearsal temporarily uses its own loopback ports 55434 and 4202.

### Decoder build

The first packaged FFmpeg build pulled in broad unused codecs and their dependencies. The final runtime instead builds **FFmpeg 9.0.2** from the official release source, verifies the release signature against the pinned official RSA fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`, and retains the source hash, exact configuration and LGPL licence in the image. The build enables H.264 decoding, MPEG-TS/MOV inputs, MP4 copy/raw-video outputs and the required sampling filters. Only file and pipe protocols are compiled in; Go continues to own source downloading and authorization. The musl build explicitly reserves a 2 MiB thread stack, which is required by the controlled MPEG-TS remux regression.

The disposable test stage uses a full FFmpeg only to generate synthetic H.264 fixtures. `VIDEO_DECODER_TEST_PATH` points at the exact minimal production decoder; `VIDEO_FIXTURE_GENERATOR_PATH` selects the fixture generator. Contiguous B-frame footage, missing sequences, discontinuities and modified bytes passed real codec checks. Synthetic fixtures are software tests, not manually labelled traffic evidence.

Sources: [FFmpeg release verification](https://ffmpeg.org/download.html), [Alpine supported branches](https://alpinelinux.org/releases/), [PostgreSQL grants](https://www.postgresql.org/docs/16/sql-grant.html), [Compose dependency ordering](https://docs.docker.com/compose/how-tos/startup-order/).

## Repeatable checks

Run in PowerShell 7 with Docker's Linux engine available:

```powershell
.\scripts\smoke-docker.ps1
.\scripts\verify-docker-transfer.ps1
```

The full-stack smoke project starts on `127.0.0.1:4201` with generated temporary secrets and an ephemeral database. It checks real PostgreSQL privilege denials, the decoder/filesystem boundary, production proxy/assets/CSP, role/session privacy, registration, account isolation, prediction debits/idempotency, cancellation refunds, the ledger and login persistence. It refuses pre-existing project resources and removes only containers/networks labelled for the run it created. `-NoBuild` explicitly uses previously built images and does not verify current sources.

The transfer script creates a repeatable-read native archive using the existing Go `db-tool`, or accepts an explicit trusted archive with its integrity manifest. It restores only into a new `trafficbet_migration_<suffix>` database in a newly named Docker project and refuses an existing destination. The entire restored database is checked against the consistent snapshot before application startup. Account, password/role/balance, bet and ledger fingerprints are checked again after app startup and after recreating PostgreSQL against the same separately named volume.

For video evidence, the script refuses snapshots containing queued/capturing/processing jobs. It copies only finalized snapshot-referenced segment/clip files into an archive-linked private bundle, verifies their hashes and bounds, refuses symlinks and verifies the copied bytes in the new Docker evidence volume. These files are private data, just like the database archive. Retain the archive, JSON proof and evidence bundle together. An empty evidence volume cannot restore a database that references retained footage.

The script checks that the native application remains healthy. Cleanup verifies run ownership for containers, networks and volumes before removing that disposable project. It never deletes the normal native database, the normal application's Docker volumes or the private source archive/bundle.

## Results and limits

The final Linux Go suite passed **100 top-level tests**, including **44 PostgreSQL integration tests** and all four real codec subcases using the exact minimal production decoder. The updated production smoke passed **94 HTTP/behavior assertions**, including actual restricted-role denials and the decoder directory check. The separate runtime-role PostgreSQL case covered rejected CREATE/TEMP/ALTER, migration/history writes and successful transactional account/ledger creation.

After the last clip-integrity and failed/interrupted storage-reservation fixes, a focused Linux rerun passed **17 top-level retained-video/evidence tests** and rebuilt the production API image. This includes rejected corrupted playback, actual decoder cases, shared-segment split claims, capture-UTC settlement binding and the intermediate/final-file symlink fixtures. Linux created the symlinks and exercised their denials; those filesystem fixtures were unavailable in the native Windows checks. These results remain separate from browser-rendered testing.

The final complete rehearsal passed **1,326 assertions** against the consistent snapshot taken at **19:45:43 UTC on 20 October**, after all four retained capture jobs finished. All **20 database tables** matched with zero ledger discrepancies. The private bundle contained **99 retained files** (95 MPEG-TS segments and 4 MP4 clips), totalling **90,838,001 bytes**. Source, bundle and Docker hashes matched. User/password/role/balance, bet and ledger fingerprints matched before and after application startup and PostgreSQL container recreation against the same new volume. Evidence bytes also remained unchanged. The native application remained healthy and selected; run-owned containers, networks and data volumes were removed. The private report is `.tools/docker-transfer-latest.json`, with `cleanupVerified=true`.

This is a point-in-time transfer proof covering all four capture records at the final preparation checkpoint. It preserves each retained clip's original quality flags, including incomplete/uncertain footage; it does not certify its capture UTC or counting suitability. Future capture jobs or other writes need a new final archive/bundle for an eventual cutover. Earlier 19-table restoration checks predate migration 013 and are not substituted for this retained-video test.

Fresh Docker Scout runtime reports:

| Image | Result | Scope |
| --- | --- | --- |
| Angular/Nginx | 0 reported findings | Built production image, 26 indexed packages. |
| Go API/minimal decoder | 1 reported finding | 29 indexed packages; existing unused OpenPGP module advisory GO-2026-5932. The application uses bcrypt. The compiled FFmpeg source/configuration is separately verified; package scanning does not prove absence of decoder bugs. |
| Patched PostgreSQL 16 | 71 reported findings | 60 inherited Go/gosu inventory entries; the final helper is the 14,152-byte C `su-exec`, verified byte-identical. The loaded libxml2 retains 11 findings: 1 high, 5 medium, 5 low, with no fixed stable-package version reported. A fresh base pull and uncached stable security upgrade did not remove these findings. |

PostgreSQL still loads libxml2. Application queries do not expose arbitrary SQL/XML execution, but the dependency remains present. The old helper's retained layers/SBOM are also preserved and reported. These are not described as a clean security scan. Do not replace supported packages with unrelated edge packages or delete official database libraries to suppress a scanner count.

Docker caches/images may remain after a run; temporary data volumes do not. No public HTTPS deployment, image publication, native-to-Docker cutover, browser-rendered walkthrough or production viewer-capacity claim is made. Before an eventual cutover, stop mutations, take a final consistent snapshot plus finalized evidence bundle, restore into new storage, repeat all proof checks and choose the destination explicitly. Preserve native storage as the rollback source; reverting application code must respect applied schema compatibility and later accepted data. Never delete a database volume to update the app.

## Updated checkpoint: 24 October 2026

Docker Desktop Linux engine 29.8.2 was started for a fresh isolated test run. The regular application remains native. Updated builds use Go 1.26.10, Angular 21.2.25 and CLI/build tooling 21.2.28. Linux Go/PostgreSQL/decoder tests pass, and the revised production-proxy smoke passes **100 HTTP/behavior assertions** with all six camera sources and a controlled credit-test deadline. Smoke and restore configurations now allow only the three approved Statens vegvesen/Caltrans hosts. CI supplies its own disposable database password; real `.env` secrets remain excluded.

A new consistent snapshot after the six road-span profile revisions restores all **20 tables** with **zero ledger discrepancies**. The retained bundle remains **99 files / 4 MP4 clips / 90,838,001 bytes**. **1,326 assertions** pass, including account/bet/ledger fingerprints, retained-file hashes, restricted runtime startup and PostgreSQL recreation. Native storage remains selected; cleanup of the rehearsal's containers, networks and volumes is verified.

The tested smoke images are retained under the normal `trafficbet-backend`, `trafficbet-frontend`, `trafficbet-migrate` and `trafficbet-postgres` tags. Extra smoke/test/transfer image tags from this run and the four superseded untagged application images are removed. The previous `trafficbet-pre-ai-backend:verified` snapshot and existing base images remain. No global cache/volume prune is used.

Fresh Docker Scout SARIF reports for the tested runtime images:

| Runtime | Findings | Interpretation |
| --- | --- | --- |
| Angular/Nginx | 1 | CVE-2026-107891 in musl 1.2.6-r3. |
| Go API/minimal decoder | 2 | The same musl finding and the known unused OpenPGP module advisory GO-2026-5932. |
| PostgreSQL 16 | 73 | 61 inherited Go/helper inventory findings, 11 libxml2 findings and the musl finding. The replaced helper remains separate from this inventory; libxml2 is still loaded. |

The scanner lists musl 1.2.6-r6 as fixed, while a fresh supported Alpine v3.24 package-index check still offers r3. See the [official package record](https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/musl). No unavailable fixed package is claimed, and no edge-library substitution was applied. Package/SBOM reports do not prove which application paths are exploitable; inherited inventory is not silently discarded, and the loaded libraries remain findings. This checkpoint is suitable for a local portfolio demonstration, not a clean production-security sign-off.

## Storage retirement and restore: 25 October 2026

Retained-video capture/playback now defaults to disabled. The four historical capture records are preserved and linked to append-only storage-retirement records in migration 015. The runtime database role has SELECT-only access to those retirement records. Retired footage is excluded from playback, annotation, UTC settlement evidence, admission storage budgets and new transfer bundles. Disabling storage does not waive settlement checks.

The operator-requested cleanup removed eight video/bundle directories, 338 files and 307,993,780 bytes (293.73 MiB). Database archives remain private and preserved. Older archives that reference the deleted files are historical database snapshots, not complete video restores; use the new archive containing the retirement records for the current stage.

A fresh isolated Docker rehearsal restores all 21 tables with zero ledger discrepancies and passes 27 assertions, including account/bet/ledger fingerprints, restricted API startup and PostgreSQL recreation. No video bytes are copied because all four captures are explicitly retired. Native storage remains selected. Run-owned containers, networks and volumes are removed. The earlier 99-file verification remains a historical result, not a claim that those files still exist. Image security findings were not rescanned by this storage change.
