# Automated local game test

Run from the project directory in PowerShell:

```powershell
npm run test:soak
```

Two independent Chrome browser sessions sign in as Elizabeth and Rita and play
real dictionary words through the game UI. Normal scoring animations run between
turns. The deterministic test opponent builds a progressively fuller board, uses
blank tiles, and passes if its limited search cannot find a move. It is not an
exhaustive legal-move solver. The test stops when the game ends or after 60 turns.

To watch the browsers, or change the run length:

```powershell
$env:SOAK_HEADED = 'true'
$env:SOAK_TURNS = '100'
npm run test:soak
```

Optional Chrome CPU throttling exercises a slower device's main thread:

```powershell
$env:SOAK_CPU_RATE = '4'
npm run test:soak
```

These environment variables persist in the current terminal. Remove them with
`Remove-Item Env:SOAK_HEADED, Env:SOAK_TURNS, Env:SOAK_CPU_RATE -ErrorAction SilentlyContinue`
to restore defaults.

## Measurements and results

Each turn logs `SOAK` followed by JSON, with the player, words, revision, tile
count, submission timestamp, callable response timestamp and opponent board
arrival timestamp. `moveTimestampToBoardMs` uses the backend's move timestamp,
which precedes transaction commit; it includes that small transaction tail.
The arrival probe observes committed board DOM updates, not internal SDK receipt
or physical display paint. Receiving a move before the sender's callable response
is normal.

A move taking over eight seconds from its server move timestamp to the opponent's
board fails the test after collecting the run. Missing updates or failed commands
also fail. Browser exceptions, failed requests, both final screenshots and
`soak-results.json` are saved in the test's directory under `test-results/ui/`.
Playwright retains a trace on failure. Open the report with:

```powershell
npx playwright show-report playwright-report/ui
```

The run clears and recreates **only** `demo-tea-and-tiles-ui-tests`, using app port
5183 and emulator ports 9199/8180/5101. It refuses other emulator addresses. It
does not touch the normal local game or the published Firebase project, and does
not generate cloud billing traffic.

## What a passing run means

This can expose client/game state bugs that accumulate through normal turns. It
cannot rule out the intermittent live iPad delivery problem. Chrome's touch
emulation and CPU throttling do not reproduce WebKit, an older iPad's hardware,
or the real network and Firestore service. Emulator transport settings also differ
from the Apple cloud long-poll settings. A faithful follow-up needs an isolated
cloud test game observed on actual Safari/iPad, with the existing delay logging.

The local bot uses tap placement. This run does not measure finger-to-drag latency;
the crowded-board drag debug scenario remains the relevant manual performance test.

## Isolated real-Firebase run

The cloud runner is separate from the emulator suite. It is restricted to
`tea-and-tiles-test` (project number `905106894114`) and its registered Web app.
It rejects production IDs, mismatched app/configuration and emulator environment
variables. It never clears collections or imports development data.

By default, the cloud frontend uses the released **1.6.1 / d71f386**
source, extracted into ignored `.tools/cloud-test-release/`, against the baseline
test deployment. Workspace changes are not part of that snapshot. Candidate
testing requires the explicit preparation and matching test deployment below.
The frontend is a production build served locally on port **5185**; its Auth,
Firestore and Functions calls use the real test project in London. No GitHub Pages
changes or production deployments are required.

App Check remains enforced on Functions and Firestore. Automated browsers inject
an official Firebase App Check debug token before loading the unchanged app. The
token is registered only in the test project and saved in ignored
`.tools/cloud-test-appcheck.json`. Keep that file and browser traces private.
No service-account key is downloaded or stored: the test administrator uses the
existing Firebase CLI login in memory. Browser players use ordinary anonymous
authentication and one-time test invitations, not administrator credentials.

After initial preparation and backend deployment, run:

```powershell
npm run test:soak:cloud
```

### Testing the current candidate

Use a separate terminal without emulator environment variables. These commands
snapshot the current allowlisted sources, build that exact snapshot's Functions
and dictionary, and deploy only its Functions, Firestore rules and indexes to
**tea-and-tiles-test**. The deploy helper rejects other projects and uses an
explicit target rather than Firebase CLI's selected project.

```powershell
$env:TEA_CLOUD_TEST_SOURCE = 'candidate'
node scripts/prepare-cloud-test.mjs --source-only
# If the test project's private App Check token has not been prepared:
node scripts/prepare-cloud-test.mjs
node scripts/deploy-cloud-test-candidate.mjs
npm run test:soak:cloud
```

Preparation stores the source snapshot in ignored `.tools/cloud-test-candidate/`
with a content hash. An existing snapshot with different contents is rejected;
preserve or remove that owned snapshot before preparing another candidate.
`--source-only` performs no cloud operations. The deployment command above does
perform a real, billable test-project deployment; merely preparing a candidate
does not deploy it.

Only a successful deploy writes complete ignored
`.tools/cloud-test-deployment.json` evidence containing the exact source revision,
test-project identity, and applied Functions/rules/indexes. Starting another deploy
invalidates prior evidence first, and a failed deployment leaves failed evidence.
Candidate soak, frontend startup and direct test entry all check the snapshot and
matching evidence locally before token exchange, browser startup or fixture writes.
Missing, partial, wrong-project or stale evidence stops the run. This records the
guarded helper's successful deployment; it cannot detect later manual cloud changes.

To return the runner to baseline source selection:

```powershell
Remove-Item Env:TEA_CLOUD_TEST_SOURCE -ErrorAction SilentlyContinue
```

That only changes source selection; it does not restore a baseline backend after
a candidate deployment. Restore the separately managed baseline deployment before
using baseline mode to compare results.

`SOAK_TURNS`, `SOAK_HEADED` and `SOAK_CPU_RATE` also apply to cloud runs. The default
is 60 turns, the maximum is 100, and the overall runner is limited to 32 minutes.
Token exchange is checked before browser startup. A fresh marked test game is
created per run; old test games remain available for inspection. An exclusive
table lease prevents simultaneous runs, and an unmarked existing table causes
the test to stop rather than overwrite it. New runs revoke prior test-seat
sessions. These restrictions apply only to the dedicated test project.

Cloud runs generate actual billable operations. Besides normal gameplay, the test
administrator reads the public game, both racks and bag to choose legal moves,
then verifies the saved revision. These extra verification reads are test overhead
and are not representative of normal player traffic. Foreground presence and the
existing diagnostic clock calibration also run normally.

Results are under `test-results/cloud-soak/`. Open the report with:

```powershell
npx playwright show-report playwright-report/cloud-soak
```

The same scenario powers both modes. Cloud timing adds local-clock measurements
`submitToBoardMs` and `acknowledgementToBoardMs`. A board update can arrive before
the callable response, producing a negative acknowledgement-to-board time.
Server-move-to-board timing is calibrated from the application's existing clock
replies, with uncertainty saved alongside each sample; it is null until a clock
sample is available. Delays over eight seconds beyond that uncertainty, or over
eight seconds after acknowledgement, fail the run and preserve its trace.

Chrome initially keeps its normal cloud transport settings. This is a cloud
delivery test, not a reproduction of iPad/WebKit networking. Fresh contexts also
do not reproduce a long-lived installed iPad app or background/resume behavior.

The first completed cloud run passed 60 turns, reaching 95 board tiles: median
Play-to-opponent update 487 ms, p95 675 ms, maximum 762 ms. No long stall was
reproduced. The run stopped at its turn cap rather than a natural game ending.
Test-project warning logs are available in
[Logs Explorer](https://console.cloud.google.com/logs/query?project=tea-and-tiles-test)
with the filter `jsonPayload.event="move-delay"`.
