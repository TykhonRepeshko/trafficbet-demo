# AI waiting and processing backpressure

The November 4 fix (`trafficbet-counter/1.4.0-exp.10`) keeps the reviewed detector presets, 15 FPS sampling, finite line rules and all coverage/clock/framing/refund checks.

## Cause and behavior

The executor accepted every published window into an unbounded queue. Under shared GPU load, several windows of the same camera competed for the detector while the scheduler continued promising two more accepting rounds. A snapshot showed 21 pending windows and incomplete analyses more than two minutes after their intervals. A short advance could also finish before its Future was registered, leaving a completed Future that blocked subsequent work for that round.

Admission is now bounded by `PROCESSORS`, with one incremental tracker job per camera. Older windows keep priority. Completed Futures are reaped on every scheduling tick, including the registration race. Best-effort progress writes use a 2-second connection / 3-second read timeout instead of blocking inference for up to 30 seconds; authoritative final results retain their retry budget.

The API stops replenishing a camera's accepting horizon while an open versioned interval is at least 30 seconds overdue. Existing rounds, terms, stakes and frozen rules remain unchanged. Once the overdue windows settle or void, publication resumes automatically. This controls load through round cadence rather than dropping analysis frames or weakening quality gates. A stopped worker therefore cannot accumulate unlimited future promises.

Six fetchers, source observations and a browser can contend for the gateway's eight slots. A `503` now gets up to two short, bounded retries of the same scoped handle. If an older segment remains unavailable, the fetcher still buffers newer segments and resets exponential backoff when it makes progress. Missing footage remains missing and its window still fails continuity/coverage checks; this only helps subsequent windows recover. A feed with no newly fetched segment for 45 seconds is marked unavailable even if its clock was readable earlier. Its open rounds use the existing cancellation/refund path, and fresh video resumes an automation pause without waiting for the next metadata refresh.

## Viewer state

A round with no analysis or progress older than 15 seconds shows **AI delayed** with elapsed time. It releases an AI-induced playback pause and does not repeatedly rewind/pause the same stale frame. Stale green highlights are hidden. Network failures retain their reconnecting state. Settled rounds without retained live progress show **Final** and the authoritative result instead of **Waiting for AI**. Capture-time synchronization remains in use for fresh progress; manual user pause is preserved.

## Verification

- 242 counter tests pass, with one optional skip: bounded admission, one camera per job, completed-Future recovery, progress timeout, gateway retries and partial-fetch recovery are covered.
- 211 frontend regressions pass, including a final result without live metadata, absent analysis and stale progress that must release playback.
- All Go tests pass against PostgreSQL in isolated test schemas. The new publication test checks repeated overdue ticks, unchanged published terms and automatic resumption after resolution.
- Production and preview Angular builds pass. Saved account identities, roles, balances, line approvals and ledger consistency were checked across the native restart.
- Live checks before the final fetcher reload completed 047 rounds 7422/7428/7434 (46/59/41), 045 rounds 7423/7429 (59/56), 048 rounds 7424/7430 (77/65), and 052 rounds 7427/7433 (47/46), with all 480 expected frames at 15 FPS. Some source outages still invalidate/refund intervals, rather than yielding invented zero counts. These are operational checks, not manual accuracy scores.
