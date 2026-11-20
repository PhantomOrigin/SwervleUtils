// Grind stats: counts your attempts, finished runs and time spent driving, per
// track, and remembers them between sessions (chrome.storage.local). Fed by
// the same live race telemetry the rest of the extension uses, so it only
// counts what you drive yourself - watching replays never counts.
//
//  - attempt:  every time a run actually starts (the countdown ends / "GO")
//  - finished: a run that crosses the finish line
//  - time:     time spent actually driving, counted in physics ticks
//              (so a paused game or a menu doesn't add to it)
(function () {
  const STORAGE_KEY = "srv-grind-stats";
  const TICK_MS = 1000 / 60;

  let data = { tracks: {} }; // { tracks: { [trackKey]: { attempts, finished, timeMs, lastPlayed } } }
  let loaded = false;
  let trackKey = null;
  let panel = null;
  let scope = "track"; // "track" | "all"
  let period = localStorage.getItem("srv-grind-period") === "session" ? "session" : "all-time";
  let session = { tracks: {} }; // same shape as `data`, but only since this page was loaded (never saved)
  let lastPhase = null;
  let lastTick = -1;
  let saveTimer = null;
  let dirty = false;

  // ---- storage ----
  const store = {
    async get() {
      try {
        if (chrome?.storage?.local) {
          const r = await chrome.storage.local.get(STORAGE_KEY);
          return r?.[STORAGE_KEY] ?? null;
        }
      } catch {}
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      } catch {
        return null;
      }
    },
    async set(value) {
      try {
        if (chrome?.storage?.local) {
          await chrome.storage.local.set({ [STORAGE_KEY]: value });
          return;
        }
      } catch {}
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {}
    },
  };

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 3000);
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || !loaded) return;
    dirty = false;
    store.set(data);
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  // ---- which track ----
  async function resolveTrackKey() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length === 2 && segments[0] === "daily") return segments[1];
    if (segments.length === 0) {
      try {
        const manifest = await window.SwervleAPI.getDailyManifest();
        if (manifest?.dailyId) return manifest.dailyId;
      } catch {}
    }
    return window.location.pathname || "/";
  }

  function current() {
    if (!trackKey) return null;
    return (data.tracks[trackKey] ??= { attempts: 0, finished: 0, timeMs: 0, lastPlayed: 0 });
  }
  function currentSession() {
    return (session.tracks[trackKey] ??= { attempts: 0, finished: 0, timeMs: 0 });
  }

  // ---- telemetry ----
  function onTick({ phase, tick }) {
    if (!loaded || !trackKey) return;
    const t = current();
    const sess = currentSession();
    if (phase === "racing" && lastPhase !== "racing") {
      t.attempts++;
      sess.attempts++;
      t.lastPlayed = Date.now();
      scheduleSave();
    } else if (phase === "finished" && lastPhase === "racing") {
      t.finished++;
      sess.finished++;
      t.lastPlayed = Date.now();
      scheduleSave();
    }
    if (phase === "racing" && lastPhase === "racing") {
      const dt = tick - lastTick;
      if (dt > 0 && dt <= 10) {
        t.timeMs += dt * TICK_MS;
        sess.timeMs += dt * TICK_MS;
        scheduleSave();
      }
    }
    lastPhase = phase;
    lastTick = tick;
  }

  // ---- UI ----
  function fmtDuration(ms) {
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  function totals() {
    const source = period === "session" ? session : data;
    if (scope === "track") return source.tracks[trackKey] ?? { attempts: 0, finished: 0, timeMs: 0 };
    const sum = { attempts: 0, finished: 0, timeMs: 0, tracks: 0 };
    for (const t of Object.values(source.tracks)) {
      if (!t.attempts && !t.timeMs) continue;
      sum.attempts += t.attempts;
      sum.finished += t.finished;
      sum.timeMs += t.timeMs;
      sum.tracks++;
    }
    return sum;
  }

  function render() {
    if (!panel) return;
    const gameEl = document.querySelector("[data-game-state]");
    const hide = !loaded || !trackKey || (!!gameEl && gameEl.dataset.gameState !== "ready");
    panel.style.display = hide ? "none" : "";
    if (hide) return;
    const t = totals();
    const rate = t.attempts > 0 ? Math.round((t.finished / t.attempts) * 100) : 0;
    panel.querySelector(".srv-grind-attempts").textContent = String(t.attempts);
    panel.querySelector(".srv-grind-finished").textContent = t.attempts > 0 ? `${t.finished} (${rate}%)` : "0";
    panel.querySelector(".srv-grind-time").textContent = fmtDuration(t.timeMs);
    panel.querySelector(".srv-grind-scope").textContent = scope === "track" ? "This track" : "All tracks";
    panel.querySelector(".srv-grind-period").textContent = period === "session" ? "Session" : "All time";
    panel.querySelector(".srv-grind-sub").textContent = scope === "track" ? trackKey : `${t.tracks ?? 0} tracks`;
  }

  function build() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "srv-grind";
    panel.style.display = "none";
    window.SwervleSetHtml(panel, `
      <div class="srv-grind-head">
        <span class="srv-grind-title">Grind stats</span>
        <span class="srv-grind-toggles">
          <button type="button" class="srv-grind-period" title="Switch between this session (since you loaded the page) and all time">All time</button>
          <button type="button" class="srv-grind-scope" title="Switch between this track and all tracks">This track</button>
        </span>
      </div>
      <div class="srv-grind-row"><span>Attempts</span><b class="srv-grind-attempts">0</b></div>
      <div class="srv-grind-row"><span>Finished</span><b class="srv-grind-finished">0</b></div>
      <div class="srv-grind-row"><span>Time on track</span><b class="srv-grind-time">0:00</b></div>
      <div class="srv-grind-foot">
        <span class="srv-grind-sub"></span>
        <button type="button" class="srv-grind-reset" title="Reset the stats shown">Reset</button>
      </div>
    `);
    document.body.appendChild(panel);
    panel.querySelector(".srv-grind-period").addEventListener("click", () => {
      period = period === "session" ? "all-time" : "session";
      try {
        localStorage.setItem("srv-grind-period", period);
      } catch {}
      render();
    });
    panel.querySelector(".srv-grind-scope").addEventListener("click", () => {
      scope = scope === "track" ? "all" : "track";
      render();
    });
    panel.querySelector(".srv-grind-reset").addEventListener("click", () => {
      const what = scope === "track" ? `the stats for ${trackKey}` : "the stats for every track";
      const which = period === "session" ? "session" : "all-time";
      if (!window.confirm(`Reset ${which} ${what}?${period === "session" ? "" : " This can't be undone."}`)) return;
      if (period === "session") {
        if (scope === "track") delete session.tracks[trackKey];
        else session = { tracks: {} };
      } else {
        // All-time reset clears the session numbers too, so the two never disagree.
        if (scope === "track") {
          delete data.tracks[trackKey];
          delete session.tracks[trackKey];
        } else {
          data = { tracks: {} };
          session = { tracks: {} };
        }
        scheduleSave();
      }
      render();
    });
    setInterval(render, 1000);
    return panel;
  }

  async function start() {
    build();
    const saved = await store.get();
    if (saved && typeof saved === "object" && saved.tracks && typeof saved.tracks === "object") data = saved;
    trackKey = await resolveTrackKey();
    loaded = true;
    window.SwervleBridge.onTick(onTick);
    render();
  }

  window.SwervleGrind = { start, build };
})();
