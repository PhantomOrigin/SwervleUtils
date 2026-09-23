# Swervle Utils

- **Replay Viewer** Allows you to view individual runs and their inputs, with adjustable replay speed and rewind or fast forward.
- **Ghost Viewer** and **Leaderboard HUD** allow you to view multiple ghosts simultaneously without having to reload the page
- **Custom Runs** press the **+** on the leaderboard to load a replay file (the .json from Swervle's Download Run) and race or watch it. They only last for the session and only on that map.
- **Split HUD** shows time and speed difference through checkpoints compared to pb
- **Gear HUD** shows current gear and progress to next gear
- **Live Input Keys** shows the keys you are pressing while you drive
- **HUD Editor** open **Swervle Utils** in the settings menu to hide, move and resize the HUD elements
- **Reverse Cam** allows you to add reverse cam into the camera rotation and also remove freecam
- **Restart Input Fix** prevents an issue where restarting a run prevents held keys from working until they are repressed.
- **Update Notice** tells you when a newer version is available on GitHub.

## Install

Download the zip for your browser from the latest [release](../../releases/latest) and unzip it.

### Chrome / Edge / Brave

1. Download and unzip 'SwervleUtilsChromium.zip'
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.

### Firefox (experimental, Firefox 128 or newer)

1. Download 'SwervleUtilsFirefox.zip'
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the zip. Firefox removes it when it closes, so this needs repeating each time.

## Building

Requires [Node.js](https://nodejs.org) 18 or newer. From the project folder run:

```
node tools/build-release.mjs
```

This creates `versions/SwervleUtilsChromium.zip` and `versions/SwervleUtilsFirefox.zip`. If a zip fails to write, remove the extension from Firefox (it locks the file while loaded) and run it again.

## How it works

### Leaderboard box (no patching needed — this part is fully standard API usage)

- Reads the site's own `data-run-id` on leaderboard rows and calls `GET /api/v1/daily` → `GET /api/v1/dailies/{dailyId}/leaderboard` → `GET /api/v1/account/runs` to build the top-7 + PB-context view.
- `GET /api/v1/runs/{publicRunId}/ghost` returns a run's recorded inputs as base64 (`car-state-byte-v1`): one byte per tick, bitmask `throttle=1, reverse=2, steerLeft=4, steerRight=8, handbrake=16, recovery=32, boost=64`.
- All read-only `GET`s — nothing here ever starts a race or submits a run.

### How the live hooks work

`tools/patch-bundle.mjs` makes six small, precisely-anchored insertions into a copy of the site's bundle (kept as `patched-bundle.js` in this folder):

1. Exposes `window.__srv.ready = {RV, GL, VD, track, viewParent, assetFactory, modifiers, camera, ...}` — the exact classes/objects the site's own code uses to build its native opponent-ghost — every time a race boots, then calls `window.__srv.onRaceBoot?.()` so the extension can clear out any ghosts left over from a previous race context.
2. Exposes `window.__srv.onTick(telemetry)`, called every physics tick with your live `{tick, nextGateIndex, gateCount, speed, position, phase}` — this is what drives the split tracker, what gates ghost movement to the real race clock, and (via a backwards tick jump) how a Retry is detected to restart every live ghost.
3. Exposes `window.__srv.onRender({alpha, playerPosition, camera})`, called every rendered frame, right after the game updates its own ghosts/camera — used to update any ghost we've spawned (including its nameplate — see below) and (optionally) chase-cam the camera onto it.
4. Adds a `raceTelemetry` getter to their `RV` (replay/physics) class, so a ghost can be silently fast-forwarded through the *real* physics (via repeated `.step()` calls, not real-time) to read out its exact checkpoint-crossing ticks/speeds — used to compute real PB splits.
5. Makes the player's own car's color dynamic. The player's car is spawned through a factory (inside `uh`, literally named `playable-presentation-root` in the site's own code — confirmed to be the real driveable car, not a menu decoration) that's registered *once*, at app boot, with a fixed `materialColorOverrides` object (`QL`). This patches one level deeper than that registration — inside `VD`'s constructor, at the exact line (`JD(...)`) that applies the override to the car's materials — so it re-evaluates `window.__srvCarColor` on every car instantiation rather than baking in whatever it was at registration time. It only swaps in the color when the override passed in is `QL` by reference, which is what makes this target *specifically* the player's own car and leave every ghost (which always passes its own distinct override object) untouched. **Confirmed by testing**: the player's own car object persists across race retries *and* across starting new races within the same page session — a color change only actually takes effect after an honest page reload, not just a restart. A genuinely live recolor (mutating the current car's material directly, bypassing the factory entirely) was also tried and didn't work reliably, so it was dropped.

