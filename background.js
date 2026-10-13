// Background service worker. The extension no longer modifies swervle.com's
// code, so there is nothing to patch or sync: all this does is check GitHub's
// public release list (at most hourly) so the page can show a "new version
// available" notice.

const GITHUB_OWNER = "PhantomOrigin";
const GITHUB_REPO = "SwervleUtils";

// ---- "a new build of the extension itself exists" notice ----
// The extension package itself — content.js, this file, manifest.json, any
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

// content.js reports each page load; the reply carries the update notice.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "srv:pageLoaded") return undefined;
  (async () => {
    const versionCheck = await checkForNewRelease();
    const updateNotice = versionCheck?.updateAvailable
      ? { latestVersion: versionCheck.latestVersion, currentVersion: versionCheck.currentVersion, releaseUrl: versionCheck.releaseUrl }
      : null;
    sendResponse({ staleOnLoad: false, updateNotice });
  })();
  return true; // keep the message channel open for the async sendResponse above
});
