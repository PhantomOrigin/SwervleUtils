// Keeps this extension's declarativeNetRequest rules pointed at the right
// swervle.com script requests to intercept, redirecting them to this
// repo's own hosted patched files on GitHub — which update independently,
// on their own schedule, via .github/workflows/repatch.yml running
// tools/patch-bundle.mjs. See that workflow file and tools/patch-bundle.mjs's
// own top comment for the full history of why it works this way (two
// earlier attempts at having the extension patch itself entirely in-browser
// both hit real MV3 platform restrictions — this sidesteps both, since
// redirecting a <script> tag to a normal https:// URL is completely
// unrestricted, unlike a `data:` URL or a synthesized `chrome-extension://`
// resource).
//
// This file does NOT fetch swervle.com, derive any identifiers, or build
// any patched content itself — it only fetches a tiny state.json (a few
// bytes: which live swervle.com filenames are CURRENTLY patched) and keeps
// the redirect rules' MATCH CONDITIONS in sync with that. The redirect
// ACTIONS (where matched requests get sent) are fixed GitHub URLs whose
// CONTENT changes on GitHub's own schedule — this file never needs to
// change what it redirects TO, only which requests it redirects.

// ---- EDIT THESE after creating your GitHub repo ----
const GITHUB_OWNER = "PhantomOrigin";
const GITHUB_REPO = "SwervleUtils";
const GITHUB_BRANCH = "main";
// -----------------------------------------------------

const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;
const STATE_URL = `${RAW_BASE}/state.json`;
const MAIN_RULE_ID = 1;
const TV_RULE_ID = 2;

// Same wildcard-by-hash-prefix approach the original (pre-self-patch)
// static rules.json used: a pure hash-bump redeploy with no code changes
// (common) still matches without needing state.json to have caught up
// first — though it usually has anyway, since this checks on every page
// load (see the message listener below).
function mainBundleUrlFilter(mainFilename) {
  return `||swervle.com/assets/${mainFilename.replace(/-[^-.]+\.js$/, "-*.js")}`;
}

let inFlightSync = null;

// Fetches state.json and points the two redirect rules' match conditions
// at whatever live filenames it names — NOT at building any content, which
// already lives at the fixed URLs below, updated independently on GitHub's
// own schedule. Concurrent callers (e.g. several swervle.com tabs checking
// at once) share the same in-flight fetch rather than each doing their own.
function syncRules() {
  if (inFlightSync) return inFlightSync;
  inFlightSync = (async () => {
    try {
      // cache: "no-store" — a stale cached state.json would defeat the
      // entire point of checking at all.
      const res = await fetch(`${STATE_URL}?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`state.json fetch failed: HTTP ${res.status}`);
      const state = await res.json();
      if (!state?.mainFilename || !state?.tvFilename) throw new Error("state.json is missing mainFilename/tvFilename");

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [MAIN_RULE_ID, TV_RULE_ID],
        addRules: [
          {
            id: MAIN_RULE_ID,
            priority: 1,
            action: { type: "redirect", redirect: { url: `${RAW_BASE}/patched-bundle.js` } },
            condition: { urlFilter: mainBundleUrlFilter(state.mainFilename), resourceTypes: ["script"] },
          },
          {
            id: TV_RULE_ID,
            priority: 1,
            action: { type: "redirect", redirect: { url: `${RAW_BASE}/patched-terrainview.js` } },
            condition: { urlFilter: `||swervle.com/assets/${state.tvFilename}`, resourceTypes: ["script"] },
          },
        ],
      });

      const result = { ok: true, mainFilename: state.mainFilename, tvFilename: state.tvFilename, syncedAt: Date.now() };
      await chrome.storage.local.set({ srvPatchState: result });
      setBadge(state.failedPatches?.length > 0 ? "warn" : "ok");
      console.log(`[srv sync] rules now match main=${state.mainFilename} tv=${state.tvFilename}`);
      return result;
    } catch (err) {
      const result = { ok: false, lastError: err?.message ?? String(err), syncedAt: Date.now() };
      // Deliberately doesn't clear the previously-registered rules — if
      // this was a transient network hiccup fetching state.json, the last
      // known-good rules staying active is strictly better than falling
      // back to no redirect at all.
      const prior = await chrome.storage.local.get("srvPatchState");
      await chrome.storage.local.set({ srvPatchState: { ...prior.srvPatchState, ...result } });
      setBadge("error");
      console.error("[srv sync] failed:", err);
      return result;
    } finally {
      inFlightSync = null;
    }
  })();
  return inFlightSync;
}

function setBadge(status) {
  const text = { ok: "", warn: "!", error: "X" }[status] ?? "";
  chrome.action?.setBadgeText?.({ text });
  chrome.action?.setBadgeBackgroundColor?.({ color: status === "error" ? "#c0392b" : "#e6a23c" });
}

chrome.runtime.onInstalled.addListener(() => syncRules());
chrome.runtime.onStartup.addListener(() => syncRules());

// content.js (isolated world, has chrome.runtime access — unlike srv-main.js
// which runs in the page's own MAIN world) reports the live page's actual
// script filename on every load. If it doesn't match what's currently
// registered, re-sync immediately (cheap — one small JSON fetch, not a full
// site scrape) and tell the player to refresh. Can't help the page that
// just triggered this (its own script request was already decided before
// its content script could run and report anything) — only the next load.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "srv:pageLoaded") return undefined;
  (async () => {
    const { srvPatchState } = await chrome.storage.local.get("srvPatchState");
    const isCurrent = srvPatchState?.ok && srvPatchState.mainFilename === msg.liveMainFilename;
    if (isCurrent) {
      sendResponse({ staleOnLoad: false });
      return;
    }
    const result = await syncRules();
    sendResponse({ staleOnLoad: true, syncOk: result.ok });
  })();
  return true; // keep the message channel open for the async sendResponse above
});
