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
// raw.githubusercontent.com deliberately serves files as text/plain or
// application/octet-stream — never a JS content-type — specifically so
// raw user content can never be executed as a script by anything that
// fetches it directly. That's exactly what a <script type="module"> load
// needs, so a redirect there fails with a strict-MIME-type error (confirmed
// live, in both Chrome and Brave) despite the redirect itself succeeding.
// jsDelivr's GitHub CDN mode exists specifically to serve GitHub repo files
// AS proper web assets — correct content-type included — which is why only
// the two actual script files point here; state.json (fetched as plain
// JSON, where content-type doesn't matter) stays on raw GitHub above.
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`;
const MAIN_RULE_ID = 1;
const TV_RULE_ID = 2;
const CSP_RULE_ID = 3;

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
            action: { type: "redirect", redirect: { url: `${CDN_BASE}/patched-bundle.js` } },
            condition: { urlFilter: mainBundleUrlFilter(state.mainFilename), resourceTypes: ["script"] },
          },
          {
            id: TV_RULE_ID,
            priority: 1,
            action: { type: "redirect", redirect: { url: `${CDN_BASE}/patched-terrainview.js` } },
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

// swervle.com's own CSP sends a `script-src` allowlist (its origin plus
// specific ad/analytics/Cloudflare domains) that does not include
// cdn.jsdelivr.net — the host the redirect rules above send the patched
// scripts to — so without a change the browser refuses to run them ("Refused
// to load the script ... violates ... Content-Security-Policy").
//
// This does NOT remove the header. It fetches swervle.com's real CSP, adds
// exactly one origin (jsDelivr) to its `script-src`, and re-sends the
// otherwise identical policy, so every other protection the site set stays
// in force. (declarativeNetRequest can only set/append/remove a header, not
// edit part of its value, hence rebuilding the whole value from the live
// one; a second appended policy would only ever tighten, never loosen.)
//
// Re-run on each startup and each periodic re-sync so a change to the site's
// own policy is picked up. If swervle.com can't be reached, whatever rule
// was registered last is left in place.
const CSP_EXTRA_SCRIPT_SRC = "https://cdn.jsdelivr.net";

function addScriptSrcOrigin(csp, origin) {
  const directives = csp.split(";").map((d) => d.trim()).filter(Boolean);
  const idx = directives.findIndex((d) => /^script-src(\s|$)/i.test(d));
  if (idx !== -1) {
    if (!directives[idx].split(/\s+/).includes(origin)) directives[idx] += ` ${origin}`;
  } else {
    // No script-src: scripts fall back to default-src, so copy it and extend.
    const def = directives.find((d) => /^default-src(\s|$)/i.test(d));
    if (!def) return null; // no script restriction at all — nothing to widen
    directives.push(`${def.replace(/^default-src/i, "script-src")} ${origin}`);
  }
  return directives.join("; ");
}

async function ensureCspRuleRegistered() {
  const res = await fetch("https://swervle.com/", { cache: "no-store" });
  const csp = res.headers.get("content-security-policy");
  if (!csp) {
    // The site currently sends no CSP, so there is nothing to relax.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [CSP_RULE_ID] });
    return;
  }
  const widened = addScriptSrcOrigin(csp, CSP_EXTRA_SCRIPT_SRC);
  if (widened === null) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [CSP_RULE_ID] });
    return;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CSP_RULE_ID],
    addRules: [
      {
        id: CSP_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [{ header: "content-security-policy", operation: "set", value: widened }],
        },
        condition: { urlFilter: "||swervle.com/", resourceTypes: ["main_frame"] },
      },
    ],
  });
}

function setBadge(status) {
  const text = { ok: "", warn: "!", error: "X" }[status] ?? "";
  chrome.action?.setBadgeText?.({ text });
  chrome.action?.setBadgeBackgroundColor?.({ color: status === "error" ? "#c0392b" : "#e6a23c" });
}

// ---- "a new build of the extension itself exists" notice ----
// Separate from everything above: syncRules() keeps the SWERVLE PATCH
// current automatically (that's the whole point of this file), but the
// extension package itself — content.js, this file, manifest.json, any
// actual feature/bug work — has no update mechanism at all under a
// zip-and-Load-unpacked distribution (see the conversation this was built
// from: Chrome permanently disables update-checking for unpacked
// extensions, full stop, regardless of any manifest field). The only thing
// achievable here is checking the difference and telling the player —
// they still have to manually grab the new zip themselves.
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
// GitHub's unauthenticated REST API allows 60 requests/hour per IP — this
// cache keeps normal usage nowhere near that regardless of how often pages
// load, by only ever hitting it once per hour at most.
const VERSION_CHECK_MIN_INTERVAL_MS = 60 * 60 * 1000;

// Plain numeric dot-version comparison (not full semver — this project has
// never used anything beyond "1.2"-style versions) so "1.10" correctly
// counts as newer than "1.9", unlike a naive string compare.
function isNewerVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0,
      nb = pb[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

async function checkForNewRelease() {
  const { srvVersionCheck: rawCached } = await chrome.storage.local.get("srvVersionCheck");
  const currentVersion = chrome.runtime.getManifest().version;
  // A cached result only counts if it was computed for THIS installed
  // version — its `updateAvailable` was worked out against whatever version
  // was installed at the time, so after upgrading (say 1.9 -> 1.10) a stale
  // "update available" answer would otherwise keep showing for up to an
  // hour even though the extension is now current.
  const cached = rawCached?.currentVersion === currentVersion ? rawCached : null;
  if (cached?.checkedAt && Date.now() - cached.checkedAt < VERSION_CHECK_MIN_INTERVAL_MS) return cached;

  try {
    // Explicit Accept header — GitHub's REST API convention, and avoids
    // ambiguity about response format.
    const res = await fetch(RELEASES_API_URL, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`releases API failed: HTTP ${res.status}`);
    const release = await res.json();
    const latestVersion = String(release?.tag_name ?? "").replace(/^v/i, "");
    const result = {
      checkedAt: Date.now(),
      currentVersion,
      latestVersion: latestVersion || null,
      updateAvailable: latestVersion ? isNewerVersion(latestVersion, currentVersion) : false,
      releaseUrl: release?.html_url ?? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    };
    await chrome.storage.local.set({ srvVersionCheck: result });
    return result;
  } catch (err) {
    console.error("[srv version check] failed:", err);
    // Keep whatever was cached before rather than overwriting it with a
    // failure — a transient network hiccup shouldn't erase a real, already-
    // known "update available" notice that just hasn't been dismissed yet.
    return cached ?? null;
  }
}

// Sequential, not fire-and-forget — both call updateDynamicRules(), and
// firing them concurrently let one call's remove/add pair race the other's,
// which could throw and leave syncRules() reporting `ok:false` (and
// therefore this page load's patch state as permanently "stale") even
// though the CSP rule itself still registered fine and the game was
// actually working the whole time. Awaiting the CSP rule first, before
// syncRules() ever touches the ruleset, removes the race entirely.
async function initializeRules() {
  try {
    await ensureCspRuleRegistered();
  } catch (err) {
    console.error("[srv] failed to update CSP rule:", err);
  }
  await syncRules();
}

const RESYNC_AFTER_MS = 5 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => initializeRules());
chrome.runtime.onStartup.addListener(() => initializeRules());

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
    // Two independent checks piggybacked on the same message rather than
    // content.js sending two separate ones — both are cheap/cached, and a
    // page load is a fine, unobtrusive moment to run either.
    const versionCheck = await checkForNewRelease();
    const updateNotice = versionCheck?.updateAvailable
      ? { latestVersion: versionCheck.latestVersion, currentVersion: versionCheck.currentVersion, releaseUrl: versionCheck.releaseUrl }
      : null;

    const { srvPatchState } = await chrome.storage.local.get("srvPatchState");
    const mainMatches = srvPatchState?.ok && srvPatchState.mainFilename === msg.liveMainFilename;
    // The main filename matching isn't enough on its own: the second (RV
    // chunk) redirect can change without the main bundle's name changing,
    // and a stale rule for the old chunk breaks the page's module graph
    // outright. So also re-check state.json when the last sync is a few
    // minutes old — one tiny fetch.
    const syncedRecently = Date.now() - (srvPatchState?.syncedAt ?? 0) < RESYNC_AFTER_MS;
    if (mainMatches && syncedRecently) {
      sendResponse({ staleOnLoad: false, updateNotice });
      return;
    }
    ensureCspRuleRegistered().catch((err) => console.error("[srv] failed to update CSP rule:", err));
    const result = await syncRules();
    const changed = !mainMatches || result.tvFilename !== srvPatchState?.tvFilename || result.mainFilename !== srvPatchState?.mainFilename;
    sendResponse({ staleOnLoad: changed, syncOk: result.ok, updateNotice });
  })();
  return true; // keep the message channel open for the async sendResponse above
});
