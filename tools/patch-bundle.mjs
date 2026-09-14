#!/usr/bin/env node
// CLI wrapper around tools/patch-logic.mjs (the portable derive/patch core —
// see that file for the actual identifier-derivation regexes and the
// rationale behind the wildcarded-anchor approach).
//
// ============================================================================
// WHY THIS RUNS ON GITHUB ACTIONS, NOT INSIDE THE EXTENSION
// ============================================================================
// Two earlier attempts tried to make the extension patch itself entirely at
// runtime, inside the browser:
//   1. Redirect swervle.com's script request to a `data:` URL built in
//      memory. Worked in one browser, but Chromium's redirect-safety rules
//      reject redirecting a script-destination request to `data:` in
//      others (confirmed: net::ERR_UNSAFE_REDIRECT in Brave) — inconsistent
//      across browsers, not something a config change fixes.
//   2. Redirect to a made-up `chrome-extension://` path and serve it
//      dynamically from the background service worker's own `fetch` event.
//      Also failed: a service worker only intercepts fetches from clients
//      IT CONTROLS (pages loaded from its own extension origin) — a
//      cross-origin redirect from an external page never reaches that
//      handler at all. `web_accessible_resources` only exposes REAL files
//      that exist in the package, with no hook for dynamic content.
// Conclusion: MV3 does not allow an extension to synthesize content for an
// external page without that content already existing as a real file
// somewhere reachable over plain https:// — full stop, not a bug to work
// around.
//
// So the actual fetch+derive+patch step now runs OUTSIDE any browser
// entirely, on a schedule, via GitHub Actions (see
// .github/workflows/repatch.yml) — which runs this exact script and commits
// patched-bundle.js/patched-terrainview.js/state.json when they change.
// Redirecting a `<script>` tag to a normal `https://raw.githubusercontent.com/...`
// URL is completely unrestricted (ordinary cross-origin script loading),
// which is what background.js in the extension itself now does — it only
// needs to know *which* live swervle.com filenames to intercept (from
// state.json, a few bytes) and points the ACTION at these fixed GitHub URLs,
// whose CONTENT updates independently, with no extension release needed.
//
// Usage:
//   node tools/patch-bundle.mjs
//     Fetches everything live from swervle.com, writes
//     patched-bundle.js/patched-terrainview.js/state.json into this
//     directory (this is what the GitHub Actions workflow runs), and runs
//     the ESM-integrity self-check — a non-zero exit code here means the
//     workflow's own commit/push step is skipped, so a corrupted patch is
//     never published.
//
//   node tools/patch-bundle.mjs <main.js> <terrainview-chunk.js>
//     Offline mode: patches two already-downloaded files instead of
//     fetching, for local testing against a saved bundle. Doesn't write
//     state.json (the real hashes/filenames aren't meaningful offline).
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  rewriteRelativeChunkRefs,
  makePatcher,
  deriveIdentifiers,
  patchMainBundle,
  patchTerrainViewChunk,
  discoverAndFetchMainBundle,
  fetchTerrainViewChunk,
} from "./patch-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..");

const ORIGIN = "https://swervle.com";
const [, , mainInArg, terrainViewInArg] = process.argv;
const OFFLINE = Boolean(mainInArg && terrainViewInArg);

