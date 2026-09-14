// Request/response bridge to srv-main.js, which runs in the page's own JS
// world (MAIN) and has access to the live hooks the patched bundle installs
// on window.__srv. This (isolated-world) content script can't reach those
// directly, so everything crosses via CustomEvents on `document`.
(function () {
  let seq = 1;

  function request(requestType, detail, responseType) {
    return new Promise((resolve) => {
      const requestId = seq++;
      const handler = (e) => {
        if (e.detail?.requestId !== requestId) return;
        document.removeEventListener(responseType, handler);
        resolve(e.detail);
      };
      document.addEventListener(responseType, handler);
      document.dispatchEvent(new CustomEvent(requestType, { detail: { ...detail, requestId } }));
    });
  }

  window.SwervleBridge = {
    // { available: boolean }
    checkHooks: () => request("srv:checkHooks", {}, "srv:hooksStatus"),
    // Ghosts are keyed by `key` (a run's publicRunId) — spawning the same
    // key twice is a no-op on the srv-main.js side, so callers don't need
    // to track whether a ghost is already up before asking to show it.
    // { key, error? }
    spawnGhost: (key, states, displayName, livery) =>
      request("srv:spawnGhost", { key, states, displayName, livery }, "srv:spawnGhostResult"),
    despawnGhost: (key) => document.dispatchEvent(new CustomEvent("srv:despawnGhost", { detail: { key } })),
    setCameraFollow: (key) =>
      document.dispatchEvent(new CustomEvent("srv:setCameraFollow", { detail: { key } })),
    // { gates: [{gateIndex,tick,speed}], totalTicks, error? }
    computeSplits: (states) => request("srv:computeSplits", { states }, "srv:splitsResult"),
    // Playback speed multiplier for the currently-followed ghost only (see
    // srv-main.js's "manual" ghost mode) — a no-op if `key` isn't the
    // followed ghost. Fire-and-forget: there's nothing to await, the next
    // srv:ghostInput tick reflects the new speed.
    setReplaySpeed: (key, speed) =>
      document.dispatchEvent(new CustomEvent("srv:setReplaySpeed", { detail: { key, speed } })),
    // Scrubs the currently-followed ghost to an arbitrary tick. Resolves
    // once the seek actually lands (real physics can only step forward, so
    // this is a fast-forward-from-scratch under the hood and isn't
    // instant for a large jump) — { key, error? }.
    seekReplay: (key, tick) => request("srv:seekReplay", { key, tick }, "srv:seekReplayResult"),
    onTick: (cb) => {
      const handler = (e) => cb(e.detail);
      document.addEventListener("srv:tick", handler);
      return () => document.removeEventListener("srv:tick", handler);
    },
    // { key, inputByte, tick, totalTicks, finished } — fires every rendered
    // frame for whichever ghost is currently camera-followed (see
    // setCameraFollow), carrying its current position in the replay so a
    // progress bar can track it live.
    onGhostInput: (cb) => {
      const handler = (e) => cb(e.detail);
      document.addEventListener("srv:ghostInput", handler);
      return () => document.removeEventListener("srv:ghostInput", handler);
    },
  };
})();
