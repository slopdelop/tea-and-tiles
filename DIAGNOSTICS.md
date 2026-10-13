# Temporary move-delay investigation

This is passive instrumentation, not a connection repair or a second polling channel. No player-facing controls or messages are added.

## Switch off

Set `MOVE_DIAGNOSTICS_ENABLED = false` in `shared/move-diagnostics.ts`, rebuild and publish the frontend, and redeploy `submitCommand` and `reportMoveDiagnostics`. This stops client recording, calibration, uploads and custom server acceptance logs. The code can remain dormant until it is removed.

For a backend-only emergency stop, set `TEA_MOVE_DIAGNOSTICS_ENABLED=false` in the Functions environment and redeploy those two functions. The endpoint returns `enabled: false`; existing clients stop new collection/uploads when they receive this response. Firebase's own platform request logs are independent of this switch. The optional client build override is `VITE_MOVE_DIAGNOSTICS_ENABLED=false`.

Deploy the diagnostic endpoint before publishing a client that calls it. Diagnostics are included in release 1.6.0.

## What is collected

The server emits a small structured `move-accepted` entry only after the move transaction succeeds. It includes the move ID, player seat, revision, request/commit times, transaction attempts and whether this was an idempotent retry. Logging failure cannot invalidate the move.

Each signed-in device keeps a ring of at most 60 technical events in memory. It tracks cache/server snapshots, rack arrival (no tile contents), command start/reply/error, receipt confirmation, listener lifecycle/errors, foreground/background/connection transitions, timer stalls, supported long-task observations, completed Listen/submit request durations, board-frame and scoring/turn presentation events. It does not log words, rack contents, PINs, URLs, query strings, credentials, authentication tokens, or response bodies. Reports include version/build time, browser identity, initial viewport, standalone mode and transport configuration.

The board-frame event is the second animation frame after React commits a revision. It measures an opportunity to paint; it cannot prove what the physical display/compositor showed. Completed long-poll request durations are context, not proof of a stall. Safari versions without long-task support still get coarse timer-gap evidence.

## Detection and limits

- Delivery: lower bound of estimated server acceptance-to-snapshot delay at least eight seconds, after subtracting clock uncertainty. The move must have been made during this device's current foreground/listener session. Opening or resuming an old move is not a delivery alarm.
- Display: snapshot-to-board-frame delay at least three seconds while continuously foregrounded.
- Submission: a response taking at least eight seconds, or a command still pending after ten seconds.
- A single report per move per running recorder, capped at five new reports per signed-in device/day locally and five accepted report IDs per Firebase UID/UTC day on the server. Duplicate upload IDs do not create duplicate log entries.
- Reports normally collect 3.5 seconds of following context. Backgrounding/cleanup flushes a detected delivery incident early so it is not discarded with its timer.
- Up to five incident reports are persisted locally until the server acknowledges them. Failed uploads do not pause gameplay. Retry is only on app start/resume/reconnection, no retry loop, and a one-minute in-session cooldown. Server deduplication handles a reply lost after logging.

Server time is calibrated with a dedicated authenticated callable and `performance.now()`, independent of the iPad's wall clock. The round trip supplies an uncertainty bound. An imprecise or failed first sample gets one warm follow-up. Samples refresh on foreground/BFCache resume and, while moves arrive, after 30 minutes. Samples spanning a visibility transition are discarded. There is no periodic Firebase heartbeat for diagnostics; the one-second local timer only observes event-loop stalls.

## Added traffic

A calibration is one Function invocation and three membership document reads, with no writes. Usually one is needed per opening/resume; an imprecise/failing sample may use a second. A report is one Function invocation, membership/game/budget reads, and one small diagnostic budget document write when accepted. Failed-report retry is another invocation. The budget document contains only day and report IDs, is denied to clients by existing rules, and is not a player/game document. The normal server acceptance log adds no Function invocation or Firestore operation. Static diagnostics code has no bearing on ordinary move write counts.

## Find an incident

Open Google Cloud Logs Explorer with project `tea-and-tiles`. Filter:

```text
jsonPayload.event="move-delay"
```

Copy `report.moveId`, then search that identifier across logs. Compare the `move-accepted` request-to-commit duration with the receiving report's `delayMs`, `uncertaintyMs`, cache/server events, board-frame, timer gaps and scoring start. Seats currently map `mom` to Elizabeth and `aunt` to Rita. The reporter's device identifier is a hash of its Firebase UID, not its PIN.

CLI alternative:

```powershell
npx firebase functions:log --project tea-and-tiles --only submitCommand,reportMoveDiagnostics --lines 100
```

A late snapshot with immediate board frames supports a delivery problem. A fast snapshot followed by a large timer gap/late board frame supports a main-thread/rendering problem. A slow server commit supports server processing/retry latency. These are evidence, not a guarantee that a particular WebKit/network component is at fault.

## Local verification

`tests/move-diagnostics.test.ts` simulates wrong wall clocks, conservative clock uncertainty, normal/late delivery, cache confirmation, background catch-up, rendering stalls, pending submissions, caps, shutdown and durable uploads. The backend emulator suite verifies membership, no-write clock checks, private budgets, duplicate suppression, concurrent caps, malformed inputs and remote disabling. The isolated UI test delays Elizabeth's game callback by 18 seconds while Rita submits a real move, then checks that the report reaches the real emulated endpoint with board/scoring context and without delaying Rita.
