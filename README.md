# Swervle Utils

An unofficial, community-made extension for [swervle.com](https://swervle.com). It is not affiliated with or endorsed by Swervle.

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

### For Users:

Swervle Utils is available on Chrome Webstore and Firefox Add-ons at the following locations:
Chromium: https://chromewebstore.google.com/detail/swervle-utils-unofficial/kcglfbbiadgcobfdiopaeenmkfddgplh
Firefox: https://addons.mozilla.org/en-US/firefox/addon/swervle-utils/

### For Developers / Other:

Download the zip for your browser from the latest [release](../../releases/latest) and unzip it.

#### Chromium (Chrome / Edge / Brave)

1. Download and unzip 'SwervleUtilsChromium.zip'
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.

#### Firefox (Firefox 140 or newer)

1. Download 'SwervleUtilsFirefox.zip'
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the zip. Firefox removes it when it closes, so this needs repeating each time.

## Extension Settings

Extension settings can be accessed from the in game settings menu on swervle.com. Press the 'Swervle Utils' button at the bottom of the in game settings menu.

## Building

Requires [Node.js](https://nodejs.org) 18 or newer. From the project folder run:

```
node tools/build-release.mjs
```

This creates `versions/SwervleUtilsChromium.zip` and `versions/SwervleUtilsFirefox.zip`. If a zip fails to write, remove the extension from Firefox (it locks the file while loaded) and run it again.

## How it works

### Leaderboard box

- Reads the site's own `data-run-id` on leaderboard rows and calls `GET /api/v1/daily` → `GET /api/v1/dailies/{dailyId}/leaderboard` → `GET /api/v1/account/runs` to build the top-7 + PB-context view.
- `GET /api/v1/runs/{publicRunId}/ghost` returns a run's recorded inputs as base64 (`car-state-byte-v1`): one byte per tick, bitmask `throttle=1, reverse=2, steerLeft=4, steerRight=8, handbrake=16, recovery=32, boost=64`.
- All read-only `GET`s — nothing here ever starts a race or submits a run.

### How the live hooks work

The extension doesn't modify or replace any of swervle.com's code, and runs nothing that isn't in this package.

swervle.com's entry script is an ES module. [`hooks.js`](hooks.js) (page world, `document_start`) imports that same URL again, which returns the already-running module instance, and finds the game's own classes among its exports by their method names (scene manager, car view, replay simulator, renderer). It wraps a few of their prototype methods to watch the game:

1. **Race boot** (the scene manager's `initialize`): builds `window.__srv.ready` — the replay simulator, car view class, car definition, scene, materials and track — and calls `window.__srv.onRaceBoot()`.
2. **Every physics tick** (`consumeSnapshot`/`consumeEvents`): reads your car's snapshot and the race events (countdown, go, checkpoint, finish) and calls `window.__srv.onTick({tick, nextGateIndex, gateCount, speed, position, phase, displayTimeMs, gear, shiftTimer})`.
3. **Every rendered frame** (the renderer's `render`): calls `window.__srv.onRender({alpha, camera})`.

Some values aren't exported (the car definition, the track generator, the daily physics modifiers, the livery module). `hooks.js` reads the entry script's text to see which of swervle's own chunk files they're imported from, and imports those chunks the same way. The track is regenerated from the day's seed with the game's own generator and checked against the manifest's track digest.

A few things are done at the page level instead: pause suppression (skips the game's blur/pointer-lock-loss listeners while the extension writes to the page), "don't grab cursor" (makes `requestPointerLock` a no-op), the restart fix (re-sends held driving keys after a restart), the C-key camera cycle (uses the game's own reverse-view button and C handling), and keeping your car still while watching a replay.

[`srv-main.js`](srv-main.js) turns those hooks into a small API — spawn/despawn a ghost (keyed by `publicRunId`), follow one with the camera, compute splits — that the isolated-world UI code talks to over `CustomEvent`s via [`bridge.js`](bridge.js).

Ghosts only advance while your own race is `racing`. Watching a replay **can't be counted as your run**: it only calls the read-only ghost endpoint and adds a separate car to the scene; it never touches race state or calls a submit endpoint.

If swervle.com changes the names these hooks look for, the affected features turn off (with a console warning) and the rest of the extension keeps working.

### Split tracker

Fast-forwards your PB through the game's own replay simulator once (fast, not real-time) and record its exact tick/speed at each checkpoint ("gate" — the site's own internal term, found in its track data). Then compares that, live, against your `onTick` telemetry as you race: the right-side panel appends a row (your time, delta, speed delta) for every checkpoint reached, never trimmed, and a popup docked under the real timer flashes the same delta/speed-diff for ~2.6s right as you cross it.

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

## Files

- `manifest.json` — MV3 manifest: page-world hook scripts, UI content scripts, background worker.
- `hooks.js` — page-world runtime hooks into the game's own modules (see above).
- `srv-main.js` — page-world ghost spawn/despawn/camera/splits API built on those hooks.
- `bridge.js` — CustomEvent request/response bridge between the isolated content script and `srv-main.js`.
- `background.js` — "new version available" check against GitHub releases.
- `decoder.js` — base64/bitmask decode + fallback kinematic path reconstruction.
- `api.js` — read-only fetch wrapper (daily manifest, leaderboard, account runs, ghost).
- `viewer.js` — fallback standalone replay overlay (canvas + HUD + transport controls).
- `splits.js` — live split/checkpoint tracker panel.
- `content.js` — leaderboard box, buttons, watch/race orchestration, Swervle Utils settings menu + HUD editor.
- `styles.css` — all injected UI styling.
