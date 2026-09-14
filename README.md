# Swervle Replay Viewer (unofficial)

A browser extension for swervle.com that adds:

- A **compact TrackMania-style leaderboard box**: top 7 plus your PB and its neighbors (or top 10 if you have no PB today), with an **"ALL" toggle** that expands it to take up the full height of the left edge, scrollable, showing every ranked time on the track (no extra request — the leaderboard API already returns the full list). Each row has three buttons: **▶ Watch**, **🏁 Race**, and **👁 (toggle)**.
- **Instant in-game ghost racing/watching** — spawns a ghost directly into the *actual running 3D scene*, live, with no page/track reload. "▶ Watch" spectates it (camera follows the ghost, your own car never moves, nothing is submitted). "🏁 Race" drives it alongside you for a real race. "👁" independently shows/hides that run's ghost in the scene without touching the camera or your splits target — multiple ghosts can be toggled on at once, each a genuinely separate car, each with its **own random color** and a **visible nametag**.
- A **live split/checkpoint ("gate") tracker**: a permanent panel listing your time, delta vs PB, and speed delta for every checkpoint reached so far (never trimmed), plus a transient popup — solid-background blocks, TrackMania-split-mod style, docked directly under the site's own big in-game timer — that flashes the same delta for a few seconds right as you cross each checkpoint.
- The leaderboard box sits flush against the left edge and the split panel flush against the right edge, both slightly above vertical center, and both are **hidden during the map-loading screen** — they reappear once the site's own `data-game-state` reports `ready` again, which covers both active racing and the pause menu (a dialog layered on top of that same state).
- A **car color picker for your own car**, injected directly into the site's own native settings menu (the ⚙ panel), next to Sound/Graphics/etc. — recolors the car you actually drive, not any ghost. Confirmed to need an actual page reload to take effect (a race retry alone isn't enough — the player's car object turns out to persist across retries and even new races within the same page session).
- A **live input overlay while spectating**: a small HUD showing the followed ghost's held keys (left/right/throttle/reverse/handbrake) each tick.
- A **fallback standalone replay viewer** (2D canvas, own physics approximation, full-precision timer, wide layout for full display names) and the site's own `?ghost=` reload link, used automatically if the in-game hooks below aren't available.

Spawned ghosts wait for your own countdown to finish before moving — they're stepped in lockstep with the real race's own physics ticks, so they can't end up seconds ahead of where your run visually starts. Ghosts also **restart alongside a Retry**, and everything gets cleared out on a genuinely new race (see `onRaceBoot` below) so stale ghosts from a previous race context can't linger into the next one. Ghost spawning is de-duplicated by run id, so repeated/rapid clicks on the same run's Watch/Race/👁 reuse the same car instead of stacking overlapping copies of it.

**Confirmed working live**: the in-game ghost, timer-docked splits panel, and camera have been verified rendering correctly in an actual race via screenshot; the leaderboard/settings-menu integration and several rendering bugs (ghosting, nameplate billboarding, the main-thread stall) were diagnosed directly from user reports and fixed based on that. The color/positioning/visibility work is solid by inspection but not yet independently screenshot-verified.

## ⚠️ Read this before relying on it

The instant/in-game/live-split features (everything above except the leaderboard box) require **patching swervle's own client bundle** to expose a few internal objects that are otherwise unreachable (private class fields, no public API). The actual derive/patch logic lives in [`tools/patch-logic.mjs`](tools/patch-logic.mjs) (see [How the live hooks work](#how-the-live-hooks-work)).

**This patch keeps itself current automatically, for every installed copy of the extension, with no new extension release needed** — but not by having the extension patch itself in-browser (two attempts at that both hit hard MV3 platform walls; see the history note below). Instead:

