# TrafficBet: project defence questions

Use these as discussion prompts. Explain the reasoning and a concrete failure case; do not present planned AI features as completed work.

1. **What problem does the project solve, and what is complete?**
   Vehicle-count predictions with virtual credits, accounts, live video, administration and an auditable ledger. The local application works; AI inference and public production deployment remain future work.

2. **Why Go, Angular and PostgreSQL?**
   Go owns HTTP and concurrent server work; Angular provides a typed component/service interface; PostgreSQL provides persistent transactions, constraints and locking. Explain why this remains a modular monolith rather than several business microservices.

3. **What happens when a user stakes 100 credits?**
   Follow [the camera page](../frontend/src/app/pages/stream-detail.component.ts), [API service](../frontend/src/app/services/api.service.ts), [Go handlers](../backend/internal/app/http.go) and [transactional store](../backend/internal/app/store.go). The server derives the user from the session, checks the round and stake, then commits the bet, debit and ledger entry together.

4. **Why do you need both transactions and idempotency?**
   Locks/transactions handle competing operations; a per-user idempotency key handles retries after an uncertain response. A second request must not spend another 100 credits for the same intent.

5. **How do settlement and cancellation affect the balance?**
   A 100-credit winner at 1.90 returns 190 including stake; a loser returns zero; cancellation refunds 100 once. Explain equality at the threshold, rounding and why concurrent cancellation/settlement cannot both apply.

6. **How is SQL injection prevented?**
   Query values use PostgreSQL placeholders such as `$1`. Explain the difference between a bound value and SQL syntax, and why validation alone is insufficient. User-supplied table/column names would need separate allowlisting.

7. **How do authentication and administrator authorization differ?**
   An opaque cookie identifies a server session; the account role loaded from PostgreSQL determines API permissions. Hiding a navigation link is not authorization. Cookie flags, Origin checks, CORS and output escaping address different threats.

8. **Why does a camera proxy need SSRF protection?**
   A general URL fetcher could reach private services. Explain exact HTTPS hosts, DNS/IP checks, pinned connections, redirects, limits and camera-scoped resource handles in [the gateway](../backend/internal/app/media.go).

9. **What does “live” prove, and what does it not prove?**
   Advancing playlists and decoded frames show transport progress. They do not establish sensor capture UTC, unchanged framing or full interval coverage. A playback buffer is different from a deliberately delayed feed.

10. **Why are entries, the safety gap and counting separate?**
    Default settings are 30 seconds of minimum entry notice / pause, a 30-second cutoff lead, and a 30-second count. Counting starts every 60 seconds; the lead runs ahead of counting. The server enforces the cutoff; changing a browser clock does not extend it. The gap alone cannot prove source fairness or stop independent access to public footage.

11. **How do the counting line and rule versions work?**
    Normalized coordinates map to the image with letterboxing respected. Published snapshots remain fixed; source changes invalidate matching geometry. Draft overlays do not silently become a round's approved rules.

12. **What is Docker doing, and where does the data live?**
    Separate frontend, API and PostgreSQL containers communicate on internal networks. Named volumes persist data. Docker runtime privileges differ from migration-owner privileges; native and Docker stores are separate. Explain why `down -v` is not a routine update command.

13. **What do your tests actually establish?**
    Unit/component tests cover logic; isolated PostgreSQL tests cover real transactions and full credit workflows; Docker smoke checks exercise the proxy/runtime boundary. Decoder/long-source checks and a browser walkthrough answer different questions. Synthetic results do not measure AI accuracy.

14. **How would AI be integrated and evaluated?**
    Decode verified footage → detect vehicles → track identities → apply the bottom-centre crossing rule → count once per track and interval → submit authenticated measurements. Start with reviewed held-out clips, count error and missed/double crossings; include night, occlusion, camera movement and missing footage. A measurement alone must not settle credits.

15. **What are the remaining risks and what was AI-assisted?**
    Discuss trusted capture time, source outages, HTTPS/email recovery, image findings, production capacity and restore procedures. Describe the assistance acknowledged in the README and explain which implementation decisions and tests you can reproduce yourself.
