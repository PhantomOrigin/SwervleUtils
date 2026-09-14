// Glue: scrapes the leaderboard the site already renders (to inject
// Watch/Race/Eye buttons per row), maintains a compact always-visible
// leaderboard box (top 7 + your PB context, or top 10 — expandable to every
// time on the track), and injects a car-color picker into the site's own
// settings menu. Nothing here starts a race or submits data on its own —
// spawning a ghost only ever reads the ghost-replay endpoint and adds a
// separate car object to the live scene, the same way the site's own
// opponent/PB ghosts work.
(function () {
  const seen = new Map(); // publicRunId -> { rank, displayName, timeText } (from DOM, for result-screen buttons)
  let boardListEl = null;
  let boardTitleEl = null;
  let boardEl = null;
  let expanded = false;
  let lastEntries = [];
  let lastYourEntry = null;
  // A just-finished result, shown immediately (before the real leaderboard
  // refresh lands) so the board never appears to "go away" while updating.
  // Cleared once loadBoard() gets fresh authoritative data.
  let pendingResult = null; // { publicRunId, displayName, timeText } | null

  // Ghosts currently spawned live in-game, keyed by publicRunId. Spawning is
  // idempotent on the srv-main.js side too, but tracking it here lets every
  // eye/watch/race button for the same run reflect the same on/off state.
  const visibleGhosts = new Map(); // publicRunId -> { displayName }
  let followedRunId = null; // who the camera is currently spectating, if anyone


  function findRows(root) {
    return root.querySelectorAll("li");
  }

  function extractRunInfo(li) {
    // The in-race board's rows carry a native .race-ghost-button; the
    // pause-menu's own compact board ([data-slot="menu-board"]) uses the
    // exact same <li> shape (same leaderboard-rank/-name/<time>) but has no
    // ghost button at all — its only per-row element carrying a run id is
    // the car-chip button. Falling back to that covers both boards with one
    // extraction function instead of forking the whole scan.
    const runIdEl = li.querySelector(".race-ghost-button[data-run-id]") || li.querySelector(".board-row-car[data-run-id]");
    if (!runIdEl) return null;
    const publicRunId = runIdEl.getAttribute("data-run-id");
    if (!publicRunId) return null;

    const rankEl = li.querySelector(".leaderboard-rank");
    const nameEl = li.querySelector(".leaderboard-name");
    const timeEl = li.querySelector("time");

    return {
      publicRunId,
      rank: rankEl ? rankEl.textContent.trim() : "",
      displayName: nameEl ? nameEl.textContent.trim() : "Unknown",
      timeText: timeEl ? timeEl.textContent.trim() : "",
    };
  }

  // `persistent`: skips the auto-dismiss timer and adds a manual close
  // button instead — for warnings that matter even if nobody's looking at
  // the screen in the next few seconds (e.g. bundle-staleness, below),
  // where a toast that quietly vanishes after 6s defeats the point of
  // warning at all.
  function showToast(text, isError, persistent) {
    const el = document.createElement("div");
    el.style.cssText = `
      position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
      background:${isError ? "#4a1f24" : "#191c24"}; color:#e6e9f0;
      border:1px solid rgba(255,255,255,0.12); padding:8px 14px; border-radius:8px;
      font:12px sans-serif; z-index:1000001; display:flex; align-items:center; gap:10px; max-width:70vw;
    `;
    const textEl = document.createElement("span");
    textEl.textContent = text;
    el.appendChild(textEl);
    if (persistent) {
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "×";
      closeBtn.style.cssText = "background:transparent;border:none;color:#8a93a6;font-size:16px;line-height:1;cursor:pointer;padding:0;";
      closeBtn.addEventListener("click", () => el.remove());
      el.appendChild(closeBtn);
    } else {
      setTimeout(() => el.remove(), isError ? 6000 : 4000);
    }
    document.body.appendChild(el);
    return el;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = String(s ?? "");
    return d.innerHTML;
  }

  // ---- ghost visibility (shared by Watch, Race, and the Eye toggle) ----

  function refreshRowButtonStates() {
    document.querySelectorAll("[data-srv-run-id]").forEach((group) => {
      const runId = group.getAttribute("data-srv-run-id");
      const eyeBtn = group.querySelector(".srv-eye-btn");
      if (eyeBtn) eyeBtn.classList.toggle("srv-active", visibleGhosts.has(runId));
    });
  }

  // Spawns `info`'s replay as a live ghost directly in the running game
  // scene (no page/track reload) via the patched-bundle hooks. Safe to call
  // repeatedly for the same run — it's a no-op if already visible.
  async function ensureGhostVisible(info) {
    if (visibleGhosts.has(info.publicRunId)) return true;
    const hooks = await window.SwervleBridge.checkHooks();
    if (!hooks.available) return false;

    const ghost = await window.SwervleAPI.getGhost(info.publicRunId);
    const bytes = window.SwervleDecoder.decodeStatesBase64(ghost.statesBase64);
    const displayName = ghost.publicDisplayName || info.displayName;
    const result = await window.SwervleBridge.spawnGhost(info.publicRunId, bytes, displayName, ghost.livery ?? null);
    if (result.error) throw new Error(result.error);

    // Kept alongside the ghost (not just returned) so watchReplay can read
    // it back out after this call, whether it just did the spawn above or
    // this run was already visible (in which case none of the fetch/decode
    // work above ran this time) — the input-analysis panel needs the raw
    // bytes either way.
    visibleGhosts.set(info.publicRunId, { displayName, bytes });
    refreshRowButtonStates();
    return true;
  }

  function hideGhost(publicRunId) {
    if (!visibleGhosts.has(publicRunId)) return;
    window.SwervleBridge.despawnGhost(publicRunId);
    visibleGhosts.delete(publicRunId);
    if (followedRunId === publicRunId) {
      followedRunId = null;
      const bar = document.querySelector(".srv-ghost-bar");
      if (bar) bar.style.display = "none";
      const hud = document.querySelector(".srv-input-hud");
      if (hud) hud.style.display = "none";
      const scrub = document.querySelector(".srv-replay-scrub");
      if (scrub) scrub.style.display = "none";
      scrubDragging = false;
      analysisGeneration++; // invalidate any in-flight checkpoint lookup for the run just stopped
      const analysis = document.querySelector(".srv-input-analysis");
      if (analysis) analysis.style.display = "none";
    }
    refreshRowButtonStates();
  }

  // ---- input overlay (spectate mode only): shows the followed ghost's
  // held keys each tick — just the 4 directions + handbrake. ----

  const INPUT_HUD_KEYS = [
    ["left", "◀"],
    ["throttle", "▲"],
    ["right", "▶"],
    ["reverse", "▼"],
    ["handbrake", ""], // blank, like an actual keyboard spacebar
  ];

  // Only ever true while the user has their pointer down on the scrub
  // slider — the live per-frame position updates below skip writing to it
  // while true, so they don't fight the drag by snapping the thumb back to
  // the actual playback position every frame.
  let scrubDragging = false;

  // Shared fixed-position, bottom-center wrapper for every spectate-mode
  // overlay (the ghost status bar, the held-key display, the replay
  // scrubber) — a single flex column so they stack and stay centered as a
  // group without each one needing its own position math (and, critically,
  // without the group's total height needing to be known up front: adding
  // or resizing a piece here doesn't require recalculating anyone else's
  // `bottom` offset by hand, which is what full independent positioning
  // would have needed to keep them from overlapping). Visual stacking
  // order is controlled by each child's own CSS `order` (see styles.css),
  // not by which build*() function happens to run first.
  function buildSpectateHud() {
    let wrap = document.querySelector(".srv-spectate-hud");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "srv-spectate-hud";
      document.body.appendChild(wrap);
      applyHudLayout("watch-controls", wrap);
    }
    return wrap;
  }

  function buildInputHud() {
    if (document.querySelector(".srv-input-hud")) return;
    const hud = document.createElement("div");
    hud.className = "srv-input-hud";
    hud.style.display = "none";
    hud.innerHTML = INPUT_HUD_KEYS.map(([key, label]) => `<div class="srv-hud-key" data-key="${key}">${label}</div>`).join("");
    buildSpectateHud().appendChild(hud);

    window.SwervleBridge.onGhostInput(({ key, inputByte }) => {
      if (key !== followedRunId || !hud) return;
      const input = window.SwervleDecoder.readInputByte(inputByte);
      hud.querySelectorAll(".srv-hud-key").forEach((el) => {
        el.classList.toggle("active", !!input[el.dataset.key]);
      });
    });
    return hud;
  }

  function showInputHud() {
    (document.querySelector(".srv-input-hud") || buildInputHud()).style.display = "grid";
  }

  // ---- live input overlay for YOUR OWN driving (always available while
  // racing, not just while spectating) — unlike the ghost version above,
  // there's no telemetry hook exposing the player's own raw held-input
  // booleans (onTick's telemetry only carries gear/speed/position/phase),
  // so this reads real keyboard state directly instead. Deliberately
  // listens for both arrow keys and WASD, since either could be the
  // player's actual binding and this has no way to know which — a spurious
  // highlight on an unused key set is harmless, but missing the one the
  // player actually drives with wouldn't be. ----
  const OWN_INPUT_KEY_CODES = {
    left: ["ArrowLeft", "KeyA"],
    throttle: ["ArrowUp", "KeyW"],
    right: ["ArrowRight", "KeyD"],
    reverse: ["ArrowDown", "KeyS"],
    handbrake: ["Space"],
  };
  const ownHeldCodes = new Set();

  function updateOwnInputHudKeys() {
    const hud = document.querySelector(".srv-own-input-hud");
    if (!hud) return;
    for (const [key, codes] of Object.entries(OWN_INPUT_KEY_CODES)) {
      const active = codes.some((c) => ownHeldCodes.has(c));
      hud.querySelector(`[data-key="${key}"]`)?.classList.toggle("active", active);
    }
  }

  function buildOwnInputHud() {
    if (document.querySelector(".srv-own-input-hud")) return;
    const hud = document.createElement("div");
    hud.className = "srv-own-input-hud";
    hud.style.display = "none";
    hud.innerHTML = INPUT_HUD_KEYS.map(([key, label]) => `<div class="srv-own-hud-key" data-key="${key}">${label}</div>`).join("");
    document.body.appendChild(hud);
    applyHudLayout("own-input-hud", hud);

    document.addEventListener("keydown", (e) => {
      if (ownHeldCodes.has(e.code)) return;
      ownHeldCodes.add(e.code);
      updateOwnInputHudKeys();
    });
    document.addEventListener("keyup", (e) => {
      ownHeldCodes.delete(e.code);
      updateOwnInputHudKeys();
    });
    // Held keys never get a keyup if focus leaves the page/tab entirely
    // (alt-tabbing away mid-throttle, say) — without this they'd stay
    // stuck "active" forever.
    window.addEventListener("blur", () => {
      ownHeldCodes.clear();
      updateOwnInputHudKeys();
    });

    // Same active-phase gating as the gear HUD — only while actually
    // counting down or racing, not on the pause/result/menu screens.
    window.SwervleBridge.onTick(({ phase }) => {
      hud.style.display = phase === "countdown" || phase === "racing" ? "grid" : "none";
    });
    return hud;
  }

  // ---- replay progress bar + speed multiplier (watch mode only) — its
  // own standalone panel (not nested inside the key display) specifically
  // so it can be wider than that panel for finer scrub precision, per
  // feedback that embedding it there capped its width too tightly. ----

  function buildReplayScrub() {
    if (document.querySelector(".srv-replay-scrub")) return;
    const scrub = document.createElement("div");
    scrub.className = "srv-replay-scrub";
    scrub.style.display = "none";
    scrub.innerHTML = `
      <div class="srv-scrub-row">
        <input type="range" class="srv-scrub-slider" min="0" max="0" value="0" />
        <select class="srv-scrub-speed" title="Playback speed">
          <option value="0.25">.25x</option>
          <option value="0.5">.5x</option>
          <option value="1" selected>1x</option>
          <option value="2">2x</option>
          <option value="4">4x</option>
        </select>
      </div>
      <span class="srv-scrub-label">0 / 0</span>
    `;
    buildSpectateHud().appendChild(scrub);

    const slider = scrub.querySelector(".srv-scrub-slider");
    const label = scrub.querySelector(".srv-scrub-label");
    const speedSelect = scrub.querySelector(".srv-scrub-speed");

    slider.addEventListener("pointerdown", () => {
      scrubDragging = true;
    });
    // Live label feedback while dragging, without spamming seekReplay (a
    // real fast-forward, not free) on every intermediate value as the
    // thumb moves — the actual seek only fires once, on release.
    slider.addEventListener("input", () => {
      label.textContent = `${slider.value} / ${slider.max}`;
    });
    slider.addEventListener("change", () => {
      scrubDragging = false;
      if (followedRunId) window.SwervleBridge.seekReplay(followedRunId, parseInt(slider.value, 10));
    });
    speedSelect.addEventListener("change", () => {
      if (followedRunId) window.SwervleBridge.setReplaySpeed(followedRunId, parseFloat(speedSelect.value));
    });

    window.SwervleBridge.onGhostInput(({ key, tick, totalTicks }) => {
      if (key !== followedRunId || scrubDragging) return;
      if (typeof tick !== "number" || typeof totalTicks !== "number") return;
      slider.max = Math.max(0, totalTicks - 1);
      slider.value = tick;
      label.textContent = `${tick} / ${slider.max}`;
    });
    return scrub;
  }

  function showReplayScrub() {
    const scrub = document.querySelector(".srv-replay-scrub") || buildReplayScrub();
    // A fresh watch session — reset rather than briefly showing whatever
    // position/max the previously-watched run left behind until the first
    // live update arrives a frame later.
    const slider = scrub.querySelector(".srv-scrub-slider");
    slider.max = 0;
    slider.value = 0;
    scrub.querySelector(".srv-scrub-label").textContent = "0 / 0";
    scrub.querySelector(".srv-scrub-speed").value = "1";
    scrubDragging = false;
    scrub.style.display = "flex";
  }

  // ---- input analysis (watch mode only): press/release tick counts for
  // all 4 steering directions across the whole replay, plus — if the run
  // used the recovery ("respawn") button — how many ticks after its most
  // recent checkpoint each recovery was sent. Never shown for your own
  // live run: this reads a full, already-recorded byte array up front,
  // which only exists for a replay fetched from the ghost endpoint. ----

  const ANALYSIS_DIRECTIONS = ["throttle", "reverse", "left", "right"];

  // Combines all 4 directions' bucketed durations into one — the panel
  // shows a single Presses/Releases breakdown for "how you drive" overall
  // rather than a separate one per direction.
  function mergeBuckets(bucketedList) {
    const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, "5+": 0 };
    let total = 0;
    for (const b of bucketedList) {
      for (const k of Object.keys(buckets)) buckets[k] += b.buckets[k];
      total += b.total;
    }
    const under5 = buckets[1] + buckets[2] + buckets[3] + buckets[4];
    return { buckets, total, pctUnder5: total > 0 ? (under5 / total) * 100 : 0 };
  }

  function buildInputAnalysisPanel() {
    if (document.querySelector(".srv-input-analysis")) return;
    const panel = document.createElement("div");
    panel.className = "srv-input-analysis";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="srv-analysis-header">
        <span class="srv-analysis-title">INPUT ANALYSIS</span>
        <button class="srv-analysis-collapse" title="Collapse">—</button>
      </div>
      <div class="srv-analysis-body"></div>
    `;
    document.body.appendChild(panel);
    applyHudLayout("input-analysis", panel);
    panel.querySelector(".srv-analysis-collapse").addEventListener("click", () => {
      panel.classList.toggle("srv-collapsed");
    });
    return panel;
  }

  // "Presses:"/"Releases:" duration-bucket table for one direction — how
  // many presses (or releases) lasted exactly 1/2/3/4 ticks vs 5+, plus
  // what fraction were under 5. `bucketed` is one of analyzeInputs()'s
  // perDirection[dir].presses/.releases ({ buckets, total, pctUnder5 }).
  function renderBucketTable(title, bucketed) {
    if (bucketed.total === 0) {
      return `<div class="srv-analysis-bucket-title">${title}</div><div class="srv-analysis-empty">none</div>`;
    }
    const rows = [1, 2, 3, 4, "5+"]
      .map((k) => `<div class="srv-analysis-bucket-row"><span>${k} tick${k === 1 ? "" : "s"}:</span><span>${bucketed.buckets[k]}</span></div>`)
      .join("");
    return `
      <div class="srv-analysis-bucket-title">${title}</div>
      ${rows}
      <div class="srv-analysis-bucket-row srv-analysis-bucket-pct"><span>% under 5:</span><span>${bucketed.pctUnder5.toFixed(0)}%</span></div>
    `;
  }

  // `gates` is computeSplits()'s result shape: [{gateIndex, tick, speed}, …]
  // in ascending tick order, one entry per gate the run actually reached.
  // Finds the latest gate crossed at or before `tick` — the checkpoint that
  // recovery press was "after".
  function lastGateBefore(gates, tick) {
    let found = null;
    for (const g of gates) {
      if (g.tick <= tick) found = g;
      else break;
    }
    return found;
  }

  function renderInputAnalysisBody(analysis, gates) {
    const presses = mergeBuckets(ANALYSIS_DIRECTIONS.map((dir) => analysis.perDirection[dir].presses));
    const releases = mergeBuckets(ANALYSIS_DIRECTIONS.map((dir) => analysis.perDirection[dir].releases));
    const dirRows = `
      <div class="srv-analysis-dir">
        ${renderBucketTable("Presses:", presses)}
        ${renderBucketTable("Releases:", releases)}
      </div>`;

    // Highest CPS: the fastest any *one* direction was ever tapped anywhere
    // in the run (e.g. 8 left-taps inside some 1-second span) — already
    // computed per-direction and maxed together in analyzeInputs, not a
    // combined count across directions.
    const cpsRow = `
      <div class="srv-analysis-dir">
        <div class="srv-analysis-bucket-row srv-analysis-cps"><span>Highest CPS:</span><span>${analysis.highestCps}</span></div>
      </div>`;

    let respawnSection = "";
    if (analysis.recoveryPressTicks.length > 0) {
      const rows = analysis.recoveryPressTicks
        .map((tick) => {
          if (gates === null) return `<div class="srv-analysis-respawn-row">tick ${tick} — checkpoint timing unavailable</div>`;
          const gate = lastGateBefore(gates, tick);
          const label = gate
            ? `${tick - gate.tick} ticks after checkpoint ${gate.gateIndex + 1}`
            : `${tick} ticks after the start (before checkpoint 1)`;
          return `<div class="srv-analysis-respawn-row">tick ${tick} — ${label}</div>`;
        })
        .join("");
      respawnSection = `
        <div class="srv-analysis-dir srv-analysis-respawns">
          <div class="srv-analysis-dir-header"><span>⟲ RESPAWNS (${analysis.recoveryPressTicks.length})</span></div>
          <div class="srv-analysis-events">${rows}</div>
        </div>`;
    }

    return dirRows + cpsRow + respawnSection;
  }

  // Counts/tick-lists are pure decode work (instant); the "ticks after
  // checkpoint" part needs a silent physics fast-forward (computeSplits,
  // the same one used for PB split calculation) to know where the
  // checkpoints actually were, which only works with a live race scene —
  // rendered as soon as it's available rather than blocking the rest of
  // the panel on it.
  // Bumped on every call so a slow computeSplits() from a *previous* watch
  // can tell it's stale once it resolves — otherwise switching to a new
  // replay while an old one's checkpoint lookup is still in flight could
  // let that old result land afterward and clobber the new panel with the
  // wrong run's data.
  let analysisGeneration = 0;

  async function showInputAnalysis(bytes) {
    if (!bytes) return;
    const generation = ++analysisGeneration;
    const panel = document.querySelector(".srv-input-analysis") || buildInputAnalysisPanel();
    const body = panel.querySelector(".srv-analysis-body");
    const analysis = window.SwervleDecoder.analyzeInputs(bytes);
    body.innerHTML = renderInputAnalysisBody(analysis, null);
    panel.style.display = "block";

    if (analysis.recoveryPressTicks.length > 0) {
      try {
        const result = await window.SwervleBridge.computeSplits(bytes);
        if (generation !== analysisGeneration) return; // a newer watch/hide superseded this one
        if (!result.error) body.innerHTML = renderInputAnalysisBody(analysis, result.gates);
      } catch (err) {
        console.error("[Swervle Replay Viewer] input analysis checkpoint lookup failed", err);
      }
    }
  }

  // ---- gear viewer: your own live gear, shown whenever you're actually
  // driving (countdown or racing) — not tied to spectate mode like the
  // input overlay above, since this reflects the player's own car. ----

  // TrackMania-style rev bar: fills left-to-right across the CURRENT gear's
  // own speed range, turning red once you're close to the next shift, then
  // resets to empty the instant you shift up (the new gear's range starts
  // right where the old one's ended, so speed sits near the start of it
  // immediately after a shift — no special-case reset logic needed, it
  // falls out of the math). Mirrors the game's own stock transmission
  // config (`Y.transmission.forwardGearMaxSpeeds` inside the CarAppearance
  // chunk — index N is the speed gear N shifts up at, index 0 unused). The
  // daily mode has no player-selectable physics modifiers, so hardcoding
  // this is safe; revisit if that ever changes.
  const FORWARD_GEAR_MAX_SPEEDS = [0, 5, 9, 13, 17, 22, 25, 27.5];
  const GEAR_HUD_HOT_THRESHOLD = 0.85; // fraction of the gear's range before the bar turns red

  function buildGearHud() {
    if (document.querySelector(".srv-gear-hud")) return;
    const hud = document.createElement("div");
    hud.className = "srv-gear-hud";
    hud.style.display = "none";
    hud.innerHTML = `
      <span class="srv-gear-hud-number">-</span>
      <div class="srv-gear-hud-track"><div class="srv-gear-hud-fill"></div></div>
    `;
    document.body.appendChild(hud);
    applyHudLayout("gear-hud", hud);
    const numberEl = hud.querySelector(".srv-gear-hud-number");
    const fillEl = hud.querySelector(".srv-gear-hud-fill");

    window.SwervleBridge.onTick(({ phase, gear, shiftTimer, speed }) => {
      const active = phase === "countdown" || phase === "racing";
      hud.style.display = active ? "flex" : "none";
      if (!active) return;
      numberEl.textContent = gear > 0 ? gear : "-";

      // Neutral/stationary/reverse (gear <= 0, or off the end of the table)
      // shows an empty bar rather than a guess.
      let fraction = 0;
      if (gear > 0 && gear < FORWARD_GEAR_MAX_SPEEDS.length) {
        const rangeStart = FORWARD_GEAR_MAX_SPEEDS[gear - 1] ?? 0;
        const rangeEnd = FORWARD_GEAR_MAX_SPEEDS[gear];
        fraction = rangeEnd > rangeStart ? (speed - rangeStart) / (rangeEnd - rangeStart) : 1;
        fraction = Math.max(0, Math.min(1, fraction));
      }
      fillEl.style.width = `${(fraction * 100).toFixed(1)}%`;
      fillEl.classList.toggle("srv-gear-hud-fill-hot", fraction >= GEAR_HUD_HOT_THRESHOLD);

      // shiftTimer counts down the site's own post-shift power-cut window
      // (Z.transmission.shiftCutSeconds) — a nonzero value means a shift
      // just happened, so flash the gear number briefly rather than just
      // snapping to the new digit with no feedback.
      hud.classList.toggle("srv-gear-hud-shifting", (shiftTimer ?? 0) > 0);
    });
    return hud;
  }

  // Toggle: shows/hides this run's ghost in the live scene without forcing
  // a camera change — useful to have it visible alongside your own driving,
  // or to keep a watched replay running after dismissing its status bar.
  async function toggleEye(info) {
    if (visibleGhosts.has(info.publicRunId)) {
      hideGhost(info.publicRunId);
      return;
    }
    try {
      const ok = await ensureGhostVisible(info);
      if (!ok) showToast("In-game hooks unavailable — the eye toggle needs a race to be loaded first.", true);
    } catch (err) {
      console.error("[Swervle Replay Viewer] eye toggle failed", err);
      showToast(`Couldn't show that ghost (${err.message})`, true);
    }
  }

  function buildActiveGhostBar() {
    if (document.querySelector(".srv-ghost-bar")) return;
    const bar = document.createElement("div");
    bar.className = "srv-ghost-bar";
    bar.style.display = "none";
    bar.innerHTML = `
      <span class="srv-ghost-bar-label"></span>
      <button class="srv-btn srv-ghost-bar-stop" type="button">Stop watching</button>
    `;
    buildSpectateHud().appendChild(bar);
    bar.querySelector(".srv-ghost-bar-stop").addEventListener("click", () => {
      if (followedRunId) {
        window.SwervleBridge.setCameraFollow(null);
        hideGhost(followedRunId);
      }
    });
    return bar;
  }

  function showActiveGhostBar(text) {
    const bar = document.querySelector(".srv-ghost-bar") || buildActiveGhostBar();
    bar.querySelector(".srv-ghost-bar-label").textContent = text;
    bar.style.display = "flex";
    showInputHud();
    showReplayScrub();
  }

  // Spectate-only: renders the real recorded run live in the actual game
  // scene when possible, camera following it. This never starts a race,
  // never submits anything, and doesn't move your own car — it structurally
  // cannot be counted as a run you drove.
  async function watchReplay(info) {
    let loadingBadge = showToast(`Loading replay for ${info.displayName}…`);
    try {
      const spawnedLive = await ensureGhostVisible(info);
      if (spawnedLive) {
        if (followedRunId && followedRunId !== info.publicRunId) hideGhost(followedRunId);
        followedRunId = info.publicRunId;
        window.SwervleBridge.setCameraFollow(info.publicRunId);
        showActiveGhostBar(`Spectating ${info.displayName}'s replay (not your run)`);
        showInputAnalysis(visibleGhosts.get(info.publicRunId)?.bytes);
      } else {
        const ghost = await window.SwervleAPI.getGhost(info.publicRunId);
        const bytes = window.SwervleDecoder.decodeStatesBase64(ghost.statesBase64);
        window.SwervleViewer.open({
          displayName: ghost.publicDisplayName || info.displayName,
          publicRunId: info.publicRunId,
          bytes,
        });
        showToast("In-game hooks unavailable — showing the standalone replay viewer instead.");
      }
    } catch (err) {
      console.error("[Swervle Replay Viewer] failed to load replay", err);
      showToast(`Couldn't load that replay (${err.message})`, true);
    } finally {
      loadingBadge?.remove();
    }
  }

  // Races the ghost for real (you drive against it — this is a genuine race,
  // not spectating). Tries an instant in-scene spawn first (no reload); if
  // the live hooks aren't available, falls back to the site's own
  // `?ghost=<publicRunId>` deep link, which works but reloads the track.
  async function raceGhost(info) {
    let loadingBadge = showToast(`Loading ${info.displayName || "ghost"}…`);
    try {
      const spawnedLive = await ensureGhostVisible(info);
      if (spawnedLive) {
        window.SwervleSplits?.setPb(info.publicRunId, info.displayName);
      } else {
        loadingBadge.remove();
        loadingBadge = null;
        showToast("In-game hooks unavailable — using the site's own race-ghost link (reloads the track).");
        const url = new URL(window.location.href);
        url.searchParams.set("ghost", info.publicRunId);
        window.location.href = url.toString();
      }
    } catch (err) {
      console.error("[Swervle Replay Viewer] failed to race ghost", err);
      showToast(`Couldn't load that ghost (${err.message})`, true);
    } finally {
      loadingBadge?.remove();
    }
  }

  // ---- shared 3-button group (Watch / Race / Eye) ----

  function buildButtonGroup(info) {
    const group = document.createElement("span");
    group.className = "srv-btn-group";
    group.setAttribute("data-srv-run-id", info.publicRunId);
    group.innerHTML = `
      <button class="srv-watch-btn" type="button" title="Watch replay (spectate only)">▶</button>
      <button class="srv-race-btn" type="button" title="Race this ghost">🏁</button>
      <button class="srv-eye-btn" type="button" title="Toggle ghost visible in-game">👁</button>
    `;
    group.querySelector(".srv-watch-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      watchReplay(info);
    });
    group.querySelector(".srv-race-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      raceGhost(info);
    });
    group.querySelector(".srv-eye-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEye(info);
    });
    if (visibleGhosts.has(info.publicRunId)) group.querySelector(".srv-eye-btn").classList.add("srv-active");
    return group;
  }

  function injectButton(li, info) {
    if (li.querySelector("[data-srv-run-id]")) return;
    const group = buildButtonGroup(info);
    // Both native boards lay each row out as a CSS grid with a fixed
    // column count matching however many children the *native* markup
    // has — result-board's own race-ghost-button is even pinned to an
    // explicit grid-column. Just appending our group as a plain extra
    // sibling makes it an unplaced Nth grid item, which CSS grid's
    // auto-placement then drops onto a whole new row instead of fitting it
    // in (doubling the row's height — reported as rows "covering two
    // lines"). Wrapping the row's own native action button (whichever one
    // actually carries the run id — see extractRunInfo) together with ours
    // in one element that takes over its original slot keeps the row's
    // total grid-item count exactly what the site's own CSS expects.
    const nativeBtn = li.querySelector(".race-ghost-button[data-run-id]") || li.querySelector(".board-row-car[data-run-id]");
    if (nativeBtn) {
      const wrapper = document.createElement("span");
      wrapper.className = "srv-row-actions";
      nativeBtn.replaceWith(wrapper);
      wrapper.append(group, nativeBtn);
    } else {
      const anchor = li.querySelector("time") || li.querySelector(".leaderboard-name") || li;
      anchor.insertAdjacentElement("afterend", group);
    }
  }

  function findBoard(root, dataSlot) {
    return root.querySelector?.(`[data-slot="${dataSlot}"]`) || (root.matches?.(`[data-slot="${dataSlot}"]`) ? root : null);
  }

  function scanForLeaderboard(root) {
    const board = findBoard(root, "result-board");
    if (!board) return;
    for (const li of findRows(board)) {
      const info = extractRunInfo(li);
      if (!info) continue;
      seen.set(info.publicRunId, info);
      injectButton(li, info);
    }

    // The row the site marks as yours (only present when a result is being
    // shown, i.e. right after finishing) — reflect it on the board
    // immediately, ahead of the real leaderboard refresh. Only works when
    // that row also carries a ghost-button run id (true when you land in
    // the top 5 shown natively); otherwise there's nothing reliable to key
    // an optimistic row on, so it's skipped rather than guessed at.
    const youLi = board.querySelector('li[data-player="true"]');
    const youInfo = youLi ? extractRunInfo(youLi) : null;
    if (youInfo && youInfo.timeText) {
      pendingResult = {
        publicRunId: youInfo.publicRunId,
        displayName: youInfo.displayName,
        timeText: youInfo.timeText,
      };
      if (boardListEl) renderRows(computeRows());
    }
  }

  // The compact board embedded directly in the pause menu (separate from
  // both the in-race HUD board above and the full "LEADERBOARD" screen
  // below) — same row markup as the in-race board, but natively has no
  // per-row action buttons at all (see extractRunInfo's fallback to the
  // car-chip button for where its run id actually lives). No "you" row
  // logic here — that's specific to the post-result context the in-race
  // board appears in, which doesn't apply to a plain menu screen.
  function scanForMenuBoard(root) {
    const board = findBoard(root, "menu-board");
    if (!board) return;
    for (const li of findRows(board)) {
      const info = extractRunInfo(li);
      if (!info) continue;
      injectButton(li, info);
    }
  }

  // ---- native "LEADERBOARD" screen (pause menu → LEADERBOARD): a
  // different, separate UI from the in-race board above. Each ranked
  // player row can be expanded (the disclosure arrow) to reveal every
  // individual run they've set — the site already puts its own native
  // "race this ghost" button (.race-ghost-button) on each of those expanded
  // rows, but there's no way to just spectate one. This adds a Watch button
  // (and the same Eye visibility toggle as everywhere else) right next to
  // the existing native button, styled to match — leaving the native race
  // button alone rather than duplicating it. ----

  function extractAttemptInfo(li) {
    const ghostBtn = li.querySelector(".race-ghost-button[data-run-id]");
    if (!ghostBtn) return null;
    const publicRunId = ghostBtn.getAttribute("data-run-id");
    if (!publicRunId) return null;

    // The player's display name isn't repeated on every attempt row — it's
    // only on the enclosing list's own aria-label ("Every run by <name>"),
    // set once by the site's own Jw()/qw() template functions.
    const rowsEl = li.closest(".board-attempt-rows");
    const ariaLabel = rowsEl ? rowsEl.getAttribute("aria-label") || "" : "";
    const displayName = ariaLabel.replace(/^Every run by /, "").trim() || "Unknown";

    const valueEl = li.querySelector(".board-attempt-value");
    const rankEl = li.querySelector(".board-attempt-rank");
    return {
      publicRunId,
      rank: rankEl ? rankEl.textContent.trim() : "",
      displayName,
      timeText: valueEl ? valueEl.textContent.trim() : "",
    };
  }

  function injectAttemptButtons(li, info) {
    if (li.querySelector("[data-srv-run-id]")) return;
    const group = document.createElement("span");
    group.className = "srv-btn-group";
    group.setAttribute("data-srv-run-id", info.publicRunId);
    group.innerHTML = `
      <button class="srv-watch-btn" type="button" title="Watch replay (spectate only)">▶</button>
      <button class="srv-eye-btn" type="button" title="Toggle ghost visible in-game">👁</button>
    `;
    group.querySelector(".srv-watch-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      watchReplay(info);
    });
    group.querySelector(".srv-eye-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEye(info);
    });
    if (visibleGhosts.has(info.publicRunId)) group.querySelector(".srv-eye-btn").classList.add("srv-active");

    // This row is also a fixed-column CSS grid with the native
    // race-ghost-button pinned to an explicit grid-column — see
    // injectButton's own version of this comment for why a plain sibling
    // insert here breaks into a second row instead of sitting next to it.
    // Wrapping both together in one element keeps the row's grid-item
    // count unchanged.
    const ghostBtn = li.querySelector(".race-ghost-button[data-run-id]");
    const wrapper = document.createElement("span");
    wrapper.className = "srv-row-actions";
    ghostBtn.replaceWith(wrapper);
    wrapper.append(group, ghostBtn);
  }

  function scanForAttemptRows(root) {
    const lists = [];
    if (root.matches?.(".board-attempt-rows")) lists.push(root);
    if (root.querySelectorAll) lists.push(...root.querySelectorAll(".board-attempt-rows"));
    for (const ol of lists) {
      for (const li of ol.children) {
        const info = extractAttemptInfo(li);
        if (info) injectAttemptButtons(li, info);
      }
    }
  }

  // ---- Compact TrackMania-style leaderboard box ----

  function buildBoard() {
    if (document.querySelector(".srv-board")) return;

    boardEl = document.createElement("div");
    boardEl.className = "srv-board";
    boardEl.innerHTML = `
      <div class="srv-board-header">
        <span class="srv-board-title">LEADERBOARD</span>
        <button class="srv-board-expand" title="Show every time on the track">ALL</button>
        <button class="srv-board-refresh" title="Refresh">⟳</button>
        <button class="srv-board-collapse" title="Collapse">—</button>
      </div>
      <div class="srv-board-list"><div class="srv-board-empty">Loading…</div></div>
    `;
    document.body.appendChild(boardEl);
    applyHudLayout("leaderboard", boardEl);
    boardListEl = boardEl.querySelector(".srv-board-list");
    boardTitleEl = boardEl.querySelector(".srv-board-title");

    boardEl.querySelector(".srv-board-refresh").addEventListener("click", () => loadBoard());
    boardEl.querySelector(".srv-board-collapse").addEventListener("click", (e) => {
      boardEl.classList.toggle("srv-collapsed");
      e.target.textContent = boardEl.classList.contains("srv-collapsed") ? "+" : "—";
    });
    boardEl.querySelector(".srv-board-expand").addEventListener("click", (e) => {
      expanded = !expanded;
      e.target.classList.toggle("srv-active", expanded);
      boardEl.classList.toggle("srv-expanded", expanded);
      renderRows(computeRows());
    });
  }

  function fmtTicks(durationTicks, tickRate = window.SwervleDecoder.TICK_RATE) {
    const totalSec = durationTicks / tickRate;
    const m = Math.floor(totalSec / 60);
    const s = (totalSec % 60).toFixed(2).padStart(5, "0");
    return m > 0 ? `${m}:${s}` : `${s}s`;
  }

  // Rebuilding the board's DOM (innerHTML + recreating each row's button
  // group) while you're actually driving was pausing the run instantly.
  // Two earlier attempts tried to dodge it by not touching the DOM at
  // certain times (while pointer-locked, or during "racing"/"countdown")
  // — neither reliably prevented the pause, and the second one also broke
  // something that used to work: the board updating live during a run at
  // all. Traced the actual mechanism into the patched bundle itself instead
  // (patch #8, tools/patch-bundle.mjs): the site's own pause menu can be
  // triggered by either losing window focus (`blur`) or losing pointer
  // lock, and DOM churn here was apparently costing it one of those. Rather
  // than guess which, or when it's "safe", this now leaves updates free to
  // happen live (restoring the old behavior) and tells the site's own
  // pause logic to ignore both triggers for the specific window this
  // mutation is happening in, via window.__srvSuppressPause (set through
  // srv-main.js, since content.js's isolated world can't set it directly).
  function withPauseSuppressed(fn) {
    document.dispatchEvent(new CustomEvent("srv:suppressPause", { detail: { suppress: true } }));
    try {
      fn();
    } finally {
      // Stays suppressed for a couple of frames after the mutation, not
      // just synchronously around it — a triggered blur/pointerlockchange
      // event can land a frame or two later than the DOM write that caused
      // it, not necessarily in the same microtask.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document.dispatchEvent(new CustomEvent("srv:suppressPause", { detail: { suppress: false } }))
        )
      );
    }
  }

  function renderRows(rows) {
    if (!boardListEl) return;
    withPauseSuppressed(() => {
      if (rows.length === 0) {
        boardListEl.innerHTML = `<div class="srv-board-empty">No leaderboard data yet.</div>`;
        return;
      }
      boardListEl.innerHTML = rows
        .map((row) => {
          if (row.separator) return `<div class="srv-board-sep">⋯</div>`;
          const cls = [row.isYou && "srv-board-you", row.pending && "srv-board-pending"].filter(Boolean).join(" ");
          const timeText = row.pending ? escapeHtml(row.pendingTimeText) : fmtTicks(row.durationTicks);
          return `
            <div class="srv-board-row${cls ? " " + cls : ""}" data-run-id="${row.publicRunId}">
              <span class="srv-board-rank">${row.rank}</span>
              <span class="srv-board-name">${escapeHtml(row.publicDisplayName)}</span>
              <span class="srv-board-time">${timeText}${row.pending ? " ⏳" : ""}</span>
              <span class="srv-board-actions" data-srv-anchor></span>
            </div>`;
        })
        .join("");
      boardListEl.querySelectorAll(".srv-board-row").forEach((rowEl) => {
        const runId = rowEl.getAttribute("data-run-id");
        const row = rows.find((r) => !r.separator && r.publicRunId === runId);
        const info = { publicRunId: row.publicRunId, displayName: row.publicDisplayName };
        rowEl.querySelector("[data-srv-anchor]").replaceWith(buildButtonGroup(info));
      });
    });
  }

  // Abbreviated (top 7 + PB context / top 10) or, when expanded, literally
  // every ranked time on the track — using the same already-fetched
  // `lastEntries`, no extra request needed.
  function computeRows() {
    const entries = lastEntries;
    const yourEntry = lastYourEntry;

    if (expanded) {
      boardTitleEl.textContent = "ALL TIMES";
      return entries.map((e) => ({ ...e, isYou: yourEntry != null && e.publicRunId === yourEntry.publicRunId }));
    }

    if (yourEntry) {
      boardTitleEl.textContent = "LEADERBOARD";
      const top = entries.filter((e) => e.rank <= 7);
      const rows = top.map((e) => ({ ...e, isYou: e.publicRunId === yourEntry.publicRunId }));
      if (yourEntry.rank > 7) {
        const above = entries.find((e) => e.rank === yourEntry.rank - 1);
        const below = entries.find((e) => e.rank === yourEntry.rank + 1);
        rows.push({ separator: true });
        if (above && above.rank > 7) rows.push(above);
        rows.push({ ...yourEntry, isYou: true });
        if (below) rows.push(below);
      } else if (yourEntry.rank === 7) {
        // Right at the edge of the visible top 7 — also show 8th (the one
        // row that'd otherwise be just out of view below you).
        const below = entries.find((e) => e.rank === 8);
        if (below) rows.push(below);
      }
      return applyPendingOverlay(rows);
    }

    boardTitleEl.textContent = "TOP 10";
    return applyPendingOverlay(entries.filter((e) => e.rank <= 10));
  }

  // Overlays a just-finished result on top of whatever's already computed,
  // so it's visible the instant you cross the line instead of waiting on
  // the network round-trip. Superseded automatically the moment loadBoard()
  // clears `pendingResult` and re-renders with real data.
  function applyPendingOverlay(rows) {
    if (!pendingResult) return rows;
    const idx = rows.findIndex((r) => !r.separator && r.publicRunId === pendingResult.publicRunId);
    if (idx !== -1) {
      rows[idx] = { ...rows[idx], pending: true, pendingTimeText: pendingResult.timeText };
      return rows;
    }
    const pendingRow = {
      pending: true,
      isYou: true,
      publicRunId: pendingResult.publicRunId,
      publicDisplayName: pendingResult.displayName,
      pendingTimeText: pendingResult.timeText,
      rank: "…",
    };
    const youIdx = rows.findIndex((r) => !r.separator && r.isYou);
    if (youIdx !== -1) rows[youIdx] = pendingRow;
    else rows.unshift(pendingRow);
    return rows;
  }

  // The site now routes an explicit archived map as "/daily/<dailyId>"
  // (see the site's own race-prefetch.js, which parses the same segments to
  // kick off that map's document fetch early) — anything else, including
  // the root route, plays today's. Switching maps navigates for real
  // (window.location.assign, not client-side pushState — confirmed absent
  // from the bundle), so this only needs to be read once per load; there's
  // no in-page route change to listen for.
  function getCurrentDailyIdFromRoute() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length === 2 && segments[0] === "daily") return segments[1];
    return null;
  }

  // How often the board re-fetches on its own (beyond the explicit refresh
  // button, a just-finished run, or a route change/reload) so other
  // players' new times show up without you having to ask.
  const AUTO_REFRESH_MS = 20000;

  async function loadBoard() {
    if (!boardListEl) return;
    // Deliberately doesn't blank the list first — the old data (or a
    // pending-result overlay, see applyPendingOverlay) stays on screen for
    // the whole round-trip instead of the board flashing to "Loading…" and
    // back. Only the very first load, before there's anything to show yet,
    // gets the loading placeholder.
    if (lastEntries.length === 0 && !pendingResult) {
      withPauseSuppressed(() => {
        boardListEl.innerHTML = `<div class="srv-board-empty">Loading…</div>`;
      });
    }
    try {
      // The current route already names the exact map being played when
      // it's an explicit "/daily/<dailyId>" — the dailyId IS right there in
      // the URL, so skip the getDailyManifest() round-trip entirely rather
      // than asking the server to tell us what we already know (this also
      // fixes the board always showing *today's* map/leaderboard even while
      // browsing/playing an older one). Only the plain "today" route (no
      // explicit date) still needs the manifest fetch, purely to learn
      // today's dailyId. Either way, getAccountRuns() doesn't depend on any
      // of this, so it still runs in parallel rather than after.
      const routeDailyId = getCurrentDailyIdFromRoute();
      const [manifest, accountRuns] = await Promise.all([
        routeDailyId ? null : window.SwervleAPI.getDailyManifest(),
        window.SwervleAPI.getAccountRuns(),
      ]);
      const dailyId = routeDailyId || manifest?.dailyId;
      if (!dailyId) throw new Error("no dailyId in manifest");

      lastEntries = (await window.SwervleAPI.getLeaderboard(dailyId)).slice().sort((a, b) => a.rank - b.rank);

      lastYourEntry = null;
      if (accountRuns) {
        const eligibleToday = accountRuns.filter(
          (r) => r.dailyId === dailyId && r.leaderboardEligible === true
        );
        if (eligibleToday.length > 0) {
          const best = eligibleToday.reduce((a, b) => (a.durationTicks <= b.durationTicks ? a : b));
          lastYourEntry = lastEntries.find((e) => e.publicRunId === best.publicRunId) || null;
        }
      }

      pendingResult = null; // real data has arrived — stop overlaying the guess
      renderRows(computeRows());
      window.SwervleSplits?.setPb(lastYourEntry?.publicRunId ?? null, lastYourEntry?.publicDisplayName ?? null);
    } catch (err) {
      console.error("[Swervle Replay Viewer] failed to load leaderboard", err);
      // Leave whatever was already showing (old data or a pending overlay)
      // in place rather than replacing it with an error message.
      if (lastEntries.length === 0 && !pendingResult) {
        withPauseSuppressed(() => {
          boardListEl.innerHTML = `<div class="srv-board-empty">Couldn't load leaderboard.</div>`;
        });
      }
    }
  }

  // ---- extension settings: a single "Swervle Utils" button injected into
  // the site's own settings modal, opening our own overlay menu instead of
  // extending the native settings groups directly (previous behaviour) —
  // keeps everything this extension controls in one dedicated place rather
  // than scattered among the site's own toggles. ----
  //
  // Camera/control settings are all off by default, and all require a
  // reload to actually take effect — each one backs a flag srv-main.js
  // reads once from localStorage at document_start, before the patched
  // bundle's own module code (and so before anything the flag gates could
  // ever run) executes.
  const DRIVING_SETTINGS = [
    {
      key: "srv-no-pointer-lock",
      label: "Don't grab cursor",
      onLabel: "Cursor grab disabled",
      offLabel: "Cursor grab re-enabled",
    },
    {
      key: "srv-enable-reverse-cam",
      label: "Reverse cam on C",
      onLabel: "Reverse cam added to the C cycle",
      offLabel: "Reverse cam removed from the C cycle",
    },
    {
      key: "srv-disable-freecam",
      label: "Disable freecam",
      onLabel: "Freecam removed from the C cycle",
      offLabel: "Freecam restored to the C cycle",
    },
  ];

  // Master show/hide switches for each HUD element this extension adds.
  // Checked = visible (the localStorage value stores the opposite — whether
  // it's HIDDEN — so an unset/missing key defaults to visible). Enforced via
  // an `html.<key>` class + matching `display:none!important` rule in
  // styles.css rather than toggling `style.display` directly, since several
  // of these elements have their OWN display-toggling logic running
  // constantly (e.g. the gear HUD flips visible/hidden every tick) that
  // would otherwise fight a plain inline-style override.
  const HUD_TOGGLES = [
    { key: "srv-hide-leaderboard", label: "Leaderboard" },
    { key: "srv-hide-splits", label: "Splits vs PB" },
    { key: "srv-hide-input-analysis", label: "Input analysis panel" },
    { key: "srv-hide-watch-controls", label: "Watch controls (input keys, scrub bar, stop-watching bar)" },
    { key: "srv-hide-own-input-hud", label: "Live input keys (your own driving)" },
    { key: "srv-hide-gear-hud", label: "Gear shift HUD" },
    // Gate/checkpoint markers live in srv-main.js (the MAIN-world script),
    // which only reads localStorage once at document_start like the
    // camera/control settings above — so, unlike the rest of this list,
    // toggling this one needs a reload to actually apply.
    { key: "srv-hide-gate-markers", label: "Checkpoint number markers", reloadRequired: true },
  ];

  function applyHudVisibilityClasses() {
    for (const t of HUD_TOGGLES) {
      document.documentElement.classList.toggle(t.key, localStorage.getItem(t.key) === "true");
    }
  }

  function buildToggleRow(wrap, { key, label, onLabel, offLabel, reloadRequired }, { storageValueMeansHidden } = {}) {
    const row = document.createElement("label");
    row.className = "srv-setting-label";
    row.innerHTML = `<span>${escapeHtml(label)}</span><input type="checkbox" />`;
    const input = row.querySelector("input");
    const stored = localStorage.getItem(key) === "true";
    input.checked = storageValueMeansHidden ? !stored : stored;
    input.addEventListener("change", () => {
      const rawValue = storageValueMeansHidden ? !input.checked : input.checked;
      localStorage.setItem(key, rawValue ? "true" : "false");
      if (storageValueMeansHidden) {
        document.documentElement.classList.toggle(key, rawValue);
        if (reloadRequired) {
          showToast(`${label} ${rawValue ? "hidden" : "shown"} — reload the page for it to apply.`);
        }
      } else {
        showToast(`${input.checked ? onLabel : offLabel} — reload the page for it to apply.`);
      }
    });
    wrap.appendChild(row);
  }

  let utilsOverlayEl = null;

  function buildUtilsMenu() {
    if (utilsOverlayEl) return utilsOverlayEl;
    const overlay = document.createElement("div");
    overlay.className = "srv-utils-overlay";
    overlay.style.display = "none";
    overlay.innerHTML = `
      <div class="srv-utils-panel">
        <div class="srv-utils-header">
          <strong>Swervle Utils</strong>
          <button class="srv-utils-close" type="button" title="Close">&times;</button>
        </div>
        <div class="srv-utils-section">
          <div class="srv-utils-section-title">HUD ELEMENTS</div>
          <div class="srv-utils-hud-toggles"></div>
        </div>
        <div class="srv-utils-section">
          <div class="srv-utils-section-title">CAMERA &amp; CONTROLS</div>
          <div class="srv-utils-driving-toggles"></div>
        </div>
        <button type="button" class="srv-btn srv-utils-hud-editor-btn">Open HUD Editor</button>
        <div class="srv-utils-hint">Some settings need a page reload to take effect.</div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeUtilsMenu();
    });
    overlay.querySelector(".srv-utils-close").addEventListener("click", closeUtilsMenu);

    const hudWrap = overlay.querySelector(".srv-utils-hud-toggles");
    for (const t of HUD_TOGGLES) buildToggleRow(hudWrap, t, { storageValueMeansHidden: true });

    const drivingWrap = overlay.querySelector(".srv-utils-driving-toggles");
    for (const setting of DRIVING_SETTINGS) buildToggleRow(drivingWrap, setting);

    overlay.querySelector(".srv-utils-hud-editor-btn").addEventListener("click", () => {
      closeUtilsMenu();
      openHudEditor();
    });

    utilsOverlayEl = overlay;
    return overlay;
  }

  function openUtilsMenu() {
    buildUtilsMenu().style.display = "flex";
  }

  function closeUtilsMenu() {
    if (utilsOverlayEl) utilsOverlayEl.style.display = "none";
  }

  function injectUtilsButton() {
    // The site's own settings modal — a plain dialog, not a <section>; its
    // structure (and this selector) changed since this extension was first
    // written, which was silently making the old per-toggle injector a
    // no-op.
    const card = document.querySelector(".settings-card");
    if (!card || card.querySelector(".srv-open-utils-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "srv-open-utils-btn";
    btn.textContent = "Swervle Utils";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openUtilsMenu();
    });
    card.appendChild(btn);
  }

  // ---- HUD layout persistence (drag position + scroll-wheel resize from
  // the HUD editor below) — a plain {left, top, scale} per element, applied
  // as inline styles that fully override that element's own stylesheet
  // positioning (see setHudFixedRect). Shared with splits.js via
  // window.SwervleHudLayout, since that panel is built by a separate
  // content script with no access to these closures. ----

  function hudLayoutStorageKey(key) {
    return `srv-hud-layout-${key}`;
  }

  function loadHudLayout(key) {
    try {
      const raw = localStorage.getItem(hudLayoutStorageKey(key));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getHudScale(el) {
    const m = /scale\(([\d.]+)\)/.exec(el.style.transform || "");
    return m ? parseFloat(m[1]) : 1;
  }

  // Pins the element to an explicit pixel top-left corner, defeating
  // whatever combination of left/right/top/bottom its own stylesheet class
  // declares (e.g. .srv-splits anchors via `right`, .srv-spectate-hud via a
  // centering `left:50%` + transform) — setting the OPPOSITE edges to
  // "auto" rather than leaving them alone is what actually wins the
  // browser's own over-constrained-box resolution, not just clearing an
  // inline value that was never set in the first place.
  //
  // Also reparents straight to <body> first. `position:fixed` is only
  // actually fixed to the viewport if every ancestor is free of transform/
  // filter/perspective/contain/will-change — any one of those on an
  // ancestor quietly makes IT the containing block instead, so the same
  // literal left/top numbers land somewhere completely different. This
  // bit us for real: a Swervle redeploy (unrelated to anything patched
  // here) apparently added exactly that to something above the native
  // checkpoint/speed cards, which sent their saved custom positions flying
  // off-screen even though the stored numbers themselves were still
  // correct. Elements this module already builds are already direct body
  // children (so this is a no-op for them), but native elements it merely
  // takes over — anything outside this extension's own DOM — get the same
  // guarantee, regardless of what ancestor styling Swervle ships next.
  // Remembers where a reparented element actually came from (parent +
  // next-sibling, to reinsert at the same spot) so resetHudLayout can put
  // native elements — anything with a real, Swervle-authored layout to
  // restore — back where they belong instead of leaving them stranded as a
  // loose body child once their custom position is cleared. Never touched
  // for elements this module builds itself (already body children, so
  // setHudFixedRect never reparents them in the first place).
  const hudOriginalParents = new WeakMap(); // el -> { parent, nextSibling }

  function setHudFixedRect(el, left, top) {
    if (el.parentElement !== document.body) {
      if (!hudOriginalParents.has(el)) {
        hudOriginalParents.set(el, { parent: el.parentElement, nextSibling: el.nextSibling });
      }
      document.body.appendChild(el);
    }
    el.style.position = "fixed";
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  function saveHudLayout(key, el) {
    const left = parseFloat(el.style.left) || 0;
    const top = parseFloat(el.style.top) || 0;
    localStorage.setItem(hudLayoutStorageKey(key), JSON.stringify({ left, top, scale: getHudScale(el) }));
  }

  // Returns whether a stored layout actually existed and was applied —
  // callers with their own recurring auto-position logic (e.g. splits.js's
  // popup, which otherwise re-docks itself under the timer every 500ms) use
  // this to skip that logic entirely once the user has moved it manually.
  function applyHudLayout(key, el) {
    if (!el) return false;
    const layout = loadHudLayout(key);
    if (!layout) return false;
    setHudFixedRect(el, layout.left, layout.top);
    el.style.transformOrigin = "top left";
    el.style.transform = layout.scale && layout.scale !== 1 ? `scale(${layout.scale})` : "none";
    return true;
  }

  // Clears every inline override this module ever sets, letting the
  // element's own stylesheet rule (default position, and — for
  // .srv-spectate-hud specifically — its centering transform) take over
  // again exactly as if it had never been touched. For a native element
  // setHudFixedRect reparented to <body>, also moves it back to its real
  // original spot in Swervle's own layout first — its default appearance
  // often depends on being a flex/grid child there, not just on CSS that
  // still applies wherever it happens to sit in the DOM.
  function resetHudLayout(key, el) {
    localStorage.removeItem(hudLayoutStorageKey(key));
    if (!el) return;
    const original = hudOriginalParents.get(el);
    if (original?.parent) {
      try {
        original.parent.insertBefore(el, original.nextSibling);
      } catch {
        // The remembered next-sibling is no longer in that parent (e.g. the
        // site re-rendered around it) — appending is still correct for a
        // flex/grid layout, just not necessarily at the exact original index.
        original.parent.appendChild(el);
      }
      hudOriginalParents.delete(el);
    }
    for (const prop of ["position", "left", "top", "right", "bottom", "transform", "transformOrigin"]) {
      el.style[prop] = "";
    }
  }

  window.SwervleHudLayout = { apply: applyHudLayout };

  // Crystallizes an element's CURRENT on-screen box into an explicit
  // {left, top} (with any existing transform collapsed to "none" first) so
  // dragging/resizing from here on is a simple delta-add, regardless of
  // whether the element started out anchored via left, right, or a
  // centering transform. A no-op in favor of the real stored layout when
  // one already exists (e.g. re-opening the editor after a previous edit).
  function normalizeHudPosition(key, el) {
    const stored = loadHudLayout(key);
    if (stored) {
      applyHudLayout(key, el);
      return;
    }
    const r = el.getBoundingClientRect();
    setHudFixedRect(el, Math.round(r.left), Math.round(r.top));
    el.style.transform = "none";
    el.style.transformOrigin = "top left";
  }

  // ---- HUD editor: drag-to-move, scroll-to-resize, shift-click-to-reset
  // overlay for every currently-enabled (not hidden via the toggles above)
  // HUD element. Elements that wouldn't normally be on screen right now
  // (e.g. the watch-mode controls, outside of actually watching a replay)
  // are force-built and force-shown for the duration of editing, then
  // restored to whatever display state they'd naturally be in once the
  // editor closes — editing one's position doesn't require reproducing the
  // exact in-game situation it normally appears in. ----
  const HUD_EDIT_TARGETS = [
    {
      key: "leaderboard",
      label: "Leaderboard",
      hideKey: "srv-hide-leaderboard",
      ensure: () => buildBoard(),
      el: () => document.querySelector(".srv-board"),
    },
    {
      key: "splits",
      label: "Splits vs PB",
      hideKey: "srv-hide-splits",
      ensure: () => window.SwervleSplits?.init(),
      el: () => document.querySelector(".srv-splits"),
    },
    {
      key: "input-analysis",
      label: "Input analysis panel",
      hideKey: "srv-hide-input-analysis",
      ensure: () => buildInputAnalysisPanel(),
      el: () => document.querySelector(".srv-input-analysis"),
    },
    {
      key: "watch-controls",
      label: "Watch controls",
      hideKey: "srv-hide-watch-controls",
      ensure: () => {
        buildSpectateHud();
        buildInputHud();
        buildReplayScrub();
        buildActiveGhostBar();
      },
      el: () => document.querySelector(".srv-spectate-hud"),
      children: () => [".srv-input-hud", ".srv-replay-scrub", ".srv-ghost-bar"].map((s) => document.querySelector(s)).filter(Boolean),
    },
    {
      key: "gear-hud",
      label: "Gear shift HUD",
      hideKey: "srv-hide-gear-hud",
      ensure: () => buildGearHud(),
      el: () => document.querySelector(".srv-gear-hud"),
      forceDisplay: "flex", // .srv-gear-hud's own class defaults to display:none — it's normally shown by inline override only while actually racing
    },
    // The site's own native HUD cards — not something this extension builds
    // or can hide (no hideKey), but still just plain DOM elements, so the
    // same drag/resize/reset machinery works on them unmodified. Their
    // shared ancestor (.race-hud) is toggled via a `hidden` attribute rather
    // than a display style, and can be absent from the DOM entirely before
    // a track's race view has ever been constructed this session.
    {
      key: "checkpoint-counter",
      label: "Checkpoint counter",
      el: () => document.querySelector(".race-hud .checkpoint-card"),
      ancestor: () => document.querySelector(".race-hud"),
    },
    {
      key: "speed-counter",
      label: "Speed counter",
      el: () => document.querySelector(".race-hud .speed-card"),
      ancestor: () => document.querySelector(".race-hud"),
    },
    {
      key: "own-input-hud",
      label: "Live input keys",
      hideKey: "srv-hide-own-input-hud",
      ensure: () => buildOwnInputHud(),
      el: () => document.querySelector(".srv-own-input-hud"),
      forceDisplay: "grid", // its own class defaults to display:none — normally shown by inline override only while actually racing
    },
    {
      key: "split-popup",
      label: "Split delta popup",
      ensure: () => window.SwervleSplits?.init(),
      el: () => document.querySelector(".srv-split-popup"),
      // This one's shown/hidden via an opacity-transitioning class, not
      // display, so it needs its own force-visible mechanism (see
      // openHudEditor/closeHudEditor) rather than the forceDisplay path.
      forceVisibleClass: "srv-visible",
      // Has no static CSS default position at all (see attachHudDragResize)
      // — after clearing a custom layout, ask splits.js to recompute its
      // real dock-under-the-timer position before that gets crystallized
      // as the new "default", instead of reading whatever a bare
      // position:fixed with every inset auto happens to resolve to.
      recomputeDefault: (el) => window.SwervleSplits?.forceReposition?.(),
      // Empty outside of the ~2.6s right after actually crossing a
      // checkpoint — showPopup() only fills its innerHTML then — so without
      // sample content it renders as a collapsed sliver with nothing to see
      // or grab a meaningful handle around. Injected only if it's genuinely
      // empty (never stomps real content mid-race), and removed again on
      // close rather than left sitting behind the real thing.
      preview: (el) => {
        if (el.innerHTML.trim() !== "") return null;
        el.innerHTML = `
          <div class="srv-popup-row srv-popup-cp">CHECKPOINT 1</div>
          <div class="srv-popup-row srv-popup-delta srv-split-ahead">-0.42s</div>
          <div class="srv-popup-row srv-popup-speed">+1.3 spd</div>
        `;
        return () => {
          el.innerHTML = "";
        };
      },
    },
  ];

  let hudEditorState = null; // { overlay, handles: [{el, handle, origDisplay, origChildDisplays}], reposition }

  function positionHandleOver(handle, el) {
    const r = el.getBoundingClientRect();
    Object.assign(handle.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function attachHudDragResize(handle, el, entry) {
    const key = entry.key;
    handle.addEventListener("pointerdown", (e) => {
      if (e.shiftKey) {
        resetHudLayout(key, el);
        // For most elements the stylesheet itself defines a real default
        // position, so simply clearing the inline overrides above is
        // enough — the next line's rect read already reflects it. A few
        // (the split popup) have no static CSS position at all, only ever
        // set dynamically by their own JS controller — those supply this
        // hook to recompute that default BEFORE it's crystallized, or the
        // element would land wherever a bare `position:fixed` with every
        // inset auto happens to resolve to (often off-screen).
        entry.recomputeDefault?.(el);
        normalizeHudPosition(key, el);
        positionHandleOver(handle, el);
        return;
      }
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = parseFloat(el.style.left) || 0;
      const startTop = parseFloat(el.style.top) || 0;
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const newLeft = Math.max(0, Math.min(window.innerWidth - 24, startLeft + (ev.clientX - startX)));
        const newTop = Math.max(0, Math.min(window.innerHeight - 24, startTop + (ev.clientY - startY)));
        el.style.left = `${newLeft}px`;
        el.style.top = `${newTop}px`;
        positionHandleOver(handle, el);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        saveHudLayout(key, el);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });

    handle.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const next = Math.max(0.5, Math.min(2.5, getHudScale(el) + (e.deltaY < 0 ? 0.05 : -0.05)));
        el.style.transformOrigin = "top left";
        el.style.transform = next === 1 ? "none" : `scale(${next.toFixed(2)})`;
        positionHandleOver(handle, el);
        saveHudLayout(key, el);
      },
      { passive: false }
    );
  }

  function openHudEditor() {
    if (hudEditorState) return;
    // Some elements have their own recurring auto-position logic outside
    // this file (splits.js's positionPopup runs every 500ms) that would
    // otherwise fight normalizeHudPosition's one-time layout crystallizing
    // below — never actually persisted via saveHudLayout unless the user
    // drags/resizes, so a later un-related timer tick would just clobber it
    // mid-edit. This flag tells that code to stand down for as long as the
    // editor is open.
    window.SwervleHudEditorActive = true;
    const overlay = document.createElement("div");
    overlay.className = "srv-hud-editor-overlay";
    overlay.innerHTML = `
      <div class="srv-hud-editor-toolbar">
        <strong>HUD Editor</strong>
        <span class="srv-hud-editor-hint">Drag to move · scroll to resize · shift-click to reset</span>
        <button type="button" class="srv-btn srv-hud-editor-done">Done</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector(".srv-hud-editor-done").addEventListener("click", closeHudEditor);

    const handles = [];
    for (const entry of HUD_EDIT_TARGETS) {
      if (entry.hideKey && localStorage.getItem(entry.hideKey) === "true") continue; // not enabled — nothing to edit
      entry.ensure?.();

      // Some elements (the site's own native HUD cards) live inside an
      // ancestor that's hidden via a `hidden` attribute rather than a
      // display style whenever no race is active — reveal it for editing
      // and remember to put it back exactly as found.
      const ancestor = entry.ancestor?.();
      const wasHidden = !!ancestor?.hidden;
      if (wasHidden) ancestor.hidden = false;

      const el = entry.el();
      if (!el) {
        if (wasHidden) ancestor.hidden = true;
        continue;
      }

      const ancestorRestore = wasHidden
        ? () => {
            ancestor.hidden = true;
          }
        : null;

      const restorePreview = entry.preview?.(el);

      // Two different visibility mechanisms exist across these elements:
      // most toggle a plain `display` style, but the split popup toggles an
      // opacity-transitioning class instead (see .srv-split-popup) — each
      // gets forced visible its own way, with a matching restore function.
      let restoreVisibility;
      if (entry.forceVisibleClass) {
        const hadClass = el.classList.contains(entry.forceVisibleClass);
        el.classList.add(entry.forceVisibleClass);
        restoreVisibility = () => {
          if (!hadClass) el.classList.remove(entry.forceVisibleClass);
        };
      } else {
        const origDisplay = el.style.display;
        el.style.display = entry.forceDisplay ?? "";
        restoreVisibility = () => {
          el.style.display = origDisplay;
        };
      }

      let origChildDisplays = null;
      if (entry.children) {
        origChildDisplays = entry.children().map((c) => [c, c.style.display]);
        for (const [c] of origChildDisplays) c.style.display = "";
      }

      normalizeHudPosition(entry.key, el);
      // normalizeHudPosition (via setHudFixedRect) may have just reparented
      // a native element straight to <body> — from that point on, its
      // ancestor's `hidden` attribute no longer hides it on its own, so
      // this keeps its own display in sync for as long as it stays there
      // (idempotent — a no-op if already mirrored, e.g. from a previous
      // editor session or applyNativeHudLayouts).
      if (ancestor && !ancestor.contains(el)) mirrorAncestorHiddenState(el, ancestor);

      const handle = document.createElement("div");
      handle.className = "srv-hud-editor-handle";
      handle.innerHTML = `<span class="srv-hud-editor-handle-label">${escapeHtml(entry.label)}</span>`;
      overlay.appendChild(handle);
      positionHandleOver(handle, el);
      attachHudDragResize(handle, el, entry);

      handles.push({ el, handle, origChildDisplays, ancestorRestore, restoreVisibility, restorePreview });
    }

    const reposition = () => handles.forEach((h) => positionHandleOver(h.handle, h.el));
    window.addEventListener("resize", reposition);

    hudEditorState = { overlay, handles, reposition };
  }

  function closeHudEditor() {
    if (!hudEditorState) return;
    for (const { origChildDisplays, ancestorRestore, restoreVisibility, restorePreview } of hudEditorState.handles) {
      restoreVisibility();
      ancestorRestore?.();
      restorePreview?.();
      if (origChildDisplays) {
        for (const [c, d] of origChildDisplays) c.style.display = d;
      }
    }
    window.removeEventListener("resize", hudEditorState.reposition);
    hudEditorState.overlay.remove();
    hudEditorState = null;
    window.SwervleHudEditorActive = false;
  }

  // ---- hide the board/splits panels during the map-loading screen ----
  // The site tracks its own screen as `data-game-state` on the game root
  // (`loading`, `ready`, `disposed`, `error`, `unsupported`). "ready" covers
  // both actively racing *and* the pause menu (which is just a dialog
  // layered on top of that same state) — only "loading" (and the
  // disposed/error/unsupported edge states) should hide our panels.
  function updatePanelVisibility() {
    if (hudEditorState) return; // don't fight the editor's forced display while it's open
    const gameEl = document.querySelector("[data-game-state]");
    const hide = !!gameEl && gameEl.dataset.gameState !== "ready";
    if (boardEl) boardEl.style.display = hide ? "none" : "";
    const splitsEl = document.querySelector(".srv-splits");
    if (splitsEl) splitsEl.style.display = hide ? "none" : "";
  }

  // The two native cards' stored drag/resize layout has no builder function
  // of ours to hook (they're constructed once by the site's own RaceUI
  // code, not by content.js) — reapplied here instead, at init and again
  // whenever .race-hud shows up later via the mutation observer below, in
  // case that construction happens after this script's first pass.
  const NATIVE_HUD_LAYOUT_TARGETS = [
    { key: "checkpoint-counter", selector: ".race-hud .checkpoint-card", ancestorSelector: ".race-hud" },
    { key: "speed-counter", selector: ".race-hud .speed-card", ancestorSelector: ".race-hud" },
  ];

  // A custom layout reparents these to <body> (see setHudFixedRect) so
  // position:fixed is reliably viewport-relative — but that also detaches
  // them from .race-hud's own `hidden` attribute, which is otherwise the
  // ONLY thing that hides them outside of an active race. Without this,
  // a customized checkpoint/speed counter would show permanently, even on
  // the menu or pause screen. Mirrors that attribute onto the element's own
  // display instead, so the customized version keeps the exact same
  // show/hide behavior as the native one it replaced.
  const hudVisibilityMirrored = new WeakSet();
  function mirrorAncestorHiddenState(el, ancestor) {
    if (hudVisibilityMirrored.has(el)) return;
    hudVisibilityMirrored.add(el);
    const sync = () => {
      el.style.display = ancestor.hidden ? "none" : "";
    };
    sync();
    new MutationObserver(sync).observe(ancestor, { attributes: true, attributeFilter: ["hidden"] });
  }

  function applyNativeHudLayouts() {
    for (const { key, selector, ancestorSelector } of NATIVE_HUD_LAYOUT_TARGETS) {
      const el = document.querySelector(selector);
      if (!applyHudLayout(key, el)) continue; // no custom layout — leave it exactly as Swervle put it
      const ancestor = ancestorSelector && document.querySelector(ancestorSelector);
      if (ancestor && !ancestor.contains(el)) mirrorAncestorHiddenState(el, ancestor);
    }
  }

  // Reports the live page's actual entry-script filename to background.js
  // (see that file's top comment) — it has no way to see the page's DOM
  // itself, and srv-main.js (which does share the page's own `window`) has
  // no chrome.runtime access to report anything, so this isolated-world
  // content script is the only piece able to bridge the two. background.js
  // replies with whether its currently-registered patch was already stale
  // by the time THIS page loaded (in which case reloading — now, after it's
  // had a chance to re-patch for next time — is what actually fixes it).
  function reportPageLoadToBackground() {
    try {
      const liveMainFilename = document.querySelector('script[type="module"][src*="/assets/"]')?.src?.split("/").pop();
      if (!liveMainFilename) return;
      chrome.runtime.sendMessage({ type: "srv:pageLoaded", liveMainFilename }, (response) => {
        if (chrome.runtime.lastError || !response?.staleOnLoad) return;
        // Persistent, not the usual auto-dismissing toast: this can break
        // almost anything unpredictably (past examples: ghosts, splits,
        // checkpoint markers, even unrelated-looking things like Restart
        // silently failing) — a toast that quietly disappears after 6
        // seconds defeats the entire point of surfacing it. Deliberately
        // just a plain "refresh" instruction rather than auto-reloading:
        // simpler, and never risks reloading out from under the player at
        // a bad moment.
        showToast("Swervle Utils is outdated for this page — please refresh.", true, true);
      });
    } catch {}
  }

  function init() {
    reportPageLoadToBackground();
    applyHudVisibilityClasses();
    buildBoard();
    buildActiveGhostBar();
    buildInputHud();
    buildReplayScrub();
    buildGearHud();
    buildOwnInputHud();
    window.SwervleSplits?.init();
    loadBoard();
    scanForLeaderboard(document);
    scanForMenuBoard(document);
    scanForAttemptRows(document);
    injectUtilsButton();
    applyNativeHudLayouts();
    updatePanelVisibility();
    setInterval(updatePanelVisibility, 400);
    // No longer skips during "racing"/"countdown" — see withPauseSuppressed
    // above, which is what actually makes updating live during a run safe
    // now, rather than this interval avoiding the risky time entirely.
    setInterval(loadBoard, AUTO_REFRESH_MS);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('[data-slot="result-board"]') || node.querySelector?.('[data-slot="result-board"]')) {
            scanForLeaderboard(node);
            loadBoard();
          }
          if (node.matches?.('[data-slot="menu-board"]') || node.querySelector?.('[data-slot="menu-board"]')) {
            scanForMenuBoard(node);
          }
          if (node.matches?.(".settings-card") || node.querySelector?.(".settings-card")) {
            injectUtilsButton();
          }
          if (node.matches?.(".race-hud") || node.querySelector?.(".race-hud")) {
            applyNativeHudLayouts();
          }
          // The native "LEADERBOARD" screen (pause menu) — a row's attempt
          // list is only rendered into the DOM once that row is expanded,
          // and the whole rows list gets re-rendered from scratch on every
          // subsequent state change (search/scope/page), which wipes any
          // buttons injected into it — so this has to re-scan on every
          // addition, not just the first time the screen itself appears.
          if (node.matches?.(".board-attempt-rows") || node.querySelector?.(".board-attempt-rows")) {
            scanForAttemptRows(node);
          }
        }
        if (m.target.closest?.('[data-slot="result-board"]')) {
          scanForLeaderboard(document);
        }
        if (m.target.closest?.('[data-slot="menu-board"]')) {
          scanForMenuBoard(document);
        }
        if (m.target.closest?.(".board-attempt-rows")) {
          scanForAttemptRows(document);
        }
        if (m.type === "attributes") updatePanelVisibility();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-game-state"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