- A **GitHub Actions workflow** ([`.github/workflows/repatch.yml`](.github/workflows/repatch.yml)) runs `tools/patch-bundle.mjs` against the *live* swervle.com every 15 minutes, and commits `patched-bundle.js`/`patched-terrainview.js`/`state.json` to this repo whenever something actually changed. This runs on GitHub's infrastructure — independent of any player's machine, my machine, or any browser at all.
- The extension's background service worker ([`background.js`](background.js)) only ever fetches `state.json` (a few bytes: which live swervle.com filenames are *currently* patched) from this repo's raw GitHub URL, and points its `declarativeNetRequest` rule at whichever request pattern that names. The rule's *target* is a fixed `https://raw.githubusercontent.com/.../patched-bundle.js` URL that never needs to change — only its *content* does, entirely on GitHub's side. Redirecting a `<script>` tag to a normal `https://` URL is completely unrestricted (it's just ordinary cross-origin script loading), which is the whole reason this design works where the earlier ones didn't.
- This runs on install/browser-startup and immediately whenever a content script notices the live page's script filename doesn't match what's currently registered (can't help the page that just noticed — its own request was already decided — but fixes it for the next load, and tells the player to refresh).

**Two prior in-browser self-patching attempts failed for real, instructive reasons** (kept here so nobody re-tries them): redirecting straight to a `data:` URL built in memory works in some Chromium builds but is rejected with `net::ERR_UNSAFE_REDIRECT` in others (confirmed in Brave) — Chromium's redirect-safety rules don't consistently allow redirecting a script-destination request to `data:`. Redirecting to a made-up `chrome-extension://` path serviced by the background worker's own `fetch` handler also failed: a service worker only intercepts requests from clients it controls (pages loaded from its own extension origin), so a cross-origin redirect from an external page never reaches it, and `web_accessible_resources` only exposes real packaged files, not synthesized content. **MV3 does not allow an extension to serve dynamically-generated content to an external page — full stop** — which is exactly why the actual generation step now happens outside any browser, on GitHub Actions, and the extension only ever redirects to a plain hosted file.

I verified the patch **statically**: every insertion point was checked to appear in the file exactly once, and the CLI's patched output passes a full ESM parse-and-link check (`tools/patch-bundle.mjs`'s `verifyEsmIntegrity`) — a non-zero exit here stops the GitHub Actions workflow before it commits, so a corrupted patch is never published. I could **not** fully exercise it end-to-end in a real race myself — so treat the in-game features as "should work," not "independently verified," though they have since been confirmed working live across several sessions and swervle redeploys.

**If swervle changes the actual *shape* of the code** (not just reshuffled minified names/hashes — a genuinely new intermediate object, a renamed real property, a different call shape), the affected anchor(s) in `tools/patch-logic.mjs` will stop matching. That's the one case that still needs a person: each independent patch just skips (see `makePatcher`'s "matched N times, expected 1" warning — visible in the workflow's own run log on GitHub, under the Actions tab), every other patch and the rest of the site still work, and the extension shows a persistent on-page warning if the live page turns out to have loaded before a fix landed.

## One-time setup for the auto-patching (do this before distributing the extension)

1. Create a **public** GitHub repo (it needs to be public so `raw.githubusercontent.com` can serve the patched files without any auth token embedded in the extension) and push this entire folder to it.
2. Edit the three constants at the top of [`background.js`](background.js) — `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` — to match that repo.
3. Push. The workflow starts running on its own 15-minute schedule automatically (or trigger it immediately from the repo's **Actions** tab → "Re-patch Swervle bundle" → **Run workflow**) — check that it produces a commit updating `patched-bundle.js`/`patched-terrainview.js`/`state.json` before relying on it.
4. Note: this makes a modified copy of swervle.com's own client code publicly fetchable at a stable URL, which is more exposed than it being merely bundled inside an installed extension. Worth being aware of if that matters to you.

## Install (Chrome / Edge / Brave, unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`C:\Swervle Replay Viewer`).
4. Open swervle.com. The leaderboard box appears immediately. Start a race — that's when the live hooks initialize (the patch installs `window.__srv.ready` fresh every race boot), so "Watch"/"Race" only get the instant in-game path *during or after* a race has loaded once this session; before that, or if the patch didn't apply, they transparently fall back.

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