// Sanity-checks a patched output file by actually letting Node's ESM loader
// parse AND link it — not just `node --check`, which only does a syntax
// pass and has been observed to pass clean on code containing a genuine
// "Private field must be declared in an enclosing class" defect (a
// linking-time error, not a syntax error). Class-body private-field
// validation only happens during linking, which only a real
// parse-and-link attempt (like a dynamic import()) exercises.
//
// The patched files legitimately contain `import("https://swervle.com/...")`
// calls meant for a browser, which Node's loader can never resolve — so a
// SUCCESSFUL run of this always ends in one specific, benign error *after*
// parsing/linking already completed. Anything else (a SyntaxError, or an
// error before that expected point) means this patch run corrupted the
// file, and is treated as a hard failure — which, on GitHub Actions,
// prevents the broken output from ever being committed/published.
async function verifyEsmIntegrity(fileLabel, absPath) {
  try {
    await import(pathToFileURL(absPath).href + `?verify=${Date.now()}`);
    console.log(`✓ [${fileLabel}] parsed and linked cleanly (imported with no error at all — unexpected but fine).`);
    return true;
  } catch (err) {
    // Matched on the stable "Received protocol 'https:'" part rather than
    // the more verbose "Only URLs with a scheme in: ..." prefix — that
    // prefix's exact wording changed between Node versions (older Node:
    // "file and data"; Node 24+: "file, data, and node", once it added
    // node: import support), which silently broke this check the moment
    // the CI runner picked up Node 24 — a real false positive that briefly
    // blocked every otherwise-successful patch run.
    const isExpectedNetworkError =
      err instanceof Error &&
      !(err instanceof SyntaxError) &&
      /Received protocol ['"]https:['"]|Only URLs with a scheme|Cannot find module|ENOTFOUND|fetch failed/i.test(err.message);
    if (isExpectedNetworkError) {
      console.log(`✓ [${fileLabel}] parsed and linked cleanly (only failed on an expected unresolvable https:// import).`);
      return true;
    }
    console.error(
      `✗ [${fileLabel}] FAILED to parse/link — this patch run likely corrupted the file's structure ` +
        `(e.g. an anchor split a multi-statement declaration, as happened once before):\n` +
        `  ${err.constructor.name}: ${err.message}`
    );
    return false;
  }
}

async function main() {
  const results = [];

  let mainFilename, mainRawSrc;
  if (OFFLINE) {
    mainRawSrc = readFileSync(mainInArg, "utf8");
    mainFilename = mainInArg.split(/[\\/]/).pop();
    console.log(`Offline mode: using local file ${mainInArg}`);
  } else {
    ({ mainFilename, mainRawSrc } = await discoverAndFetchMainBundle(ORIGIN));
    console.log(`Discovered live main bundle: ${mainFilename}`);
  }

  const mainRewritten = rewriteRelativeChunkRefs(ORIGIN, "main bundle", mainRawSrc);
  const names = deriveIdentifiers(mainRewritten, mainRawSrc);
  console.log("Derived identifiers:", names);
  const { patchedSrc: mainSrc } = patchMainBundle(mainRewritten, mainRawSrc, names, ORIGIN, results);

  writeFileSync(join(OUT_DIR, "patched-bundle.js"), mainSrc, "utf8");
  console.log(`Patched main bundle written to patched-bundle.js (${mainSrc.length} bytes).`);

  let tvFilename, tvRawSrc;
  if (OFFLINE) {
    tvRawSrc = readFileSync(terrainViewInArg, "utf8");
    tvFilename = terrainViewInArg.split(/[\\/]/).pop();
  } else {
    if (!names.rvChunkPath) throw new Error("Could not locate the RV/TerrainView chunk's import path in the main bundle.");
    ({ tvFilename, tvRawSrc } = await fetchTerrainViewChunk(ORIGIN, names.rvChunkPath));
    console.log(`Discovered live RV/TerrainView chunk: ${tvFilename}`);
  }

  const tvRewritten = rewriteRelativeChunkRefs(ORIGIN, "TerrainView chunk", tvRawSrc);
  const { patchedSrc: tvSrc } = patchTerrainViewChunk(tvRewritten, results);

  writeFileSync(join(OUT_DIR, "patched-terrainview.js"), tvSrc, "utf8");
  console.log(`Patched TerrainView chunk written to patched-terrainview.js (${tvSrc.length} bytes).`);

  const mainOk = await verifyEsmIntegrity("main bundle", join(OUT_DIR, "patched-bundle.js"));
  const tvOk = await verifyEsmIntegrity("TerrainView chunk", join(OUT_DIR, "patched-terrainview.js"));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} patches applied.`);
  if (failed.length > 0) {
    console.log("Needs re-deriving (site likely changed structurally, not just renamed identifiers):");
    for (const r of failed) console.log(`  - [${r.file}] ${r.name}`);
    console.log("\nBoth output files were still written with every OTHER patch applied — only the features tied to the anchors above are affected.");
  }

  // state.json is what the extension actually reads (from the same GitHub
  // raw host as the patched files themselves) — just enough for it to know
  // which live swervle.com filenames to redirect, without ever fetching
  // swervle.com itself or running any derivation logic in the browser.
  if (!OFFLINE) {
    const state = {
      mainFilename,
      tvFilename,
      patchedAt: new Date().toISOString(),
      patchCount: results.length,
      failedPatches: failed.map((r) => `${r.file}/${r.name}`),
    };
    writeFileSync(join(OUT_DIR, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
    console.log(`state.json written: ${JSON.stringify(state)}`);
  }

  if (!mainOk || !tvOk) {
    console.error(
      "\n⚠ At least one output file failed ESM integrity verification — refusing to treat this run as " +
        "successful. On GitHub Actions this exit code stops the workflow before it commits/pushes, so the " +
        "last known-good published files stay live instead of being overwritten with something broken. " +
        "An anchor likely inserted code into the middle of an existing statement (see patch-logic.mjs's " +
        "patch #2 comment history for a real past example) — it needs re-deriving there."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