**Ghosting / duplicate-looking cars, and the black shape on the horizon**: `GL.update(alpha, referencePoint)` toggles the car between a solid material and a semi-transparent, depth-write-disabled "far" material depending on distance to whatever reference point is passed — a deliberate fade for *distant* native ghosts. We were passing the *player's* position as that reference, so any of our ghosts running at a different pace (usually far from the player) spent most of its time in that transparent state — overlapping, unsorted transparent geometry from a car model reads exactly as "ghosting, multiple copies visible at once," and the same material at a bad angle/distance is a plausible source of the dark horizon blob too. First fix: pass each ghost's own (raw, non-interpolated) position as the reference instead — usually enough, but a fast-moving car could still occasionally drift past the distance threshold before the next tick updated it, so the effect was reduced but not eliminated. Second fix: compute the *exact same* alpha-interpolated position `GL` uses internally (a plain lerp between the chassis's `previousPosition`/`position`, matching what it derives from the snapshot we just handed it) and pass that — distance to itself is then always precisely 0, not just usually close to 0, so it can never cross the threshold.

**Nameplates not billboarding**: were angled toward another car instead of facing the camera. `updateNameplate` copies `camera.quaternion`/`camera.position` onto the nameplate directly; if the site's camera is parented under a rig (e.g. attached to the player's car) those are *local*-space, not the camera's actual world orientation. Fixed by computing the camera's true world quaternion/position (`camera.getWorldQuaternion()`/`getWorldPosition()`, into cloned scratch objects so the real camera is never mutated) and passing that instead.

**Ghost colors landing on nearly the same hue**: the old hash (`h = h*31 + charCode`) barely scrambles inputs that share a long common prefix, and same-day run ids are usually near-sequential, differing only in their last couple of characters. Replaced with FNV-1a + a bit-mixing finalizer (real avalanche — small input changes flip most output bits) followed by a golden-ratio multiplicative spread over the hue circle.

**The game visibly pausing right when the leaderboard loads**: `computeSplits` (hook #4) fast-forwards a PB through the real physics in a tight synchronous loop — for a run of any real length that's thousands of `.step()` calls back-to-back with no yield, which blocks the main thread long enough to stall the game's own render loop. It now yields (`await setTimeout(0)`) every 100 ticks, spreading the same work across many frames instead of stalling one of them.

`background.js` registers a *dynamic* `declarativeNetRequest` rule pointing at this repo's own hosted `patched-bundle.js`/`patched-terrainview.js` (see the setup section above) — dynamic because the exact live filenames it needs to match change with every swervle redeploy, kept in sync via `state.json`. A separate content script, [`srv-main.js`](srv-main.js), runs in the page's own JS world at `document_start` (before that script executes) and turns those hooks into a small API — spawn/despawn a ghost (keyed and de-duplicated by `publicRunId`, so concurrent/repeated requests for the same run reuse the same car instead of stacking a new one each time), follow one with the camera, compute splits — that the extension's normal (isolated-world) UI code talks to over `CustomEvent`s via [`bridge.js`](bridge.js), since isolated and MAIN worlds don't share JS state.

Ghosts only advance while your own race's `phase` is `racing` (hook #2) — spawning one during the pre-race countdown/pointer-lock-grab leaves it standing still at the start line until your own run actually begins, instead of it having been ticking in the background the whole time.

Watching a replay this way **still can't be counted as your run**: it only ever calls the read-only ghost endpoint and adds a new, separate car object to the scene (the same mechanism the site uses for its own opponent/PB ghosts) — it never touches race state, never calls a start/submit endpoint, and your own car never moves.

### Split tracker

Uses hook #4 above to fast-forward your PB through the real physics once (fast, not real-time) and record its exact tick/speed at each checkpoint ("gate" — the site's own internal term, found in its track data). Then compares that, live, against your `onTick` telemetry as you race: the right-side panel appends a row (your time, delta, speed delta) for every checkpoint reached, never trimmed, and a popup docked under the real timer flashes the same delta/speed-diff for ~2.6s right as you cross it.

### Fallback standalone viewer

If the hooks aren't available, "Watch" opens `viewer.js`'s own canvas overlay instead: a simple kinematic reconstruction from the same real input bytes, plus a 100%-accurate input HUD (throttle/steer/brake/boost), synced to real time.

### In-game input overlay

While spectating (Watch), a small HUD near the bottom of the screen shows the followed ghost's held keys — left/right/throttle/reverse/handbrake — updated once per tick via a new `srv:ghostInput` event (dispatched from the same tick handler that steps ghosts, so it's exact, not sampled). Deliberately excludes boost/recovery per request; easy to add back in `content.js`'s `INPUT_HUD_KEYS`.

