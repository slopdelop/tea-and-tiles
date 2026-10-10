# Firebase and iPad setup

The public repository is [slopdelop/tea-and-tiles](https://github.com/slopdelop/tea-and-tiles), with the Pages URL https://slopdelop.github.io/tea-and-tiles/. The Firebase project ID supplied by the owner is `tea-and-tiles`; its Web app and App Check key have been registered. Firebase backend deployment, billing settings and invitation issuance remain separate from GitHub setup. Invitations and Firebase permissions protect the game data.

Elizabeth is `mom` internally; Rita is `aunt`. Elizabeth starts new games. Existing seats keep their identities.

## 1. Create your Firebase project

1. Open [Firebase Console](https://console.firebase.google.com/) with your Google account. Create a new project; Analytics is optional. Record the actual **project ID**, which can differ from the display name.
2. Upgrade to **Blaze** and link billing. Cloud Functions deployment requires it. Two-person use should be small, but zero charges are not guaranteed.
3. Create **Cloud Firestore**, Standard edition / Native mode, in **europe-west2 (London)**. Location cannot be changed in place. The server/client currently use that region; selecting another requires changing both before deployment. Deploy the supplied rules instead of leaving test-mode access enabled.
4. Enable **Authentication → Sign-in method → Anonymous**. Leave automatic anonymous-account cleanup disabled: these are persistent player identities.
5. In Authentication settings, add `OWNER.github.io` to **Authorized domains**, substituting your GitHub username. Enter the hostname without protocol or repository path.
6. Under **Project settings → General**, register a **Web app**. Firebase Hosting is unnecessary. Copy its public `apiKey`, `authDomain`, `projectId` and `appId`.

## 2. Configure App Check

Cloud Functions now require valid App Check tokens. Complete this before cloud play. Local emulator testing skips App Check.

1. In the same Google Cloud project, create a **reCAPTCHA Enterprise website key** for `OWNER.github.io`. Choose a score-based key with the checkbox challenge disabled. Enable the Enterprise API if prompted. Do not add localhost to this production key.
2. In Firebase **App Check**, register your Web app using the **reCAPTCHA Enterprise** provider and that site key. Initially keep the default one-hour token lifetime and risk threshold.
3. Save the public site key as `VITE_APP_CHECK_SITE_KEY` in GitHub variables below. The client obtains/refreshes tokens automatically; the usual player flow has no puzzle.
4. After the first browser/iPad test, inspect App Check metrics for valid **Cloud Firestore** requests, then enable Firestore enforcement before the family starts using it. Functions enforcement already comes from the deployed code; database rules always apply.

App Check reduces automated misuse; membership still requires a private invitation or reusable player code/passphrase. It is not a perfect abuse barrier. See [official Web setup](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider) and [callable enforcement](https://firebase.google.com/docs/app-check/cloud-functions).

## 3. Add spending safeguards

- Create a small billing budget with several alert thresholds. Choose an amount you are comfortable with. **Alerts do not stop spending.**
- Functions use **zero minimum instances and one maximum instance per function**, with 30-second timeouts. This limits scaling rather than total monthly costs: seven functions can each have an instance.
- If available, configure Firebase **service-level spend caps** for each underlying Cloud Run service used by Functions, through project usage/billing settings. This Preview feature can pause those services, but reporting delays mean overages can still be billed. It does **not** cover Firestore or all deployment costs, and cannot guarantee stopping precisely at the free allowance. See [official limitations/setup](https://firebase.google.com/docs/projects/billing/spend-caps).
- Review the public Web API key in Google Cloud Credentials. Restrict it to the Firebase APIs the app needs; do not reuse it for billable services such as Gemini or Maps. Test authentication and gameplay after restriction changes. Follow [Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys) rather than guessing which APIs to remove.
- Keep invitations private. Per-account and shared invitation-guessing limits remain enabled. All client database writes are denied; server handlers validate membership, turns and requests. Public source/configuration does not grant a seat or administrator access.

When requests are limited/unavailable, shared actions pause and the current local draft is retained. A known rate-limit window resumes automatically; other failures offer **Try again**. An uncertain move is retried with the same command ID to avoid playing twice. The interface does not claim every outage is a billing issue.

## 4. Publish GitHub Pages

Create a separate public repository, for example `tea-and-tiles`, and push the source including lockfile and dictionary/license files. Keep local `.env`, credentials, private invitation output and emulator data out of Git. Existing ignore rules exclude local configuration/data.

Under repository **Settings → Pages**, choose **GitHub Actions**. Under **Settings → Secrets and variables → Actions → Variables**, add these public build variables:

| Variable                    | Value                   |
| --------------------------- | ----------------------- |
| `VITE_FIREBASE_PROJECT_ID`  | Actual project ID       |
| `VITE_FIREBASE_API_KEY`     | Web app public `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | Web app `authDomain`    |
| `VITE_FIREBASE_APP_ID`      | Web app `appId`         |
| `VITE_APP_CHECK_SITE_KEY`   | Enterprise site key     |

These are public identifiers, not administrator secrets. Never add service-account keys or invitation words. Run **Deploy Tea & Tiles to GitHub Pages** in the Actions tab. The workflow validates cloud configuration and uses region `europe-west2` and base path `/REPOSITORY/`.

The URL is `https://OWNER.github.io/REPOSITORY/`. The workflow assumes a repository site; a root `OWNER.github.io` repository or custom domain needs a base-path adjustment. An unlisted URL can still be discovered; it is not an access control.

## 5. Deploy the backend and issue invitations

Install Node 22.12+ and the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install). From this workspace, authenticate with the Google account owning your project. Firebase CLI login and administrator Application Default Credentials are separate:

```powershell
npm ci
npx firebase login
gcloud auth application-default login
npm run build:functions
npx firebase deploy --project YOUR_PROJECT_ID --only functions:tea-and-tiles,firestore:rules,firestore:indexes
```

Replace `YOUR_PROJECT_ID` with the exact dedicated project ID. Review that target before cloud commands. If Google requests an ADC quota project, run `gcloud auth application-default set-quota-project YOUR_PROJECT_ID`. Do not download service-account keys into the repository.

This deploys all eight callables: reusable sign-in, enrollment, turn submission, word request/response, new-game request/response and timed-game completion. Initial deployment may prompt to enable APIs or grant deployment permissions.

Once the website and backend are available, run the local administrator tool:

```powershell
node scripts/admin.mjs prepare --project YOUR_PROJECT_ID --cloud --app-url https://OWNER.github.io/REPOSITORY/
```

The tool runs on your computer with administrator credentials; it is not bundled into the website. It prints separate private invitation links/short words for **Elizabeth** and **Rita**. For simpler reusable sign-in across devices, issue each player's private six-digit code and link:

```powershell
node scripts/admin.mjs issue-pin --project YOUR_PROJECT_ID --cloud --player Elizabeth --app-url https://OWNER.github.io/REPOSITORY/
node scripts/admin.mjs issue-pin --project YOUR_PROJECT_ID --cloud --player Rita --app-url https://OWNER.github.io/REPOSITORY/
```

The tool generates all six digits cryptographically, including possible leading zeros. Choose the matching name in the installed app and enter its code, or use the private link to prefill both and tap **Sign in**. The link carries `#player=Elizabeth&code=…` in its fragment; the app removes it from the address bar after prefilling and does not sign in automatically. Treat the link as a reusable private credential. Cloud issuance requires the actual frontend URL; the tool never guesses a published URL.

The server stores a salted scrypt digest, never the code. Codes have no automatic expiry, and a player can keep multiple devices signed in. Existing invitation-linked devices remain connected. Reissuing replaces future sign-in credentials but keeps current sessions and the game. Failed sign-ins are limited to ten per player and per browser account in a one-hour window, in addition to cloud App Check protection. Six digits offer less guessing resistance than a longer passphrase; `issue-login --project YOUR_PROJECT_ID --cloud --player Elizabeth` still generates that stronger option. Existing passphrases continue working until explicitly reissued. Codes, passphrases and links are printed by the local administrator tool; keep them private and outside Git.

To revoke every session for one player, including older invitation sessions, run the following and then issue a fresh login. This preserves the active game:

```powershell
node scripts/admin.mjs revoke-login --project YOUR_PROJECT_ID --cloud --player Elizabeth
```

One-time invitations remain supported. Their unused words expire after 24 hours; joined devices stay signed in after expiry. A replacement invitation replaces the prior invitation-linked device when joined; reusable-login sessions stay connected.

Replacement invitations, run only the needed seat:

```powershell
# Elizabeth
node scripts/admin.mjs issue-code --project YOUR_PROJECT_ID --cloud --slot mom --app-url https://OWNER.github.io/REPOSITORY/
# Rita
node scripts/admin.mjs issue-code --project YOUR_PROJECT_ID --cloud --slot aunt --app-url https://OWNER.github.io/REPOSITORY/
```

## 6. Test real iPads

On each iPad, open the website in Safari → Share → Add to Home Screen. **Then open the installed Home Screen app, choose your name and enter your private code there** (an existing passphrase or unused invitation also works). Do not rely on Safari sharing its identity with the installed app.

Confirm correct names, private racks and the same match. Play alternating turns, close/reopen both apps, sleep/reconnect one device, test touch dragging/reordering and approve word/new-game requests from the other device. Check sound, reduced motion and FaceTime placement. Inspect App Check metrics and enable Firestore enforcement as above. Static assets are cached; shared turns require a connection.

## Local testing remains independent

Keep `.env` based on `.env.example` with `VITE_USE_EMULATORS=true` and project `demo-tea-and-tiles`. No Google login, cloud credentials or App Check key is needed. The standard emulator launcher supplies Firebase's emulator flag; cloud deployment has no browser-controlled enforcement bypass.

```powershell
# Terminal 1
npm run emulators
# Terminal 2: first-time setup or replacement invitations
npm run dev:prepare
npm run dev
# Terminal 3: second independent browser origin
npm run dev -- --port 5174 --strictPort
```

New invitations use Elizabeth=`mom`, Rita=`aunt`. Existing sessions keep their seats. Correct only saved display names in an existing local game without resetting game/bindings:

```powershell
node scripts/admin.mjs names --project demo-tea-and-tiles --mom-name Elizabeth --aunt-name Rita
```

For an existing cloud project, use its real ID and `--cloud`. Changing names does not change the active seat, tiles, scores or saved moves.

