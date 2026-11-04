# Camera monitoring and exact-round navigation

The camera directory belongs to the administrator workspace. `/streams` redirects to `/admin/cameras`; guests must sign in and members cannot open the monitor, even by entering its address directly. The individual `/streams/:id` viewing and prediction page remains available to members. Public media responses still use scoped gateway URLs; privileged operations retain their existing server authorization.

## Operator workflow

1. Open **Admin → Camera monitor** to see active cameras, entry availability, the current counting window and the next accepting round. Paused entry availability is not a claim about detector accuracy or decoded-frame health; use **Counting & source checks** for source observations.
2. On **Admin → Rounds**, search by exact round ID (with or without `#`), camera or counting-zone text. Filter by camera/status. The page starts with 40 cards, newest counting windows first; **Show 40 more rounds** expands the list.
3. Select **Camera & round #…**. `/admin/cameras/:id?round=:roundId#selected-round` shows that exact round's deadline, counting window to seconds, threshold, odds, frozen counting rules and verified result or cancellation reason. Pending rounds show available AI progress without claiming a final result.
4. **Review this round** opens its existing preparation/review panel with the camera and round preselected. **Line & source settings** selects the camera's preparation panel. Preparation section anchors preserve the selected context.

The selected round stays selected when newer rounds are published or it settles/voids. It is loaded through the administrator review endpoint rather than replaced with the next accepting round. A round belonging to a different camera is rejected. Archived cameras retain read-only history without a live player. The camera history shows its latest 30 rounds plus an older selected round; any older round remains reachable from the round search.

The player is explicitly labelled **Current live broadcast**. Retained recordings are disabled in this branch, so selecting a historical round shows its metadata/result alongside the current feed, not a replay of its interval. The overlay follows the current video; the separate selected-round panel identifies the requested round. Sign-in preserves approved internal camera/round addresses and rejects external or ambiguous return addresses.

## Member prediction summary

Play shows **Your pick**, **Odds**, **Stake**, **Potential return** and available credits before confirmation, for both member and administrator accounts. The accepted summary uses the server's accepted stake, odds and potential payout. Potential return includes the original stake. Preview rounding matches the API's whole-credit rounding: 25 cr at 1.55× returns 39 cr. Input changes alone never place a prediction.

## Validation on 4 November 2026

- 208 frontend regressions pass, including direct-navigation role guards, safe sign-in destinations, exact-round persistence, cross-camera rejection, route-request cancellation, bounded history, archived-camera history, round filters and payout rounding.
- Production and design-preview Angular builds pass.
- Local browser checks cover guest/member restrictions, the member summary and confirmation layout, administrator monitor, historical round search, round-card → camera/round → review navigation, and exact context after sign-in. Round #7008 on CAM 047 displayed its existing verified result of 45 vehicles and its 19:22:40–19:23:10 local counting window.
- These UI checks place no predictions and do not settle or cancel rounds. They do not establish counting accuracy.
