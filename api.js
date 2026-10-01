// Thin wrapper around swervle's public API. Read-only: this extension never
// calls any endpoint that starts a race, submits a run, or otherwise mutates
// account/race state.
(function (global) {
  const BASE = "/api/v1";

  async function getGhost(publicRunId) {
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(publicRunId)}/ghost`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to fetch ghost ${publicRunId}: ${res.status}`);
    return res.json();
  }

  // `date` (a "YYYY-MM-DD" dailyId, e.g. from the current /daily/<date> route
  // — see getCurrentDailyIdFromRoute() in content.js) fetches that specific
  // day's map instead of today's. Omit it for today's.
  async function getDailyManifest(date) {
    const url = date ? `${BASE}/daily?date=${encodeURIComponent(date)}` : `${BASE}/daily`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Failed to fetch daily manifest: ${res.status}`);
    return res.json();
  }

  async function getLeaderboard(dailyId) {
    const res = await fetch(`${BASE}/dailies/${encodeURIComponent(dailyId)}/leaderboard`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to fetch leaderboard: ${res.status}`);
    const body = await res.json();
    return Array.isArray(body?.entries) ? body.entries : [];
  }

  // Returns null (not signed in / request failed) instead of throwing, since
  // "no PB" is an expected, common state.
  async function getAccountRuns() {
    try {
      const res = await fetch(`${BASE}/account/runs`, { credentials: "include" });
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body?.runs) ? body.runs : null;
    } catch {
      return null;
    }
  }

  // Your saved livery designs ("my garage"), as swervle's own garage UI
  // lists them — see swervle's `listMyLiveryLibrary()`, which this mirrors:
  // [{slotId, name, design, updatedAt}] (design is the same encoded paint
  // string a leaderboard entry's carPaint carries). Returns null (not
  // signed in / request failed) rather than throwing, same reasoning as
  // getAccountRuns — "no garage" is an expected, common state (e.g. a
  // player who's never customized a car).
  async function getMyLiveryLibrary() {
    try {
      const res = await fetch(`${BASE}/me/livery/library`, { credentials: "include" });
      if (!res.ok) return null;
      const body = await res.json();
      if (!Array.isArray(body?.entries)) return null;
      return body.entries.filter(
        (e) => e && typeof e.slotId === "string" && typeof e.name === "string" && typeof e.design === "string" && e.design !== ""
      );
    } catch {
      return null;
    }
  }

  global.SwervleAPI = { getGhost, getDailyManifest, getLeaderboard, getAccountRuns, getMyLiveryLibrary };
})(window);
