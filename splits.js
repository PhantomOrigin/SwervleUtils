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
    return `${sign}${sec.toFixed(2)}s`;
  }

  function build() {
    if (document.querySelector(".srv-splits")) return;

    panelEl = document.createElement("div");
    panelEl.className = "srv-splits";
    panelEl.innerHTML = `
      <div class="srv-splits-header">
        <span class="srv-splits-title">SPLITS vs PB</span>
        <button class="srv-splits-collapse" title="Collapse">—</button>
      </div>
      <div class="srv-splits-list"></div>
    `;
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
  }

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
    popupEl.innerHTML = `
      <div class="srv-popup-row srv-popup-cp">CHECKPOINT ${gateIndex + 1}</div>
      <div class="srv-popup-row srv-popup-delta ${behind ? "srv-split-behind" : "srv-split-ahead"}">${fmtDeltaTicks(deltaTicks)}</div>
      <div class="srv-popup-row srv-popup-speed">${deltaSpeed >= 0 ? "+" : ""}${deltaSpeed.toFixed(1)} spd</div>
    `;
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

  async function loadPb(pbRunId, displayName) {
    if (pendingPbRunId === pbRunId) return;
    pendingPbRunId = pbRunId;
    pbGates = null;
    pbDisplayName = displayName || "your PB";

    if (!pbRunId) {
      setStatus("No PB set for today — splits will show once you have one.");
      return;
    }

    const hooks = await window.SwervleBridge.checkHooks();
    if (!hooks.available) {
      setStatus("Live split tracker needs the in-game hooks — start (or restart) a race first.");
      return;
    }

    setStatus(`Calculating ${pbDisplayName}'s splits…`);
    try {
      const ghost = await window.SwervleAPI.getGhost(pbRunId);
      const states = window.SwervleDecoder.decodeStatesBase64(ghost.statesBase64);
      const result = await window.SwervleBridge.computeSplits(states);
      if (result.error) throw new Error(result.error);
      pbGates = result.gates;
      setStatus(`Racing? Live splits vs ${pbDisplayName} will appear below.`);
    } catch (err) {
      console.error("[Swervle Replay Viewer] failed to compute PB splits", err);
      setStatus(`Couldn't calculate PB splits (${err.message}).`);
    }
  }

  function onTick(telemetry) {
    if (!panelEl) return;
    // A fresh race started (tick reset near zero) — clear the live table.
    if (telemetry.tick < lastSeenTick - 5) {
      liveRows = [];
      render();
    }
    lastSeenTick = telemetry.tick;

    const seenGateIndex = liveRows.length; // next gate we're expecting
    if (telemetry.nextGateIndex > seenGateIndex) {
      for (let g = seenGateIndex; g < telemetry.nextGateIndex; g++) {
        const pb = pbGates?.find((r) => r.gateIndex === g) ?? null;
        const deltaTicks = pb ? telemetry.tick - pb.tick : null;
        const deltaSpeed = pb ? telemetry.speed - pb.speed : null;
        liveRows.push({ gateIndex: g, tick: telemetry.tick, speed: telemetry.speed, deltaTicks, deltaSpeed });
        if (pb) showPopup(g, deltaTicks, deltaSpeed);
      }
      render();
    }
  }

  // Every split reached so far, oldest first — intentionally never trimmed.
  function render() {
    if (!listEl) return;
    if (liveRows.length === 0) {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = liveRows
      .map((r) => {
        const hasDelta = r.deltaTicks !== null;
        const cls = !hasDelta ? "" : r.deltaTicks <= 0 ? "srv-split-ahead" : "srv-split-behind";
        const deltaText = hasDelta ? fmtDeltaTicks(r.deltaTicks) : "—";
        const speedText = hasDelta ? `${r.deltaSpeed >= 0 ? "+" : ""}${r.deltaSpeed.toFixed(1)}` : "";
        return `
          <div class="srv-split-row ${cls}">
            <span class="srv-split-gate">CP ${r.gateIndex + 1}</span>
            <span class="srv-split-time">${fmtTime(r.tick / TICK_RATE)}</span>
            <span class="srv-split-delta">${deltaText}</span>
            <span class="srv-split-speed">${speedText}</span>
          </div>`;
      })
      .join("");
    listEl.scrollTop = listEl.scrollHeight;
  }

  window.SwervleSplits = {
    init() {
      build();
    },
    setPb(pbRunId, displayName) {
      loadPb(pbRunId, displayName);
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
