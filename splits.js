// Live split/checkpoint ("gate") tracker: compares your current run against
// your PB gate-by-gate, in real time, using genuine simulated PB telemetry
// (computed by silently fast-forwarding your PB's real recorded inputs
// through the site's own physics via srv-main.js) — not an approximation.
// Requires the live hooks (see tools/patch-bundle.mjs); shows a clear
// "unavailable" state when they aren't present instead of guessing.
//
// Two UI pieces:
//  - a permanent panel on the right listing every split reached so far
//    (your time, delta vs PB, speed delta) — never trims old rows.
//  - a transient popup, styled like the site's own big in-game timer and
//    docked directly under it, that flashes the delta for a few seconds
//    right as you cross each checkpoint.
(function () {
  const TICK_RATE = 60; // see README: only confirmed assumption, not measured
  const POPUP_VISIBLE_MS = 2600;

  let panelEl, listEl;
  let popupEl, popupTimeout;
  let pbGates = null; // [{gateIndex, tick, speed}] or null
  let pbTotalTicks = null; // the PB's finish tick — the last row ("Finish")
  let currentDailyId = null; // scopes the stored best segments to one map
  let bestSegs = []; // best (lowest) segment ticks ever seen on this map, by row index
  let lastGateCount = 0; // from live telemetry — row count before a PB is known
  let pbDisplayName = "";
  let liveRows = []; // [{gateIndex, tick, speed, deltaTicks, deltaSpeed}]
  let lastSeenTick = -1;
  let unsubscribeTick = null;
  let pendingPbRunId = null;

  // See content.js's withPauseSuppressed for the full story — the site's
  // pause menu can trigger off our own DOM writes while driving, and this
  // panel's writes (render()/showPopup()) happen constantly mid-race (every
  // checkpoint), making them at least as likely a culprit as the
  // leaderboard's. Duplicated here rather than imported from content.js
  // since these are two independently-loaded content scripts with no
  // shared module scope — it's just two CustomEvent dispatches either way.
  function withPauseSuppressed(fn) {
    document.dispatchEvent(new CustomEvent("srv:suppressPause", { detail: window.SwervleToPage({ suppress: true }) }));
    try {
      fn();
    } finally {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document.dispatchEvent(new CustomEvent("srv:suppressPause", { detail: window.SwervleToPage({ suppress: false }) }))
        )
      );
    }
  }

  function fmtTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(3).padStart(6, "0");
    return `${m}:${s}`;
  }

  function fmtDeltaTicks(deltaTicks) {
    const sign = deltaTicks <= 0 ? "-" : "+";
    const sec = Math.abs(deltaTicks) / TICK_RATE;
    return `${sign}${sec.toFixed(3)}s`;
  }

  function build() {
    if (document.querySelector(".srv-splits")) return;

    panelEl = document.createElement("div");
    panelEl.className = "srv-splits";
    window.SwervleSetHtml(panelEl, `
      <div class="srv-splits-header">
        <span class="srv-splits-title">SPLITS vs PB</span>
        <button class="srv-splits-collapse" title="Collapse">—</button>
      </div>
      <div class="srv-split-cols"><span>SEGMENT</span><span>PB</span><span>YOU</span></div>
      <div class="srv-splits-list"></div>
    `);
    document.body.appendChild(panelEl);
    window.SwervleHudLayout?.apply("splits", panelEl);
    listEl = panelEl.querySelector(".srv-splits-list");
    panelEl.querySelector(".srv-splits-collapse").addEventListener("click", (e) => {
      panelEl.classList.toggle("srv-collapsed");
      e.target.textContent = panelEl.classList.contains("srv-collapsed") ? "+" : "—";
    });

    popupEl = document.createElement("div");
    popupEl.className = "srv-split-popup";
    document.body.appendChild(popupEl);
    positionPopup();
    window.addEventListener("resize", positionPopup);
    setInterval(positionPopup, 500);

    unsubscribeTick = window.SwervleBridge.onTick(onTick);
    render();
  }

  // ---- your PB's splits, recorded from your own finished runs (per map) ----
  // Saved the same way as the best segments, so the panel doesn't depend on
  // recomputing the PB from its replay (which needs a game hook that
  // swervle updates can break). Only runs made with the extension count.
  let usingLocalPb = false;
  const pbKey = () => `srv-pb-splits:${currentDailyId}`;
  function loadLocalPb() {
    try {
      const v = JSON.parse(localStorage.getItem(pbKey()) || "null");
      return v && Array.isArray(v.gates) && Number.isFinite(v.totalTicks) ? v : null;
    } catch {
      return null;
    }
  }
  function applyLocalPb() {
    const v = currentDailyId ? loadLocalPb() : null;
    if (!v) return false;
    pbGates = v.gates;
    pbTotalTicks = v.totalTicks;
    usingLocalPb = true;
    seedBestFromPb();
    render();
    return true;
  }
  // Called once a run has finished: keeps it if it beats the saved PB.
  function saveLocalPbIfBetter() {
    if (!currentDailyId) return;
    const n = rowCount();
    if (n === 0 || liveRows.length !== n) return;
    const total = liveRows[n - 1].tick;
    const saved = loadLocalPb();
    if (saved && saved.totalTicks <= total) return;
    const gates = liveRows.map((r) => ({ gateIndex: r.gateIndex, tick: r.tick, speed: r.speed, timeMs: r.timeMs ?? null }));
    try {
      localStorage.setItem(pbKey(), JSON.stringify({ gates, totalTicks: total }));
    } catch {}
  }
  // Your PB is a real run of yours, so its segments count toward "best".
  function seedBestFromPb() {
    for (let i = 0; i < rowCount(); i++) {
      const seg = segTicks(pbTickAt, i);
      if (seg != null && (bestSegs[i] == null || seg < bestSegs[i])) bestSegs[i] = seg;
    }
    if (currentDailyId) saveBestSegs();
  }

  // ---- best segments (gold), persisted per map ----
  const bestKey = () => `srv-best-segments:${currentDailyId}`;
  function loadBestSegs() {
    try {
      const v = JSON.parse(localStorage.getItem(bestKey()) || "[]");
      bestSegs = Array.isArray(v) ? v : [];
    } catch {
      bestSegs = [];
    }
  }
  function saveBestSegs() {
    try {
      localStorage.setItem(bestKey(), JSON.stringify(bestSegs));
    } catch {}
  }
  // Cumulative PB tick for a row (the last row is the finish), or null.
  function pbTickAt(i) {
    if (!pbGates) return null;
    return pbGates.find((g) => g.gateIndex === i)?.tick ?? null;
  }
  function segTicks(cumAt, i) {
    const cur = cumAt(i);
    if (cur == null) return null;
    const prev = i === 0 ? 0 : cumAt(i - 1);
    return prev == null ? null : cur - prev;
  }
  // The track's gates already include the finish gate (the last one), so
  // that is exactly how many rows there are.
  function rowCount() {
    return pbGates ? pbGates.length : lastGateCount;
  }
  const isFinishRow = (i) => i === rowCount() - 1;

  // Docks the transient popup directly below the site's own real HUD timer
  // (`.hud-timer` inside `.race-hud`) so it reads as an extension of it —
  // unless the HUD editor (content.js) has a custom position stored for it,
  // in which case that wins permanently instead of being re-docked back
  // under the timer the next time this runs (every 500ms, on resize, and
  // once at build()).
  function positionPopup(force) {
    if (!popupEl) return;
    if (window.SwervleHudEditorActive && !force) return; // being dragged/resized directly right now — don't fight it
    if (!force && window.SwervleHudLayout?.apply("split-popup", popupEl)) return;
    const timer = document.querySelector(".race-hud .hud-timer") || document.querySelector(".hud-timer");
    if (timer) {
      const r = timer.getBoundingClientRect();
      popupEl.style.top = `${Math.round(r.bottom + 12)}px`;
      popupEl.style.left = `${Math.round(r.left + r.width / 2)}px`;
    } else {
      popupEl.style.top = "170px";
      popupEl.style.left = "50%";
    }
  }

  function showPopup(gateIndex, deltaTicks, deltaSpeed) {
    if (!popupEl) return;
    const behind = deltaTicks > 0;
    window.SwervleSetHtml(popupEl, `
      <div class="srv-popup-row srv-popup-cp">${isFinishRow(gateIndex) ? "FINISH" : `CHECKPOINT ${gateIndex + 1}`}</div>
      <div class="srv-popup-row srv-popup-delta ${behind ? "srv-split-behind" : "srv-split-ahead"}">${fmtDeltaTicks(deltaTicks)}</div>
      <div class="srv-popup-row srv-popup-speed">${deltaSpeed >= 0 ? "+" : ""}${deltaSpeed.toFixed(1)} spd</div>
    `);
    popupEl.classList.add("srv-visible");
    clearTimeout(popupTimeout);
    popupTimeout = setTimeout(() => popupEl.classList.remove("srv-visible"), POPUP_VISIBLE_MS);
  }

  // No longer shown in the UI (the panel has no description text anymore),
  // but still useful in the console when diagnosing why splits aren't
  // appearing (no PB, hooks unavailable, PB calculation failed, etc.).
  function setStatus(text) {
    console.log("[Swervle Replay Viewer] splits:", text);
  }

  async function loadPb(pbRunId, displayName, dailyId) {
    if (dailyId && dailyId !== currentDailyId) {
      currentDailyId = dailyId;
      loadBestSegs();
      render();
    }
    const loadKey = `${currentDailyId}|${pbRunId}`;
    if (pendingPbRunId === loadKey) return;
    pendingPbRunId = loadKey;
    pbGates = null;
    pbTotalTicks = null;
    render();
    pbDisplayName = displayName || "your PB";

    // Computing the PB from its replay is the accurate source when it works;
    // your own saved run is the fallback (no PB yet / hooks unavailable / the
    // computation returns nothing after a swervle update).
    usingLocalPb = false;
    if (!pbRunId) {
      setStatus("No PB set for today — using your saved run, if any.");
      applyLocalPb();
      return;
    }

    const hooks = await window.SwervleBridge.checkHooks();
    if (!hooks.available) {
      setStatus("Live split tracker needs the in-game hooks — start (or restart) a race first.");
      applyLocalPb();
      return;
    }

    setStatus(`Calculating ${pbDisplayName}'s splits…`);
    try {
      const ghost = await window.SwervleAPI.getGhost(pbRunId);
      const states = window.SwervleDecoder.decodeStatesBase64(ghost.statesBase64);
      const result = await window.SwervleBridge.computeSplits(states);
      if (result.error) throw new Error(result.error);
      if (!result.gates?.length) throw new Error("no checkpoints reported");
      pbGates = result.gates;
      pbTotalTicks = result.totalTicks;
      seedBestFromPb();
      render();
      setStatus(`Racing? Live splits vs ${pbDisplayName} will appear below.`);
    } catch (err) {
      console.error("[Swervle Replay Viewer] failed to compute PB splits", err);
      setStatus(`Couldn't calculate PB splits (${err.message}) — using your saved run, if any.`);
      applyLocalPb();
    }
  }

  function onTick(telemetry) {
    if (!panelEl) return;
    // A fresh race started (tick reset near zero) — clear the live table.
    if (telemetry.tick < lastSeenTick - 5) {
      liveRows = [];
      if (usingLocalPb) applyLocalPb(); // pick up a PB saved by the run that just ended
      render();
    }
    lastSeenTick = telemetry.tick;
    if (telemetry.gateCount > 0 && telemetry.gateCount !== lastGateCount) {
      lastGateCount = telemetry.gateCount;
      render();
    }

    const seenGateIndex = liveRows.length; // next gate we're expecting
    if (telemetry.nextGateIndex > seenGateIndex) {
      for (let g = seenGateIndex; g < telemetry.nextGateIndex; g++) {
        const pb = pbGates?.find((r) => r.gateIndex === g) ?? null;
        const deltaTicks = pb ? telemetry.tick - pb.tick : null;
        const deltaSpeed = pb ? telemetry.speed - pb.speed : null;
        // Only the finish carries an exact (sub-tick) time from the game.
        const timeMs = g === lastGateCount - 1 && Number.isFinite(telemetry.displayTimeMs) ? telemetry.displayTimeMs : null;
        liveRows.push({ gateIndex: g, tick: telemetry.tick, speed: telemetry.speed, timeMs, deltaTicks, deltaSpeed });
        if (pb) showPopup(g, deltaTicks, deltaSpeed);
        updateBest(liveRows.length - 1);
      }
      if (lastGateCount > 0 && liveRows.length === lastGateCount) saveLocalPbIfBetter();
      render();
    }
  }

  const liveCum = (i) => liveRows[i]?.tick ?? null;
  // Called once as each row's segment completes: colours it against the PB's
  // segment (red slower / green faster / gold faster than any earlier best on
  // this map — the PB's own segments are in bestSegs, so gold implies faster
  // than the PB too), then folds it into the stored bests. Gold is judged
  // BEFORE the update, otherwise every new best would compare against itself.
  function updateBest(i) {
    const seg = segTicks(liveCum, i);
    if (seg == null) return;
    const pbSeg = segTicks(pbTickAt, i);
    let cls = "";
    if (pbSeg != null) {
      if (seg > pbSeg) cls = "srv-split-behind";
      else if (bestSegs[i] != null && seg < bestSegs[i]) cls = "srv-split-gold";
      else if (seg < pbSeg) cls = "srv-split-ahead";
    }
    liveRows[i].cls = cls;
    if (bestSegs[i] == null || seg < bestSegs[i]) {
      bestSegs[i] = seg;
      if (currentDailyId) saveBestSegs();
    }
  }

  // Speedrun-timer layout: one row per checkpoint plus the finish, always
  // all shown. PB column = the PB's cumulative time at that point; YOU column
  // fills in as you cross each one, coloured by that segment's result.
  function render() {
    if (!listEl) return;
    const n = rowCount();
    let html = "";
    for (let i = 0; i < n; i++) {
      const label = i === n - 1 ? "Finish" : `CP ${i + 1}`;
      const pbTick = pbTickAt(i);
      const pbMs = pbGates?.find((g) => g.gateIndex === i)?.timeMs;
      const live = liveRows[i];
      const secs = (tick, ms) => (Number.isFinite(ms) ? ms / 1000 : tick / TICK_RATE);
      html += `
        <div class="srv-split-row">
          <span class="srv-split-gate">${label}</span>
          <span class="srv-split-pb">${pbTick != null ? fmtTime(secs(pbTick, pbMs)) : "—"}</span>
          <span class="srv-split-you ${live?.cls || ""}">${live ? fmtTime(secs(live.tick, live.timeMs)) : ""}</span>
        </div>`;
    }
    window.SwervleSetHtml(listEl, html);
  }

  window.SwervleSplits = {
    init() {
      build();
    },
    setPb(pbRunId, displayName, dailyId) {
      loadPb(pbRunId, displayName, dailyId);
    },
    // Used by content.js's HUD editor after a shift-click reset, to
    // recompute the popup's real dock-under-the-timer position (bypassing
    // both the "editor is open" and "custom layout exists" skips above)
    // before that gets crystallized as its new "default".
    forceReposition() {
      positionPopup(true);
    },
  };
})();
