// Portable core of the swervle.com bundle patcher — every regex-based
// identifier derivation and patch insertion/replacement, plus the live-
// bundle discovery/fetch step, with ZERO Node-specific APIs (no fs, no
// path, no process). Both `tools/patch-bundle.mjs` (the Node CLI — fetches,
// writes patched-bundle.js/patched-terrainview.js to disk for inspection,
// runs the ESM-integrity self-check) and `background.js` (the extension's own
// service worker — fetches, builds `data:` URLs, registers them as
// declarativeNetRequest dynamic rules) import this file, so the actual
// derivation/patch logic exists in exactly one place. See background.js's
// own top comment for why the extension re-patches itself at all now,
// rather than only ever running this from the CLI.
//
// See tools/patch-bundle.mjs's original top-of-file comment for the full
// rationale behind the wildcarded-anchor approach — that reasoning is
// unchanged, just relocated here since it now applies to two callers.

// Rewrites every chunk-relative *import specifier* in `src`
// (`from"./Name-hash.js"`, and `import("./Name-hash.js")`) to an absolute
// `origin`-based URL. Necessary because both callers redirect requests for
// each patched file's own URL elsewhere (a chrome-extension:// resource for
// the CLI's file-based delivery, a `data:` URL for the extension's own
// runtime delivery) — either way, the browser resolves the file's relative
// imports against ITS OWN URL, not swervle.com's, once redirected. Without
// this, sibling chunks fail to resolve and the whole module graph breaks.
export function rewriteRelativeChunkRefs(origin, name, src, log = console) {
  const before = src;
  const out = src.replace(/([\"'`])\.\/([A-Za-z0-9_.]+-[A-Za-z0-9_-]{6,}\.(?:js|css))\1/g, `$1${origin}/assets/$2$1`);
  const count =
    before === out ? 0 : (out.match(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/assets/`, "g")) || []).length;
  log.log(`${name}: rewrote ${count} relative chunk references to absolute ${origin} URLs.`);
  return out;
}

// Each patch is independent and best-effort: a single stale anchor (the
// site changed the one bit of code that patch targets) logs a clear warning
// and skips *only* that insertion/replacement — every other patch, and the
// output itself, still get produced. `results` accumulates {file, name, ok}
// for the caller to summarize/report however fits its own context (console
// summary for the CLI, chrome.storage + badge for the extension).
export function makePatcher(fileLabel, getSrc, setSrc, results, log = console) {
  function run(name, anchorRe, apply) {
    const src = getSrc();
    const re = new RegExp(anchorRe.source, anchorRe.flags.includes("g") ? anchorRe.flags : anchorRe.flags + "g");
    const matches = [...src.matchAll(re)];
    if (matches.length !== 1) {
      log.warn(
        `⚠ [${fileLabel}] patch "${name}" anchor matched ${matches.length} times (expected exactly 1) — ` +
          `skipping. The site's bundle has likely changed structurally; this anchor needs regenerating.\n` +
          `  Pattern: ${anchorRe.source}`
      );
      results.push({ file: fileLabel, name, ok: false });
      return;
    }
    const m = matches[0];
    const idx = m.index;
    const matchedText = m[0];
    const replacement = apply(m);
    setSrc(src.slice(0, idx) + replacement + src.slice(idx + matchedText.length));
    results.push({ file: fileLabel, name, ok: true });
  }
  return {
    insertAfter(name, anchorRe, insertionFn) {
      run(name, anchorRe, (m) => m[0] + insertionFn(m));
    },
    replaceOnce(name, anchorRe, replaceFn) {
      run(name, anchorRe, replaceFn);
    },
    skip(name, reason) {
      log.warn(`⚠ [${fileLabel}] patch "${name}" skipped — ${reason}`);
      results.push({ file: fileLabel, name, ok: false });
    },
  };
}

// Fetches swervle.com's current HTML, finds its main module script tag, and
// fetches that bundle too — the one piece of "discovery" both callers need
// before any derivation/patching can start. `fetch` is available in both
// Node 18+ (the CLI) and a browser service worker (the extension), so this
// needs no environment-specific branching.
export async function discoverAndFetchMainBundle(origin) {
  const html = await fetch(origin).then((r) => r.text());
  const scriptMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]*\/assets\/[^"]+\.js)"/);
  if (!scriptMatch) throw new Error("Could not find main module script tag in swervle.com's HTML.");
  const mainUrl = new URL(scriptMatch[1], origin).href;
  const mainFilename = mainUrl.split("/").pop();
  const mainRawSrc = await fetch(mainUrl).then((r) => r.text());
  return { mainUrl, mainFilename, mainRawSrc };
}

export async function fetchTerrainViewChunk(origin, rvChunkPath) {
  const tvUrl = new URL(rvChunkPath, origin + "/assets/x").href;
  const tvFilename = tvUrl.split("/").pop();
  const tvRawSrc = await fetch(tvUrl).then((r) => r.text());
  return { tvUrl, tvFilename, tvRawSrc };
}

// Auto-derives every minified identifier this patch set needs from stable,
// non-minified (human-authored, multi-word) method/property names the
// minifier leaves alone — see tools/patch-bundle.mjs's top comment for the
// full rationale. `mainSrc` is the already-rewritten (absolute chunk refs)
// source; `mainRawSrc` is the original fetched text, needed for the two
// derivations anchored on relative import paths (which rewriteRelativeChunkRefs
// has already replaced by the time mainSrc exists).
export function deriveIdentifiers(mainSrc, mainRawSrc) {
  const names = {};

  {
    const m = mainSrc.match(/new ([A-Za-z0-9_$]+)\(\{modifiers:this\.(#[A-Za-z0-9_$]+),presentationRaycastEmulation:/);
    names.RV = m?.[1] ?? null;
    names.physicsModifiers = m?.[2] ?? null;
  }
  {
    const m = mainSrc.match(
      /new ([A-Za-z0-9_$]+)\(\{appearance:([A-Za-z0-9_$]+),assetInstance:await this\.(#[A-Za-z0-9_$]+)\.instantiate\(([A-Za-z0-9_$]+)\),definition:([A-Za-z0-9_$]+),entityId:[^,]+,materialColorOverrides:([A-Za-z0-9_$]+),materialRegistrar:this\.(#[A-Za-z0-9_$]+)\.materialRegistrar\}\)/
    );
    names.VD = m?.[1] ?? null;
    names.ghostAppearance = m?.[2] ?? null;
    names.assetFactory = m?.[3] ?? null;
    names.carContentId = m?.[4] ?? null;
    names.carDefinition = m?.[5] ?? null;
    names.ghostColorOverrides = m?.[6] ?? null;
    names.playerSceneManager = m?.[7] ?? null;
  }
  {
    const m = mainSrc.match(
      /=([A-Za-z0-9_$]+)\(\{displayName:i\.opponent\.displayName,relationship:`friend`,surface:`gameplay`\}\),[A-Za-z0-9_$]+=new ([A-Za-z0-9_$]+)\(\{carView:/
    );
    names.buildNameplate = m?.[1] ?? null;
    names.GL = m?.[2] ?? null;
  }
  {
    const m = mainSrc.match(
      /get active\(\)\{return this\.(#[A-Za-z0-9_$]+)\}start\(\)\{this\.(#[A-Za-z0-9_$]+)\|\|this\.\1\|\|\(this\.clear\(\),this\.\1=!0\)\}/
    );
    names.keyboardActive = m?.[1] ?? null;
    names.keyboardDisposed = m?.[2] ?? null;
    const m2 = mainSrc.match(
      /sample\(e=!0\)\{let t=\{edges:this\.(#[A-Za-z0-9_$]+)\.map\(e=>\(\{\.\.\.e\}\)\),held:Object\.fromEntries\(this\.#[A-Za-z0-9_$]+\)\}/
    );
    names.keyboardEdges = m2?.[1] ?? null;
  }
  {
    const m = mainSrc.match(
      /let ([A-Za-z0-9_$]+)=this\.(#[A-Za-z0-9_$]+);[A-Za-z0-9_$]+\(`scene-precompile`,\(\)=>\{[A-Za-z0-9_$]+\.precompile\(\1\.camera\)\}\)/
    );
    names.cameraController = m?.[2] ?? null;
  }
  {
    const m = mainSrc.match(/gateCount:this\.(#[A-Za-z0-9_$]+)\?\.track\.gates\.length/);
    names.raceManifest = m?.[1] ?? null;
  }
  {
    const m = mainRawSrc.match(/createGhostRaceLivery\([A-Za-z0-9_$]+,[A-Za-z0-9_$]+\)\{[\s\S]{0,200}?import\(`(\.\/[^`]+)`\)/);
    names.liveryChunkPath = m?.[1] ?? null;
  }
  {
    if (names.RV) {
      const re = new RegExp(`import\\{[^}]*\\b${names.RV}\\b[^}]*\\}from"(\\./[^"]+)"`);
      const m = mainRawSrc.match(re);
      names.rvChunkPath = m?.[1] ?? null;
    }
  }

  return names;
}

// Applies every main-bundle patch to `mainSrc` (already rewritten/absolute-
// import'd) using the derived `names`, returning the patched source. Each
// patch is independent — a missing/stale identifier skips only that one
// patch (via mainPatcher.skip), same as always. `origin` is only needed to
// build the livery chunk's absolute URL.
export function patchMainBundle(mainSrc, mainRawSrc, names, origin, results, log = console) {
  let src = mainSrc;
  const mainPatcher = makePatcher(
    "main bundle",
    () => src,
    (s) => (src = s),
    results,
    log
  );

  const liveryChunkUrl = names.liveryChunkPath ? new URL(names.liveryChunkPath, origin + "/assets/x").href : null;

  // 1. Expose the ghost-spawning ingredients, unconditionally, every time a
  //    race is (re)booted.
  if (
    names.RV &&
    names.GL &&
    names.VD &&
    names.buildNameplate &&
    names.ghostAppearance &&
    names.ghostColorOverrides &&
    names.carDefinition &&
    names.carContentId &&
    names.playerSceneManager &&
    names.assetFactory &&
    names.physicsModifiers &&
    liveryChunkUrl
  ) {
    mainPatcher.insertAfter(
      "expose-ready-ingredients",
      /this\.#[A-Za-z0-9_$]+\.rivalGap=new [A-Za-z0-9_$]+\(i\.track\.routeLine\)\}catch\(n\)\{throw t\?\.dispose\(\),e\.dispose\(\),n\}\}/,
      () =>
        "window.__srv=window.__srv||{};" +
        `window.__srv.ready={RV:${names.RV},GL:${names.GL},VD:${names.VD},appearance:${names.ghostAppearance},` +
        `carDef:${names.carContentId},definition:${names.carDefinition},materialColorOverrides:${names.ghostColorOverrides},` +
        `buildNameplate:${names.buildNameplate},viewParent:this.${names.playerSceneManager}.viewParent,` +
        `materialRegistrar:this.${names.playerSceneManager}.materialRegistrar,` +
        `modifiers:this.${names.physicsModifiers},track:i.track,assetFactory:this.${names.assetFactory},` +
        `liveryModuleUrl:${JSON.stringify(liveryChunkUrl)},loadLiveryModule:()=>import(${JSON.stringify(liveryChunkUrl)}),` +
        (names.cameraController ? `camera:this.${names.cameraController}?.camera` : "camera:null") +
        "};" +
        "try{window.__srv.onRaceBoot?.();}catch(e){console.error(e);}"
    );
  } else {
    mainPatcher.skip("expose-ready-ingredients", "one or more required identifiers could not be derived");
  }

  // 2. Per fixed-tick telemetry hook.
  if (names.raceManifest) {
    mainPatcher.insertAfter(
      "onTick",
      /[A-Za-z0-9_$]+=[A-Za-z0-9_$]+\(this\.#[A-Za-z0-9_$]+\),[A-Za-z0-9_$]+=this\.#[A-Za-z0-9_$]+\.profile\.hudUpdateTickInterval;/,
      () =>
        "try{window.__srv?.onTick?.({tick:s,nextGateIndex:a.nextGateIndex," +
        `gateCount:this.${names.raceManifest}?.track.gates.length??0,speed:c.speed,position:c.position,phase:a.phase,` +
        "gear:c.gear,shiftTimer:c.shiftTimer});}catch(e){console.error(e);}"
    );
  } else {
    mainPatcher.skip("onTick", "raceManifest field could not be derived");
  }

  // 3. Per-render-frame hook.
  if (names.cameraController) {
    mainPatcher.insertAfter(
      "onRender",
      /this\.#[A-Za-z0-9_$]+\.rival\?\.updateNameplate\(n\.camera\),this\.#[A-Za-z0-9_$]+\.pbGhost\?\.updateNameplate\(n\.camera\),this\.#[A-Za-z0-9_$]+\.teamFieldView\?\.updateNameplates\(n\.camera\);/,
      () =>
        `try{window.__srv?.onRender?.({alpha:e.alpha,playerPosition:i.position,camera:this.${names.cameraController}.camera});}catch(e){console.error(e);}`
    );
  } else {
    mainPatcher.skip("onRender", "cameraController field could not be derived");
  }

  // 7. Optional pointer-lock bypass.
  mainPatcher.replaceOnce(
    "pointerLockToggle",
    /n\.requestPointerLock\(\)\.catch\(\(\)=>void 0\)/,
    () => "(window.__srvNoPointerLock??!1)||(window.__srvWatchingReplay??!1)||n.requestPointerLock().catch(()=>void 0)"
  );

  // 8. Pause-suppression flag.
  mainPatcher.replaceOnce(
    "suppressPauseOnBlur",
    /(#[A-Za-z0-9_$]+=\(\)=>\{this\.#[A-Za-z0-9_$]+=!1,!this\.#[A-Za-z0-9_$]+&&this\.#[A-Za-z0-9_$]+\.isEmpty&&)(this\.#[A-Za-z0-9_$]+\(`focus-lost`\)\};)/,
    (m) => `${m[1]}!window.__srvSuppressPause&&${m[2]}`
  );
  mainPatcher.replaceOnce(
    "suppressPauseOnPointerLockLoss",
    /(!\(r\|\|!t\|\|!n\|\|(?:this\.#[A-Za-z0-9_$]+!==null|!this\.#[A-Za-z0-9_$]+\.isEmpty))(\)&&(?:this\.#[A-Za-z0-9_$]+\(\)|\(this\.#[A-Za-z0-9_$]+=performance\.now\(\)\+250,this\.#[A-Za-z0-9_$]+\(\)\)))\};/,
    (m) => `${m[1]}||window.__srvSuppressPause${m[2]}};`
  );

  // 9. Keyboard-held-state-survives-restart fix. Confirmed by reading the
  //    keyboard tracker class's actual source (not just guessing from
  //    symptoms) that its "currently held" state (a private Map, separate
  //    from the per-tick edges queue) is a per-key boolean updated only by
  //    real keydown/keyup DOM events — nothing needs to "restore" it across
  //    a restart, since the physical key was never released; the bug is
  //    entirely that THREE independent call sites explicitly wipe that
  //    state, none of which have any real reason to on an in-place retry
  //    (as opposed to actually leaving the race):
  //      a) start() unconditionally calls this.clear() (which resets BOTH
  //         the edges queue AND the held-state map) in its guard against
  //         double-starting — called every restart via this.#Oe?.start().
  //         Fixed by only resetting the edges queue.
  //      b) The retry routine (#nn(), found via searching for the site's
  //         literal `retry` telemetry-event string) calls
  //         this.#Oe?.stop() with NO ARGUMENT before the reset sequence —
  //         its signature is `stop(e=!1){this.#a&&(this.#a=!1,e?
  //         this.#f():this.clear())}`, so a bare call defaults `e` to
  //         false and therefore ALSO calls this.clear() internally. This
  //         is the site that was missed entirely on the first pass at this
  //         fix — (c) below was independently deleted, but this earlier
  //         call was still wiping the exact same state moments before (c)
  //         even ran, which is why the original fix never actually worked
  //         despite both then-known culprits being patched.
  //      c) The same retry routine ALSO calls this.#Oe?.clear() directly
  //         and explicitly, a second time, independent of both (a) and (b).
  //    (b) and (c) are fixed together in one patch below, since they sit a
  //    bounded, known distance apart in the exact same retry sequence —
  //    anchoring them jointly (rather than as two independent wildcarded
  //    matches that merely happen to be positionally adjacent) means the
  //    combined pattern is what's actually verified unique in the file,
  //    not each half separately. Deliberately does NOT touch the other two
  //    places in the bundle with the exact same `?.stop(),?.stop()` shape
  //    (matched, then rejected, during derivation) — those aren't the
  //    in-place-retry path and this has no evidence they should behave the
  //    same way.
  if (names.keyboardActive && names.keyboardDisposed && names.keyboardEdges) {
    mainPatcher.replaceOnce(
      "keyboardHeldStateSurvivesRestart_startClear",
      new RegExp(
        `start\\(\\)\\{this\\.${names.keyboardDisposed}\\|\\|this\\.${names.keyboardActive}\\|\\|\\(this\\.clear\\(\\),this\\.${names.keyboardActive}=!0\\)\\}`
      ),
      () => `start(){this.${names.keyboardDisposed}||this.${names.keyboardActive}||(this.${names.keyboardEdges}.length=0,this.${names.keyboardActive}=!0)}`
    );
  } else {
    mainPatcher.skip("keyboardHeldStateSurvivesRestart_startClear", "keyboard input tracker fields could not be derived");
  }
  mainPatcher.replaceOnce(
    "keyboardHeldStateSurvivesRestart_retrySequence",
    /(this\.#[A-Za-z0-9_$]+\?\.stop\(\)),this\.#[A-Za-z0-9_$]+\?\.stop\(\)([\s\S]{0,220}?this\.#[A-Za-z0-9_$]+\?\.reset\(\),)this\.#[A-Za-z0-9_$]+\?\.clear\(\),(this\.#[A-Za-z0-9_$]+\(!1\),this\.#[A-Za-z0-9_$]+\.reset\(\))/,
    // Note: no extra literal "," inserted between m[1] and m[2] — m[2]'s
    // own lazy [\s\S]{0,220}? already swallows the comma that originally
    // separated the two deleted calls, so adding one here produced a
    // double comma (",,") — a real syntax corruption caught by the
    // ESM-integrity check below, not something node --check alone flagged.
    (m) => `${m[1]}${m[2]}${m[3]}`
  );

  // 10. Camera-mode cycle.
  mainPatcher.replaceOnce(
    "cameraModeCycle",
    /if\(e\.code===`KeyC`&&!e\.repeat&&this\.(#[A-Za-z0-9_$]+)===null\)\{e\.preventDefault\(\),this\.(#[A-Za-z0-9_$]+)\.toggleCameraLock\(\);return\}/,
    (m) =>
      `if(e.code===\`KeyC\`&&!e.repeat&&this.${m[1]}===null){e.preventDefault();` +
      `let __v=this.${m[2]},__m=[[!0,!1]];` +
      `window.__srvEnableReverseCam===!0&&__m.push([!0,!0]);` +
      `window.__srvDisableFreecam!==!0&&__m.push([!1,!1]);` +
      `let __i=__m.findIndex(__p=>__p[0]===__v.cameraLocked&&__p[1]===__v.reverseView),` +
      `__t=__m[(Math.max(__i,0)+1)%__m.length];` +
      `__v.reverseView!==__t[1]&&__v.toggleReverseView();` +
      `__v.cameraLocked!==__t[0]&&__v.toggleCameraLock();` +
      `return}`
  );

  // 11. Anti-cheat control lock while watching a replay.
  mainPatcher.replaceOnce(
    "watchReplayControlLock_handbrake",
    /handbrake:([A-Za-z0-9_$]+)\.held\.handbrake===!0\|\|([A-Za-z0-9_$]+)\?\.handbrake===!0/,
    (m) => `handbrake:window.__srvWatchingReplayActive===!0||${m[1]}.held.handbrake===!0||${m[2]}?.handbrake===!0`
  );
  mainPatcher.replaceOnce(
    "watchReplayControlLock_throttle",
    /throttle:([A-Za-z0-9_$]+)\.held\.throttle===!0\|\|([A-Za-z0-9_$]+)\?\.throttle===!0/,
    (m) => `throttle:window.__srvWatchingReplayActive!==!0&&(${m[1]}.held.throttle===!0||${m[2]}?.throttle===!0)`
  );

  return { patchedSrc: src, liveryChunkUrl };
}

// Applies the one TerrainView/RV-chunk patch (the raceTelemetry getter).
export function patchTerrainViewChunk(tvSrc, results, log = console) {
  let src = tvSrc;
  const tvPatcher = makePatcher(
    "TerrainView chunk",
    () => src,
    (s) => (src = s),
    results,
    log
  );

  tvPatcher.insertAfter(
    "raceTelemetry",
    /get finished\(\)\{return this\.#s===`finished`\|\|this\.#s===`exhausted`\}/,
    () =>
      "get raceTelemetry(){if(this.#o==null)return null;" +
      "let e=this.#o.model.base.requireCar(this.#o.model.carEntityId).captureTelemetry();" +
      "return{nextGateIndex:this.#o.model.raceState.nextGateIndex,position:e.position,speed:e.speed,tick:this.#c}}"
  );

  return { patchedSrc: src };
}

// High-level one-shot: fetches everything live and returns fully patched
// sources plus the metadata each caller needs to do its own delivery
// (Node: write files for inspection; extension: build data: URLs and
// register dynamic rules). Throws only for hard failures (can't find the entry
// script, can't locate the RV chunk's import path at all) — individual
// patch failures are soft (recorded in `results`, everything else still
// gets produced), matching the CLI's long-standing behavior.
export async function patchLiveBundles(origin, log = console) {
  const results = [];

  const { mainFilename, mainRawSrc } = await discoverAndFetchMainBundle(origin);
  log.log(`Discovered live main bundle: ${mainFilename}`);
  const mainRewritten = rewriteRelativeChunkRefs(origin, "main bundle", mainRawSrc, log);
  const names = deriveIdentifiers(mainRewritten, mainRawSrc);
  log.log("Derived identifiers:", names);
  const { patchedSrc: mainSrc } = patchMainBundle(mainRewritten, mainRawSrc, names, origin, results, log);

  if (!names.rvChunkPath) throw new Error("Could not locate the RV/TerrainView chunk's import path in the main bundle.");
  const { tvFilename, tvRawSrc } = await fetchTerrainViewChunk(origin, names.rvChunkPath);
  log.log(`Discovered live RV/TerrainView chunk: ${tvFilename}`);
  const tvRewritten = rewriteRelativeChunkRefs(origin, "TerrainView chunk", tvRawSrc, log);
  const { patchedSrc: tvSrc } = patchTerrainViewChunk(tvRewritten, results, log);

  return { mainFilename, mainSrc, tvFilename, tvSrc, names, results };
}
