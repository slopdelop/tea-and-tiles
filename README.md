# Tea & Tiles

A private, asynchronous two-player word game for Rita and Elizabeth. React + TypeScript + Vite + Motion, with Firebase anonymous authentication, Firestore listeners and authoritative callable Functions. Source: [slopdelop/tea-and-tiles](https://github.com/slopdelop/tea-and-tiles). Website: https://slopdelop.github.io/tea-and-tiles/. Firebase backend deployment and billing settings are separate from website publishing; local testing remains independent.

Elizabeth is mom (`mom` internally), and Rita is aunt (`aunt` internally). See [Firebase and iPad setup](DEPLOYMENT.md) for cloud setup, App Check and spending safeguards.

## Run locally

Requirements: Node 22.12+ (Node 22 recommended), npm, Java 21+ for the Firestore emulator, and Chrome for browser tests. This workspace has a portable Java 21 runtime in ignored `.tools/java`; the launcher detects it automatically. On another computer install Java 21 and put `java` on PATH. No Firebase login or cloud credentials are required for emulator development.

From this directory:

```powershell
npm ci
Copy-Item .env.example .env
npm run emulators
```

Leave that terminal running. The launcher uses **demo-tea-and-tiles**, Auth 9099, Firestore 8080, Functions 5001 and emulator UI 4000. It imports/exports `.emulator-data` on graceful shutdown so development matches survive emulator restarts. Ctrl+C once and allow export to finish.

In a second terminal:

```powershell
npm run dev:prepare
npm run dev
```

For two players in the same Chrome profile, start a third terminal with `npm run dev -- --port 5174 --strictPort`. Elizabeth uses http://127.0.0.1:5173 and Rita uses http://127.0.0.1:5174; separate origins keep their identities independent. The administrator can issue each player a reusable private six-digit code and sign-in link:

```powershell
node scripts/admin.mjs issue-pin --project demo-tea-and-tiles --player Elizabeth
node scripts/admin.mjs issue-pin --project demo-tea-and-tiles --player Rita
```

Choose your name and enter its private six-digit code once on each device. Leading zeros count. The printed private link fills in the name and code; tap **Sign in** to connect. Its secret lives in the URL fragment (`#player=Elizabeth&code=…`), which the app removes from the address bar after prefilling. Keep the link as private as the code. Firebase retains the device's account across normal reloads and absences, so sign-in is not required every game. The same player can stay signed in on an iPad, iPhone and browser simultaneously. Names alone do not grant access. Codes do not expire by default; the server stores only a salted scrypt digest. Issuing a new code changes future sign-ins without disconnecting existing devices. `revoke-login --project demo-tea-and-tiles --player Elizabeth` explicitly disconnects all Elizabeth sessions and disables her sign-in secret; issue a fresh code afterward. Game tiles, scores and history are preserved.

Existing passphrases remain valid until that player's credentials are explicitly reissued. `issue-login` remains available for a stronger secret with three random familiar words and four random characters; capitalization and space/hyphen separators do not matter. Issuing an invitation or updating the website does not automatically change a reusable sign-in code or passphrase.

One-time invitations remain an alternative. `dev:prepare` prints each player's private invitation link and a short word such as `maple`. Open the invitation and tap **Join your table**, or enter the word. Unused invitations expire after 24 hours; a joined device stays signed in after expiry. Existing eight-character and 32-character invitations remain accepted until their original expiry. Redeeming a replacement invitation replaces the previous invitation-linked device; it leaves devices added through reusable sign-in connected. Preparing invitations alone changes no active binding or match. On iPads sign in inside the installed Home Screen app, because its storage may be separate from Safari.

Keep codes, links, passphrases and invitations private. Six-digit codes are easier to guess than the longer passphrase option. Reusable sign-in limits failed attempts to ten per player and per browser account in a one-hour window, with cloud App Check protection; word invitations also have shared and per-account failed-attempt limits. Exhaustion temporarily blocks new sign-ins and returns the remaining cooldown. Issuing fresh credentials resets the relevant shared limit for recovery. Current browser accounts continue working without any migration or game reset. Stable player IDs identify seats independently of display names and Firebase device UIDs; this version still supports only this two-player family table.

Reset all development users and data (local emulators only):

```powershell
npm run dev:reset
```

Optional deterministic CAT/S fixture preserving player bindings:

```powershell
node scripts/admin.mjs fixture --project demo-tea-and-tiles
node scripts/admin.mjs fixture --finish --project demo-tea-and-tiles
node scripts/admin.mjs names --project demo-tea-and-tiles --mom-name Elizabeth --aunt-name Rita
```

## Test and build

```powershell
npm test
npm run build
```

With emulators already running:

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'
$env:FIREBASE_TEST_PROJECT_ID='demo-tea-and-tiles-tests'
npm run test:backend
npm run test:e2e
```

Or stop all running emulators, then run the self-contained integration suite:

```powershell
npm run test:integration
```

**Integration tests reset their isolated `demo-tea-and-tiles-tests` project.** The E2E suite runs actual Auth, Firestore and callable Function emulators, with two independent browser contexts. It enrolls both players, plays CAT/CATS, observes live updates, reloads sessions, deliberately loses a committed command's response, retries the same ID, ends via six scoreless turns, and starts a rematch. Screenshots are saved under `test-results/`; the report is `playwright-report/index.html`. Windows defaults to installed Chrome. On Linux/CI use `npx playwright install --with-deps chromium` and `PLAYWRIGHT_BROWSER_CHANNEL=chromium`.

To check tile layout, hover, mouse dragging and simulated touch while keeping an active development match running:

```powershell
npm run test:ui
```

This suite uses a separate `demo-tea-and-tiles-ui-tests` project, Auth 9199, Firestore 8180, Functions 5101 and frontend 5183. It never imports or exports development data, and fixture writes refuse other emulator ports. It starts and stops its own emulators. Screenshots are under `test-results/ui/`.

## Game and defaults

15×15 standard premium layout, 100 English tiles (including two blanks), seven-tile racks, centre/connection/line/gap validation, main and cross-word scoring, zero-valued assigned blanks,50-point seven-tile bonus, pass, exchange when at least seven tiles remain in the bag, rack deductions at classic endings, and opponent-rack transfer when a player goes out. **Six consecutive scoreless turns total** end a stalemate in every mode: passes, exchanges and zero-point words count, while a scoring word resets the streak. Six alternating passes mean three per player; two each would be four and do not end this game's match. A valid play of a player's last tile ends immediately **only when the bag is empty**; otherwise normal replacement tiles are drawn and play continues. The same rack-out and scoreless endings apply before other modes' cutoffs. We use the scoreless rule for blocked boards rather than exhaustively searching both private hands and the shared dictionary to prove no legal moves remain. Standard endings record their reason and server timestamp, explain the finish on screen, and warn before a sixth scoreless pass. Classic has no clock; Timed game uses an agreed shared countdown. Elizabeth starts every rematch in v1. The server uses cryptographic randomness for initial shuffle and exchange returns, and draws from its private bag. Exchange draws replacements before returning selected tiles.

Tap a rack tile, then a square, or drag it with a mouse or finger. Draft tiles may go on any empty square in any order, including temporary gaps or separate parts of the board. Reposition them freely without recalling the entire hand. Tentative tiles receive a red outline when the arrangement has a gap, uses multiple rows/columns, misses the opening centre, fails to connect to the existing board or does not yet form a word. The explanation appears beside Play, which remains disabled for these arrangements. Filling a gap or moving tiles into a legal arrangement clears the outlines automatically; committed tiles are never marked for a draft's error. For example, with A already on the board, you can place D, then R with a gap, and fill O last to make ROAD. Dictionary recognition remains a separate check and approved shared-word flow.

Drag tentative tiles to another empty square or back onto the rack. Occupied-square drops or cancelled drags keep the original position. Tap a tentative tile to select it, then another empty square to move it; tap it again to return it. Recall returns all tentative tiles. The hand immediately closes gaps as tiles move onto the board. Blank tiles open a letter picker. The side panel previews score and checks every word formed, including crosswords, as tiles change. Invalid words remain editable without losing the turn. Opponent's latest tiles have an outline. Sound is optional and starts only after interaction. Reduced motion disables springs and animated counters. FaceTime Picture in Picture has reserved space clear of game controls.

On an empty board, a clear centre star and a single reminder explain the opening requirement. Once tiles are placed, the draft preview supplies the current explanation instead of repeating that reminder. Invalid drafts use a red tint and explain why their tiles are outlined in red, replacing the generic “Keep building” text. You may start placing at either end of the word; the first tile does not have to land on the star. Recalling a draft restores the opening reminder. The same guidance applies in the zoomed view.

The word-preview card appears only while you have draft tiles on the board. Recalling all tiles hides it again; invalid arrangements still show their explanation and valid words still show scores and dictionary checks. The resting rack uses a short instruction, with specific guidance when a tile is selected. Detailed tap, drag and hand-arrangement instructions are in Help. The FaceTime explanation is also in Help; its reserved clear area keeps the same size on the main screen, without the decorative caption.

The dragged tile floats above a touch point, with a preview in the exact landing square. Releasing settles it into place; cancelling returns it to its original spot. Reduced motion skips these animations. The **Zoom board** entry is hidden for now; its larger scrollable-board behavior and **Whole board** exit remain available for future use. Exchange tiles and Pass turn are regular secondary buttons in both views, with the same turn, connection and saving restrictions. The board stays still during a tile drag. Bonus squares use DL/TL/DW/TW, with full names in the legend and accessible labels. Scores remain in the side preview and Play button; there is no floating draft score bubble on the board.

While waiting for the other player, you can prepare a private draft using tap or drag, choose blank letters, shuffle, and recall tiles. The waiting screen labels this a private draft and its disabled Play button says to wait for the other player. Play, Pass, and Exchange remain disabled until your turn; current connection and saving restrictions are explained. Drafts survive reloads and the opponent's move; any tile whose planned square has become occupied returns to the rack, while the other placements are kept. Local drafting never sends a turn or exposes tentative tiles to the opponent.

A brief centered announcement names the current player on opening an active table and whenever the turn changes, including a fresh game. It rises gently, holds, and fades over 2.2 seconds using the selected theme; reduced motion uses only opacity. It lets taps pass through and waits for dialogs, letter selection, dragging and saving to finish. After an accepted played word, its celebration holds for about 2.4 seconds, with a short fade before the turn announcement appears at about 2.6 seconds. Sending the move to the server is immediate; the delay is presentation only. Ordinary rack edits, same-turn updates and reconnect snapshots do not replay it. Help's optional debug controls include **Preview turn announcement**, which changes no game state.

Arrange your hand by dragging a rack tile between other letters; neighboring tiles move aside to preview its position before release. Each complete slot is a stable destination, so hovering over the visible vacancy keeps that position instead of selecting the next slot. A small buffer around the midpoint between slots prevents finger jitter from changing the destination. Release uses the same target as the preview. You can also return a tentative board tile to a chosen position in the rack; its space is reserved when the drag starts, so entering or leaving the rack does not repeatedly resize it. With a keyboard, focus a rack tile and use Alt+Left/Right to move it one position. Small Recall and Shuffle buttons sit together to the right of your hand, outside the rack's drop region. Shuffle animates tiles into their new positions. Reduced motion keeps both actions immediate. Recall is available when you have tentative tiles on the board. Your chosen order (including Shuffle) survives reloads on this device and stays private. Drag movement uses transforms independently of React; pointer events are combined once per animation frame and the game rerenders only when the landing target changes.

### Word checks and shared words

The public base dictionary downloads once as a static asset and is included in the installed app's offline cache. Live checks use that local list plus approved shared words; draft words are not sent to the server as tiles are arranged. Loading or unavailable checks are labeled explicitly, and Play still performs authoritative server validation. A recognized spelling does not waive board rules or whose turn it is.

Playing an unrecognized word opens **Word not recognized**, with **Keep editing** or **Ask to add word** and an explanation that the other player must approve. Asking shares only the word, preserves the draft and leaves the turn unchanged. The other player automatically receives **Add WORD to your dictionary?**, with **Add word** or **Don’t add word**. The incoming request must be answered; it has no close button, postponement action, Escape dismissal or backdrop dismissal. An active drag, letter picker, dialog or saving command finishes before the request opens. Unanswered requests prompt again after reload. Only approval from the other player's bound device adds the word to this pair's house dictionary. The requesting player cannot approve her own request. Approvals update both screens, survive reloads and remain available in later games. No move is played automatically; tap Play again when ready. A decline leaves the dictionary and turn unchanged. This is a cooperative house rule; dictionary decisions do not carry turn penalties.

Word requests and approvals are stored under `pairs/family/wordRequests` and `pairs/family/houseWords`. Bound players may read these records; callable Functions exclusively create requests and record decisions. Only agreed words supplement the server's base dictionary, and every main and cross-word must pass validation before a move commits.

The board shows pending requests and decisions received during the current turn. Resolved notices disappear when the game advances a turn and do not reappear after reload. **Shared words**, inside Help & settings, opens approved vocabulary and request history; pending requests remain available until answered. Clearing a notice does not remove an agreed word.

### Starting a new game together

Either player may ask for a fresh game from **New game** in the top header, away from the turn controls. Completed games open a centered results dialog that explains why the game ended immediately. A brief tally counts points earned (including bonuses), applies remaining-tile deductions and any last-tile transfer, then reveals the final named scores and winner with fanfare. Show final scores skips the tally; reduced motion shows the final result immediately. The best words and full history remain in the same dialog. A finishing word gets its celebration first. **Play a new game?** lives in that popup and opens the existing proposal/consent flow. **See the board** dismisses the result, and **View final result** reopens it; reloading a completed game shows it again. Required incoming requests take priority over the result popup. The other player receives a popup to accept or decline, which must be answered and cannot be dismissed. Requesting or declining keeps the current game, scores and tiles intact. Approval starts a fresh board with new hands on both screens. The shared dictionary remains. The same consent is required after a completed game. New-game requests are stored under `pairs/family/gameRequests`, readable only by the bound pair and writable only by the two new callable Functions. Each proposal has a stable UUID, and retries or concurrent approvals cannot create duplicate games. Old boards, private state and command receipts are preserved; replacing an unfinished game records an agreed ending without inventing a winner or scoring rack deductions.

Choose the ending before proposing the new game. **Classic** uses the bag/rack and six-scoreless-turn rules above. **10 turns each** ends after 20 completed turns (Play, Pass and Exchange all count); the higher score wins, with no rack deduction at the turn limit. **First to 150** ends when a player reaches at least 150 points, with no rack deduction at that target. **Timed game** starts with an editable 25-minute duration; choose a whole number from 1 to 1,440 minutes. Its shared clock begins when the other player accepts and continues while either player is away. When it expires, the higher earned score wins, without rack deductions; equal scores are a draw.

Every mode can finish earlier when the bag is empty and a player uses her last tile, or after six consecutive scoreless turns. These normal endings retain their usual rack adjustments. The rack-out ending takes precedence if reached on the same accepted move as the turn or score limit. The consent popup shows the proposed mode and timed duration; pending or retried proposals cannot silently change them. Existing games and older proposals without a choice remain Classic. The new-game dialog is centered in the viewport, with its title and actions visible while long content scrolls inside.

When the bag is empty, **End game** replaces Exchange tiles. Either player may propose an early finish; the other player must agree. Approval deducts each player's remaining rack value, without transferring points, then shows the final tally. Declining resumes the game. A pending decision pauses shared moves; the six-scoreless-turn ending still works after the decision is resolved.

The final tally highlights each player's three highest recorded individual word scores above the full turn history. Cross-words are ranked separately and bingo points remain a turn bonus. Local development builds include clearly labelled ending previews for every end condition, either winner and a tie; previewing them does not modify the shared match.

The server owns the timed deadline and rejects late moves. An authenticated, idempotent callable finalizes an expired match when an open screen reaches the deadline or a player returns. If both screens are closed, the saved status is finalized on return; the deadline still prevents extra play. This needs no scheduled job or additional always-running service. The display uses calm text such as **25 minutes left**, rounding up to whole minutes until the final 60 seconds, when it shows seconds remaining. Countdown display is local and is calibrated against the server clock; it does not write to Firestore each second.

### Colour themes

Help & settings includes nine colour themes, saved only on the current device: **Blue & ink** (the default), **Linen & sage**, **Coastal blue**, **Rose & plum**, **Forest & wood**, **Blue & sunshine**, **Terracotta & cream**, and the dark **Ink & gold** and **Midnight teal**. Forest & wood pairs a green board with wooden tiles; Blue & sunshine uses bright blue and yellow accents. Choosing a theme changes the board, panels and controls while preserving tiles, drafts, scores and the shared game's rules. An existing saved theme stays selected. The original alternate themes adapt the neutral colours of [Catppuccin Latte](https://catppuccin.com/palette/); its MIT notice remains in [public/THEME-LICENSE.txt](public/THEME-LICENSE.txt).

### Celebrations and debug previews

Accepted words use varied celebration phrases for small, medium and high scores. Moves worth at least 40 points and seven-tile plays have a subtle starburst. In local development only, enable **Enable local preview tools** in Help & settings, then open **Debug** in the main toolbar. Try single-word, multiple-word, high-score and seven-tile scoring over a sample board; preview every ending reason, either winner or a tie; and rehearse the end-game agreement and turn announcement. Scoring previews temporarily replace only the rendered board and then restore it, preserving the real draft. Stop preview or Escape cancels a scoring preview. The launcher identifies the preview context; scenes use normal game wording without extra debug labels. Previews never play a turn, change scores or send a command. The toggle is off by default and persists only on that local device. Production builds do not expose the toggle or launcher. Reduced motion removes the starburst animation.

## Dictionary

The public app distributes the same copyright and permission notices as `public/DICTIONARY-LICENSE.txt`, available through **Word list credits** in Help. Keep that copy in sync with `shared/DICTIONARY-LICENSE.txt` when updating dictionary sources.

`shared/words.txt` contains 130,714 unique entries. Source: the official [English Speller Database generated dictionaries](https://github.com/en-wl/wordlist-diff) (ESDB, previously SCOWL), commit `7f2f4078354752045ee16a041605686561122185`. Union of `en_US-large.txt`, `en_CA-large.txt`, `en_GB-large.txt`; keep source entries matching lowercase ASCII letters only, length 2–15, uppercase and deduplicate. This excludes marked capitalized names, punctuation and possessives; some spellchecker vocabulary/abbreviations may remain. This is a **prototype dictionary**, not an official tournament dictionary. UK/Canadian/US spelling variants are accepted. The complete upstream copyright and permission notices are in `shared/DICTIONARY-LICENSE.txt` and copied into the backend deployment. No per-move external dictionary API. TR is excluded. A further 391 entries were removed using current ESDB metadata (revision `1e5b7d3a72f47a71da5d28686c1dd4b397178485`, June 2026): only entries marked as abbreviations, nonwords or dotted forms and unsupported by both the clean ESDB export and [Wordnik game vocabulary](https://github.com/wordnik/wordlist) are removed. The clean export uses `python scowl word-list 70 A,B,C 1 --wo-poses=abbr,x --categories= --wo-tags=[moby] --dot=False`; the Wordnik reference is its MIT-licensed `wordlist-20210729.txt`, revision `46e6215d0f90356afe9c8ba4be347e7e98cb425c`. This avoids rejecting older game words merely because their ESDB source is noisy, and avoids rejecting newer ordinary words solely because Wordnik is from 2021. Unflagged entries remain; no new words were added. Examples rejected include DR, KG, JR, HTTP, ASAP, ATTN, BLVD and Roman numeral XIV. QI, JO, AA, EMOJI, TWERK and ZEN remain accepted. This is a curated house list, not an exact official tournament list; unfamiliar words and international variants can still be valid. Source policy, revisions, hash, count and the exact exclusions are recorded in `shared/DICTIONARY-SOURCE.json`, mirrored publicly and copied into Functions. Both permission notices are retained. A dictionary change affects future validation, not previously committed words or mutually approved house words.

### Importing an authorized recent tournament list

The current North American tournament reference is [NWL2023](https://www.scrabbleplayers.org/w/NWL2023), effective February 29, 2024. [NSWL2023](https://www.scrabbleplayers.org/w/NSWL2023) is its school-appropriate subset. NASPA supplies member downloads and asks developers to contact it about inclusion and licensing. [WOW24](https://wordgameplayers.org/wgpo-official-words/) is WGPO's current tournament list, effective March 31, 2024; its official full text excludes `TR`. The public download does not include a redistribution permission notice, and [WGPO's December 2025 minutes](https://wordgameplayers.org/wp-content/uploads/2025/12/Minutes-of-December-10-2025-Annual-Meeting.pdf) directs requests for app use to its lexicon chair. No full tournament replacement has been installed. Collins' current international list is CSW2024, but its [download terms](https://scrabble.collinsdictionary.com/tools/) restrict copying and dissemination of the word data separately from its GPL software.

For an authorized words-only file and its accompanying copyright/permission notice, validate first:

```powershell
node scripts/import-dictionary.mjs --source C:\Lexicons\NWL2023.txt --edition NWL2023 --notice C:\Lexicons\permission.txt
# Explicitly install after validation:
node scripts/import-dictionary.mjs --source C:\Lexicons\NWL2023.txt --edition NWL2023 --notice C:\Lexicons\permission.txt --install
npm run build
```

Supported editions are `NWL2023`, `NSWL2023` and `WOW24`. The tool reads local files only, accepts 2–15 ASCII letters per line, uppercases/sorts/deduplicates, rejects `TR` or malformed entries, and requires at least 1,000 unique words for installation. It records edition, supplied filename, publisher reference, count and SHA-256 hashes in `shared/DICTIONARY-SOURCE.json` and a matching public copy. Installation synchronizes the notice in `shared` and `public`; the Functions build copies the lexicon, notice and metadata into its deployment. The importer validates file structure, not publisher authenticity or license scope: use the actual recent publisher file and permission covering this app's full static/offline client download. It does not download unauthorized mirrors, infer permission from a public link, or merge tournament editions with the prototype. Rebuild and deploy both client and server to keep their checks consistent.

## Architecture and reliability

`shared/engine.ts` is independent of React/Firebase. The frontend never draws tiles or writes authoritative match documents. Each command includes UUID, game ID and expected revision. The Function checks persistent device binding, player membership, turn, revision, actual rack and rules, then atomically commits board, both racks, bag, scores, turn, move and receipt. A receipt is checked **before** active-game/turn/revision checks; identical retries return their original result, and reused IDs with changed payloads are rejected. Rematches get a new game ID; the old receipt remains available for retries.

Public game documents contain board/scores/turn/latest move/rack counts/bag count only. Each player can read their own rack. Bag/draw order, setup code hashes and enrollment attempts are server-only. Firestore Rules deny all client writes, unauthenticated reads, opponent racks and collection queries. Administrator credentials never enter the frontend.

Pending command identity is saved before submission, scoped by project and authenticated UID. It stays saved when a response is uncertain; Firestore receipt confirmation or an explicit retry resolves it. Definitive validation rejection clears pending and keeps the draft. Offline commits are disabled. Draft placement is locally saved per match/player and reconciled against current board and rack after reload. Server state is authoritative on resume. Static PWA assets/fonts are cached within the application's path; private backend responses are never service-worker cached. Setup links/codes are not embedded in the app.

## Deploy after target review

See [DEPLOYMENT.md](DEPLOYMENT.md). Choose a separate repository and Firebase project. **Do not run the cloud commands until exact targets, Pages visibility and Blaze billing have been reviewed.** Existing Firebase CLI project selection is ignored; all admin/deploy commands specify the project. GitHub deployment is manual (`workflow_dispatch`), so pushing code does not publish it automatically.

## Known limits

Browser/emulator verification is desktop Chrome, not physical iPad, Safari or FaceTime testing. Installability, persistent storage across iPad sleep, Safari audio, tapping density and PiP positioning still need two real-device checks after deployment. No cloud latency/cold-start measurements yet; functions use minInstances 0, with no paid always-warm capacity. Clearing app storage requires signing in again with the private code, an existing passphrase or a fresh invitation. Anonymous account automatic cleanup should remain disabled so long absences do not remove players. No push notifications, chat, calling, rankings, AI, native packaging or multi-family matchmaking.

Local emulator listeners and functions are loopback only. Use cloud deployment for real remote iPads. The app shell is a static publicly reachable Pages site unless your GitHub plan supports private Pages; backend data remains restricted to the enrolled pair. Do not store service-account keys, setup codes or admin tokens in GitHub variables or client environment.

Stop any separate Vite dev server on port 5173 before browser tests: Playwright starts its own explicit emulator-configured frontend. Production dependency audit is clear; the Firebase CLI still has 11 development-tool advisories (4 moderate, 7 high) in upstream transitive dependencies. No critical advisories remain. Do not expose emulator tooling publicly.

See [VERIFICATION.md](VERIFICATION.md) for the complete checks, measured emulator timings and physical-device limitations. Run `npm run test:pwa` to verify the built repository subpath and offline shell (this rebuilds dist at /tea-and-tiles/).


## App updates and iPad display

Version 0.2.0 checks for a published update when the app returns to the foreground, when the connection returns, and every five minutes while visible. An **An update is ready** notice offers **Update app**; the open game is not automatically reloaded. Help & settings also contains **Check for updates** and the current version. Update is temporarily disabled while a command is saving, tiles are dragging/returning, or an incoming decision needs an answer. The private draft is stored locally and the shared game stays on the server. Updating does not reset it or change invitations, codes or passphrases.

Only releases before 0.2.0 lack the update notice. For that one-time upgrade, close Tea & Tiles Safari tabs and the Home Screen app, then reopen. If Help still shows the pre-0.2.0 version, allow a few seconds for the download and close/reopen once more. If it remains stuck, remove only this site's Safari website data and sign in again with the private code or existing passphrase. Releases from 0.2.0 onward use the update notice; routinely closing everything is unnecessary.

Help & settings includes **Keep screen awake**, off by default. It requests the browser's screen wake lock only while a signed-in active game is visible; it releases when hidden or finished and tries again when returning. The preference is per device. Safari tabs support this API from Safari 16.4, and installed Home Screen apps from iPadOS 18.4 ([WebKit release notes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)). Devices can still deny/release it, including in Low Power Mode. It makes no Firebase requests.

The accepted-play celebration lasts 4.5 seconds, shows the word tiles, premiums, arithmetic, and total, and can be reopened from **Score details**. Both players see the server's scoring breakdown. After the actual next-turn announcement fades away, the newly played tiles bloom larger and fade from strong green for five seconds to their faint persistent marker. A reload retains only that faint marker. New games record compact turn history and rack adjustments for the end-of-game summary. A game already in progress at this upgrade can show only subsequently recorded turns; earlier words are explicitly marked as missing rather than reconstructed.

Touch drags use a larger tile centered under the finger. Cheap visual position updates follow pointer events directly, while destination testing stays limited to one animation frame. This removes the app's extra positioning delay; Chrome touch emulation does not establish physical iPad latency. Outer rack targets remain stable during reordering. The **Blue & Ink** theme uses black lettering, bright tiles and a muted blue board.

The healthy **Connected** label is hidden; **Reconnecting** describes a problem with this device's connection. Opponent presence is approximate: a signed-in foreground device sends a small Firestore heartbeat about once per minute. **At the table** appears beside the opponent's name if any of her devices sent one within the past two minutes; otherwise it shows **Away**. An unconfirmed or unavailable presence status is hidden. Closing or hiding an app lets that heartbeat expire naturally, so a hidden tab cannot mark another active device offline. This is recent activity, not proof the other player is looking at the screen.

Presence uses no Cloud Function calls. Each heartbeat is one Firestore write; listening devices and membership-rule checks also incur document reads. Two continuously visible devices send roughly 120 writes per hour in total, plus reads; extra devices increase both. Private records contain only a player slot and server timestamp. Rules allow only the current device to write its own record, require the actual server timestamp, reject extra fields and deletions, and enforce at least 55 seconds between updates. The client uses a 60-second throttle across reloads. This small heartbeat deliberately trades instant disconnect detection for simpler infrastructure; [Firebase's native presence design](https://firebase.google.com/docs/firestore/solutions/presence) uses Realtime Database for immediate disconnect tracking.

### Release 1.3.0: confirmation and board arrival

Release 1.3.0 adds a dismissible confirmation notice after a played move remains unconfirmed for 1.5 seconds. The callable reply, a saved command receipt, or the matching authoritative last move confirms acceptance; a delayed reply is not described as a failed move. Closing the notice leaves the pending command and its retry ID intact. Fast confirmations do not open a notice. This confirms server acceptance, not whether the other device has rendered the move.

Both players see new accepted tiles arrive on the board for 850 ms before scoring. Reduced motion uses a 120 ms static highlight. Turn/result handoff timings include the placement phase, while the actual submission is sent immediately. In local Debug, every scoring scene uses the arrival phase; Slow submission simulates a five-second wait followed by arrival/scoring, and Uncertain reply rehearses confirmation without sending or accepting a move. Game over previews the finished board and next-game controls without changing the real game. Debug tools remain limited to local development.

Scored words scroll smoothly between calculations; the final word total holds for 2.2 seconds. Endings pause after counting earned points before applying remaining tiles. Zero adjustments show no sign, winners receive gold fireworks and shimmering gold text/outlines, and the next-game button has a pale green fill with a stronger pulse and edge shimmer across themes. Reduced motion keeps static readable styling. Help shows the version and timestamp generated by each deployment build.