### Leaderboard: no more blank-and-reload, plus optimistic results

`loadBoard()` used to blank the list to "Loading…" on every refresh and run its three API calls one after another. Now: the daily manifest and account-runs fetches (independent of each other) run in parallel instead of sequentially, and a refresh never blanks existing content — old data (or a pending result, below) stays visible for the whole round-trip, replaced in place once the new data arrives.

Separately, the moment the site's own post-race result screen appears, if your row is in its (native, top-5-only) list, that result is reflected on our board immediately — before the real leaderboard refresh — as a pulsing "pending" row showing the *exact* text the site displayed, superseded automatically once the authoritative data lands. This only fires when you land in the site's own top-5 display, since that's the only case where a reliable run id is available to key it on; outside that it's skipped rather than guessed at.

## Tuning

- `decoder.js` / `splits.js` — `TICK_RATE` (60) is an *assumption*, not a measured value, used to convert ticks → seconds for display. If displayed run times or split deltas look consistently off by a fixed ratio, this is the constant to adjust.
- `srv-main.js` — the chase-cam offset in `followCameraOnGhost` (`{x:0, y:3.2, z:-7.5}`) is a guess at a reasonable third-person distance; adjust freely.
- `splits.js` — `POPUP_VISIBLE_MS` (2600) controls how long the checkpoint popup stays visible before fading.
- The kinematic constants in `decoder.js`'s `simulatePath` only affect the *fallback* viewer's visual path shape, not accuracy of anything else.

## Regenerating the patch after a site update

You shouldn't need to — [`.github/workflows/repatch.yml`](.github/workflows/repatch.yml) does this automatically every 15 minutes (see the setup section above). To run it locally anyway (debugging, or before the GitHub repo exists):

```bash
node tools/patch-bundle.mjs
# or, against a saved bundle instead of fetching live:
node tools/patch-bundle.mjs <path-to-downloaded-main.js> <path-to-downloaded-terrainview-chunk.js>
```

Writes `patched-bundle.js`/`patched-terrainview.js`/`state.json` and runs the full ESM-integrity check. If it throws (or logs) an anchor-count error, the site's internals changed *shape* (not just renamed identifiers) and the anchor regexes in `tools/patch-logic.mjs` (each documented inline) need to be re-derived from the new bundle — the GitHub Actions workflow hits the exact same failure and its exit code stops it from publishing a broken patch; check its run log under the repo's **Actions** tab.

## Files

- `manifest.json` — MV3 manifest: leaderboard/UI content scripts, MAIN-world hook script, background service worker, host permissions (including `raw.githubusercontent.com`, for fetching `state.json` and the patched files it points at).
- `background.js` — lightweight sync worker: fetches `state.json` from GitHub, keeps the `declarativeNetRequest` rule's match conditions pointed at the current live swervle.com filenames. Builds no content itself — see its own top comment for why.
- `.github/workflows/repatch.yml` — the actual self-healing: runs `tools/patch-bundle.mjs` against live swervle.com every 15 minutes and commits the result when it changes.
- `tools/patch-logic.mjs` — the portable derive/patch core (identifier derivation, anchor patches, no Node-specific APIs) — imported by `tools/patch-bundle.mjs`, which both the GitHub Actions workflow and a local dev run use, so there's exactly one copy of this logic.
- `tools/patch-bundle.mjs` — CLI entry point: fetches live (or reads local files in offline mode), patches via `patch-logic.mjs`, writes `patched-bundle.js`/`patched-terrainview.js`/`state.json`, runs the ESM-integrity check.
- `patched-bundle.js` / `patched-terrainview.js` / `state.json` — the actual published artifacts the extension redirects to / reads, kept updated by the GitHub Actions workflow above (or by a manual local run).
- `srv-main.js` — MAIN-world script: turns the patch's hooks into a ghost spawn/despawn/camera/splits API.
- `bridge.js` — CustomEvent request/response bridge between the isolated content script and `srv-main.js`.
- `decoder.js` — base64/bitmask decode + fallback kinematic path reconstruction.
- `api.js` — read-only fetch wrapper (daily manifest, leaderboard, account runs, ghost).
- `viewer.js` — fallback standalone replay overlay (canvas + HUD + transport controls).
- `splits.js` — live split/checkpoint tracker panel.
- `content.js` — leaderboard box, button injection, watch/race orchestration, active-ghost status bar, Swervle Utils settings menu + HUD editor, reports live page state to `background.js`.
- `styles.css` — all injected UI styling.
