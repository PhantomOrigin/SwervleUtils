// Runtime hooks: gives srv-main.js the same `window.__srv` interface the old
// patched bundle used to provide (ready / onRaceBoot / onTick / onRender),
// without modifying or replacing any of swervle.com's code.
//
// How: swervle.com's entry script is an ES module. Importing its URL again
// returns the SAME, already-running module instance, whose exports include
// the game's own classes (scene manager, car view, replay simulator,
// renderer...). This file wraps a few of their prototype methods to observe
// the game (each physics tick, each rendered frame, each race boot) and uses
// the classes directly to build ghosts. Values that aren't exported are
// located by reading the entry script's text (which names it imports from
// which of swervle's own chunk files) and importing those chunks the same
// way. Nothing is fetched from anywhere but swervle.com, and only swervle's
// own, already-loaded modules are imported.
//
// Runs in the page's MAIN world at document_start, before srv-main.js.
(function () {
  const srv = (window.__srv = window.__srv || {});
  const TAG = "[Swervle Utils]";

  // ===================================================================
  // 1. DOM-level shims, installed immediately (before the game starts)
  // ===================================================================

  // Pause suppression. The game pauses when the window blurs or pointer
  // lock is lost; our own DOM writes can trigger either mid-race. While
  // window.__srvSuppressPause is set (srv-main.js manages it), those two
  // events are stopped before the game's listeners see them. These listeners
  // are registered at document_start, before the game's, so they run first.
  const origAdd = EventTarget.prototype.addEventListener;
  const stopIfSuppressed = (e) => {
    if (window.__srvSuppressPause) e.stopImmediatePropagation();
  };
  origAdd.call(window, "blur", stopIfSuppressed, true);
  origAdd.call(document, "pointerlockchange", stopIfSuppressed, true);

  // "Don't grab cursor" setting, and no cursor grab while watching a replay.
  const origRequestPointerLock = Element.prototype.requestPointerLock;
  if (origRequestPointerLock) {
    Element.prototype.requestPointerLock = function (...args) {
      if (window.__srvNoPointerLock || window.__srvWatchingReplay) return Promise.resolve();
      return origRequestPointerLock.apply(this, args);
    };
  }

  // Physically held keys (trusted events only), for the restart fix and the
  // replay control lock below.
  const DRIVING_KEYS = new Set([
    "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Space", "ShiftLeft", "ShiftRight",
  ]);
  const THROTTLE_KEYS = new Set(["KeyW", "ArrowUp"]);
  const held = new Map(); // code -> key
  const synth = (type, code, key) =>
    document.dispatchEvent(new KeyboardEvent(type, { code, key: key ?? "", bubbles: true, cancelable: true }));

  origAdd.call(
    window,
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      if (DRIVING_KEYS.has(e.code)) held.set(e.code, e.key);
      // While a replay is being watched and the race is running, keep the
      // player's own car still: throttle is ignored (handbrake is held, below).
      if (window.__srvWatchingReplayActive && THROTTLE_KEYS.has(e.code)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      if (e.code === "KeyC" && !e.repeat) handleCameraKey(e);
    },
    true
  );
  origAdd.call(
    window,
    "keyup",
    (e) => {
      if (!e.isTrusted) return;
      held.delete(e.code);
    },
    true
  );
  origAdd.call(window, "blur", () => held.clear());

  // Restart fix: an in-place restart makes the game forget keys that are
  // still physically held, so they don't work until re-pressed. Re-send a
  // keydown for each held driving key after the restart.
  function replayHeldKeys() {
    for (const [code, key] of held) synth("keydown", code, key);
  }

  // Replay control lock: hold the handbrake while it's active.
  let handbrakeForced = false;
  function syncControlLock() {
    const want = window.__srvWatchingReplayActive === true;
    if (want === handbrakeForced) return;
    handbrakeForced = want;
    if (want) synth("keydown", "Space", " ");
    else if (!held.has("Space")) synth("keyup", "Space", " ");
  }

  // Camera cycle on C: optionally adds reverse view, optionally removes the
  // free camera. Uses the game's own reverse-view HUD button and its own C
  // handling (lock/free), so nothing internal is touched.
  let cameraLocked = true; // the game starts each race with the camera locked
  let passNextC = false;
  function handleCameraKey(e) {
    if (passNextC) return;
    const reverseOn = window.__srvEnableReverseCam === true;
    const freeOff = window.__srvDisableFreecam === true;
    if (!reverseOn && !freeOff) return; // default behaviour
    const reverseBtn = document.querySelector('button[data-action="reverse-view"]');
    if (reverseOn && !reverseBtn) return;
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    e.stopImmediatePropagation();
    e.preventDefault();

    const modes = [{ locked: true, reverse: false }];
    if (reverseOn) modes.push({ locked: true, reverse: true });
    if (!freeOff) modes.push({ locked: false, reverse: false });
    const reverseNow = reverseBtn?.getAttribute("aria-pressed") === "true";
    const idx = modes.findIndex((m) => m.locked === cameraLocked && m.reverse === reverseNow);
    const next = modes[(Math.max(idx, 0) + 1) % modes.length];
    if (reverseBtn && next.reverse !== reverseNow) reverseBtn.click();
    if (next.locked !== cameraLocked) {
      cameraLocked = next.locked;
      passNextC = true;
      try {
        synth("keydown", "KeyC", "c");
        synth("keyup", "KeyC", "c");
      } finally {
        passNextC = false;
      }
    }
  }

  // ===================================================================
  // 2. Find the game's modules
  // ===================================================================

  const domReady = new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else origAdd.call(document, "DOMContentLoaded", () => resolve(), { once: true });
  });

  function entryScriptUrl() {
    const s = [...document.querySelectorAll('script[type="module"][src]')].find((el) =>
      /\/assets\/[^/]+\.js(?:[?#].*)?$/.test(el.src)
    );
    return s?.src ?? null;
  }

  // Reads which local names the entry script exports (and under which name)
  // and which it imports from which chunk file.
  function parseModuleLinks(text) {
    const exportsByLocal = new Map();
    const exp = text.match(/export\{([^}]*)\};?\s*$/);
    if (exp) {
      for (const part of exp[1].split(",")) {
        const m = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (m) exportsByLocal.set(m[1], m[2] ?? m[1]);
      }
    }
    const importsByLocal = new Map();
    for (const m of text.matchAll(/import\{([^}]*)\}from"([^"]+)"/g)) {
      for (const part of m[1].split(",")) {
        const p = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (p) importsByLocal.set(p[2] ?? p[1], { spec: m[2], name: p[1] });
      }
    }
    return { exportsByLocal, importsByLocal };
  }

  // Locates the names the old patcher used, from the entry script's text.
  function deriveNames(text) {
    const n = {};
    let m = text.match(/new ([\w$]+)\(\{modifiers:this\.#[\w$]+,presentationRaycastEmulation:/);
    n.RV = m?.[1] ?? null;
    m = text.match(
      /new ([\w$]+)\(\{appearance:([\w$]+),assetInstance:await this\.#[\w$]+\.instantiate\(([\w$]+)\),definition:([\w$]+),entityId:[^,]+,materialColorOverrides:([\w$]+),materialRegistrar:this\.#[\w$]+\.materialRegistrar\}\)/
    );
    n.VD = m?.[1] ?? null;
    n.appearance = m?.[2] ?? null;
    n.carContentId = m?.[3] ?? null;
    n.definition = m?.[4] ?? null;
    n.colorOverrides = m?.[5] ?? null;
    m = text.match(/nameplate==null\?null:new ([\w$]+)\([\w$]+\.nameplate\)/);
    n.Nameplate = m?.[1] ?? null;
    m = text.match(/([\w$]+)\(\{generatorVersion:[\w$]+\.generatorVersion,seed:[\w$]+\.seed\}\)/);
    n.generateTrack = m?.[1] ?? null;
    m = text.match(/=([\w$]+)\([\w$]+\.dailyId,[\w$]+\.track\.revision\.rulesetVersion,\{previewUnreleasedRules:/);
    n.modifiersFor = m?.[1] ?? null;
    m = text.match(/([\w$]+)\(`\/`\)\.filter\(\(\{contentId:[\w$]+\}\)=>[\w$]+===[\w$]+\)/);
    n.assetManifest = m?.[1] ?? null;
    m = text.match(/createGhostRaceLivery\([\w$]+,[\w$]+\)\{[\s\S]{0,400}?import\(`(\.\/[^`]+)`\)/);
    n.liveryChunk = m?.[1] ?? null;
    return n;
  }

  // Finds an exported class by the names of its prototype members.
  function findClass(mod, members) {
    for (const v of Object.values(mod)) {
      if (typeof v !== "function" || !v.prototype) continue;
      const names = new Set(Object.getOwnPropertyNames(v.prototype));
      if (members.every((x) => names.has(x))) return v;
    }
    return null;
  }

  function wrapMethod(cls, name, after, before) {
    const desc = cls && Object.getOwnPropertyDescriptor(cls.prototype, name);
    if (!desc || typeof desc.value !== "function") return false;
    const orig = desc.value;
    cls.prototype[name] = function (...args) {
      if (before) {
        try {
          before(this, args);
        } catch (err) {
          console.error(TAG, `${name} hook failed`, err);
        }
      }
      const result = orig.apply(this, args);
      if (after) {
        try {
          after(this, args, result);
        } catch (err) {
          console.error(TAG, `${name} hook failed`, err);
        }
      }
      return result;
    };
    return true;
  }

  // ===================================================================
  // 3. Ghost view (mirrors the game's own recorded-rival view: a car view
  //    plus nameplate, see-through, fading when close to your car)
  // ===================================================================

  const GHOST_OPACITY = 0.76;
  const GHOST_OPACITY_NEAR = 0.38;
  const GHOST_NEAR_DISTANCE_SQ = 3.3;
  const lerp = (a, b, t) => a + (b - a) * t;

  function makeGhostViewClass(NameplateClass) {
    return class GhostView {
      constructor({ carView, initialSnapshot, nameplate, parent }) {
        this.carView = carView;
        this.root = carView.root;
        this.snapshot = initialSnapshot;
        this.position = { x: 0, y: 0, z: 0 };
        this.saved = new Map(); // material -> original state
        this.depthMeshes = [];
        this.disposed = false;
        this.isVisible = true;
        this.nameplate = nameplate && NameplateClass ? new NameplateClass(nameplate) : null;
        try {
          carView.consumeSnapshot(initialSnapshot);
          carView.update(1);
          this.makeTranslucent();
          this.root.name = "swervle-utils-ghost";
          parent.add(this.root);
          if (this.nameplate) parent.add(this.nameplate.root);
        } catch (err) {
          this.nameplate?.dispose();
          this.restoreMaterials();
          carView.dispose();
          throw err;
        }
      }
      consumeSnapshot(s) {
        if (this.disposed) return;
        this.carView.consumeSnapshot(s);
        this.snapshot = s;
      }
      get visible() {
        return this.isVisible;
      }
      setVisible(v) {
        if (this.disposed || this.isVisible === v) return;
        this.isVisible = v;
        this.root.visible = v;
        if (this.nameplate) this.nameplate.root.visible = v;
      }
      update(alpha, selfPosition) {
        if (this.disposed) return;
        const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
        this.carView.update(a);
        const c = this.snapshot.vehicle.chassis;
        const prev = c.previousPosition ?? c.position;
        this.position = {
          x: lerp(prev.x, c.position.x, a),
          y: lerp(prev.y, c.position.y, a),
          z: lerp(prev.z, c.position.z, a),
        };
        if (selfPosition) {
          const dx = this.position.x - selfPosition.x;
          const dy = this.position.y - selfPosition.y;
          const dz = this.position.z - selfPosition.z;
          this.setOpacity(dx * dx + dy * dy + dz * dz < GHOST_NEAR_DISTANCE_SQ ? GHOST_OPACITY_NEAR : GHOST_OPACITY);
        }
      }
      updateNameplate(camera) {
        if (this.disposed || !this.nameplate) return;
        this.nameplate.update(camera.quaternion, camera.position, this.position);
      }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.nameplate?.dispose();
        this.restoreMaterials();
        this.carView.dispose();
      }
      // A depth-only copy of each mesh is drawn first, then the real mesh
      // only where it's the nearest surface — so a see-through car shows its
      // outer shell instead of its insides.
      makeTranslucent() {
        const meshes = [];
        this.root.traverse((o) => {
          if (o.isMesh) meshes.push(o);
        });
        for (const mesh of meshes) {
          mesh.castShadow = false;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (!this.saved.has(m)) {
              this.saved.set(m, {
                depthFunc: m.depthFunc, depthTest: m.depthTest, depthWrite: m.depthWrite,
                opacity: m.opacity, transparent: m.transparent,
              });
            }
            m.transparent = true;
            m.depthTest = true;
            m.depthWrite = false;
            m.depthFunc = 4; // equal: only where the depth copy below wrote
            m.needsUpdate = true;
          }
          const depthMats = mats.map((m) => {
            const d = m.clone();
            d.colorWrite = false;
            d.blending = 0;
            d.depthTest = true;
            d.depthWrite = true;
            d.depthFunc = 3;
            d.opacity = 1;
            d.transparent = true;
            return d;
          });
          const depthMesh = new mesh.constructor(mesh.geometry, Array.isArray(mesh.material) ? depthMats : depthMats[0]);
          depthMesh.name = `ghost-depth:${mesh.name}`;
          depthMesh.castShadow = false;
          depthMesh.receiveShadow = false;
          depthMesh.renderOrder = -2;
          mesh.renderOrder = -1;
          mesh.add(depthMesh);
          this.depthMeshes.push({ mesh: depthMesh, materials: depthMats });
        }
        this.setOpacity(GHOST_OPACITY);
      }
      setOpacity(f) {
        for (const [m, s] of this.saved) m.opacity = s.opacity * f;
      }
      restoreMaterials() {
        for (const d of this.depthMeshes) {
          d.mesh.removeFromParent();
          for (const m of d.materials) m.dispose();
        }
        this.depthMeshes.length = 0;
        for (const [m, s] of this.saved) Object.assign(m, s, { needsUpdate: true });
        this.saved.clear();
      }
    };
  }

  // ===================================================================
  // 4. Race state, from the game's own per-tick calls
  // ===================================================================

  let activeScene = null; // the scene manager of the current race
  let lastAlpha = 1;
  let lastCamera = null;
  let assetFactory = null;
  const race = { phase: "ready", tick: 0, started: false, nextGateIndex: 0, gateCount: 0, displayTimeMs: null, car: null };

  function resetRaceState() {
    race.phase = "ready";
    race.tick = 0;
    race.started = false;
    race.nextGateIndex = 0;
    race.displayTimeMs = null;
  }

  function carSnapshotOf(snapshot) {
    for (const ent of snapshot?.entities ?? []) {
      const s = ent.snapshot;
      if (s && typeof s.speed === "number" && s.vehicle?.chassis) return s;
    }
    return null;
  }

  function onSceneSnapshot(scene, snapshot) {
    if (scene !== activeScene) return;
    race.car = carSnapshotOf(snapshot) ?? race.car;
  }

  function onSceneEvents(scene, events) {
    if (scene !== activeScene) return;
    if (race.started) race.tick++;
    for (const ev of events ?? []) {
      const p = ev?.payload ?? {};
      switch (ev?.type) {
        case "race-ready":
          if (Number.isFinite(p.gateCount)) race.gateCount = p.gateCount;
          break;
        case "race-countdown-start":
          race.phase = "countdown";
          race.tick = 0;
          race.started = false;
          race.nextGateIndex = 0;
          race.displayTimeMs = null;
          setTimeout(replayHeldKeys, 0);
          break;
        case "race-go":
          race.phase = "racing";
          race.tick = 0;
          race.started = true;
          break;
        case "race-checkpoint":
          if (Number.isFinite(p.nextGateIndex)) race.nextGateIndex = p.nextGateIndex;
          break;
        case "race-finish":
          if (Number.isFinite(p.nextGateIndex)) race.nextGateIndex = p.nextGateIndex;
          race.displayTimeMs = Number.isFinite(p.displayTimeMs) ? p.displayTimeMs : null;
          race.phase = "finished";
          race.started = false;
          break;
        case "race-dnf":
          race.phase = "dnf";
          race.started = false;
          break;
        case "race-invalid":
          race.phase = "invalid";
          race.started = false;
          break;
      }
    }
    syncControlLock();
    const car = race.car;
    try {
      srv.onTick?.({
        tick: race.tick,
        nextGateIndex: race.nextGateIndex,
        gateCount: race.gateCount || (srv.ready?.track?.gates?.length ?? 0),
        speed: car?.speed ?? 0,
        position: car?.vehicle?.chassis?.position ?? null,
        phase: race.phase,
        displayTimeMs: race.displayTimeMs,
        gear: car?.gear ?? 0,
        shiftTimer: car?.shiftTimer ?? 0,
      });
    } catch (err) {
      console.error(TAG, "onTick failed", err);
    }
  }

  // ===================================================================
  // 5. Wire it up
  // ===================================================================

  async function start() {
    await domReady;
    const url = entryScriptUrl();
    if (!url) {
      console.warn(TAG, "couldn't find swervle.com's entry script; in-game features are off");
      return;
    }
    let mod;
    try {
      mod = await import(url);
    } catch (err) {
      console.error(TAG, "couldn't load swervle.com's entry module", err);
      return;
    }

    // Prototype hooks first (the game only uses these once a race starts).
    const SceneManager = findClass(mod, ["consumeSnapshot", "consumeEvents", "viewParent", "materialRegistrar"]);
    const AssetFactory = findClass(mod, ["instantiate", "preload"]);
    const Renderer = findClass(mod, ["render", "precompile", "setComposerEnabled"]);
    if (!SceneManager || !Renderer) {
      console.warn(TAG, "swervle.com's game classes weren't recognised; in-game features are off");
      return;
    }
    wrapMethod(AssetFactory, "instantiate", null, (self) => {
      assetFactory = self;
    });
    wrapMethod(AssetFactory, "preload", null, (self) => {
      assetFactory = self;
    });
    wrapMethod(SceneManager, "initialize", (self) => {
      activeScene = self;
      resetRaceState();
      cameraLocked = true;
      onRaceBoot(self);
    });
    wrapMethod(SceneManager, "dispose", null, (self) => {
      if (self !== activeScene) return;
      activeScene = null;
      srv.ready = null;
      bootSeq++;
    });
    wrapMethod(SceneManager, "reset", (self) => {
      if (self !== activeScene) return;
      resetRaceState();
      setTimeout(replayHeldKeys, 0);
    });
    // If the race was already set up before these hooks were installed, adopt
    // its scene manager the first time the game uses it.
    const adopt = (self) => {
      if (activeScene) return;
      activeScene = self;
      resetRaceState();
      onRaceBoot(self);
    };
    wrapMethod(SceneManager, "consumeSnapshot", (self, [snap]) => {
      adopt(self);
      onSceneSnapshot(self, snap);
    });
    wrapMethod(SceneManager, "consumeEvents", (self, [events]) => onSceneEvents(self, events));
    wrapMethod(SceneManager, "update", null, (self, [alpha]) => {
      adopt(self);
      if (self === activeScene && Number.isFinite(alpha)) lastAlpha = alpha;
    });
    wrapMethod(SceneManager, "updateHeldCamera", null, (self, [alpha]) => {
      if (self === activeScene && Number.isFinite(alpha)) lastAlpha = alpha;
    });
    wrapMethod(Renderer, "render", null, (_self, [camera]) => {
      if (!camera || !activeScene || !srv.ready) return;
      lastCamera = camera;
      srv.onRender?.({ alpha: lastAlpha, camera });
    });

    // Then everything that needs the entry script's text.
    let text;
    try {
      text = await fetch(url).then((r) => r.text());
    } catch (err) {
      console.error(TAG, "couldn't read swervle.com's entry script", err);
      return;
    }
    const links = parseModuleLinks(text);
    const names = deriveNames(text);
    const chunkCache = new Map();
    async function resolve(local) {
      if (!local) return undefined;
      const exported = links.exportsByLocal.get(local);
      if (exported !== undefined) return mod[exported];
      const imp = links.importsByLocal.get(local);
      if (!imp) return undefined;
      const chunkUrl = new URL(imp.spec, url).href;
      if (!chunkCache.has(chunkUrl)) chunkCache.set(chunkUrl, import(chunkUrl));
      return (await chunkCache.get(chunkUrl))[imp.name];
    }

    const [RV, VD, appearance, definition, colorOverrides, Nameplate, generateTrack, modifiersFor, assetManifest] = await Promise.all(
      [names.RV, names.VD, names.appearance, names.definition, names.colorOverrides, names.Nameplate, names.generateTrack, names.modifiersFor, names.assetManifest].map(
        (n) => resolve(n).catch(() => undefined)
      )
    );
    const missing = Object.entries({ RV, VD, definition, generateTrack })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) console.warn(TAG, "some game parts weren't found, ghosts/splits are off:", missing.join(", "));

    // Values that aren't exported anywhere fall back to the exported copies
    // the game uses for other cars (same car, different default palette).
    const exportedObjects = Object.values(mod).filter((v) => v && typeof v === "object");
    const fallbackOverrides = exportedObjects.find((v) => {
      const k = Object.keys(v);
      return k.length === 2 && k.includes("Car") && k.includes("Wheel");
    });
    const fallbackAppearance = exportedObjects.find((v) => Array.isArray(v.geometries));

    pieces = {
      RV: RV ?? findClass(mod, ["replayTickCount", "captureFrame", "step"]),
      VD: VD ?? findClass(mod, ["copyInterpolatedChassisQuaternion", "consumeSnapshot", "update"]),
      appearance: appearance ?? fallbackAppearance,
      definition,
      colorOverrides: colorOverrides ?? fallbackOverrides ?? { Car: 0xffffff },
      GhostView: makeGhostViewClass(Nameplate),
      generateTrack,
      modifiersFor,
      liveryChunkUrl: names.liveryChunk ? new URL(names.liveryChunk, url).href : null,
      // Used only if the game's own asset factory wasn't seen being used:
      // a separate factory for the same car asset.
      makeAssetFactory:
        AssetFactory && typeof assetManifest === "function" && definition
          ? () => new AssetFactory({ manifest: assetManifest("/").filter((m) => m.contentId === definition.contentId) })
          : null,
    };
    if (activeScene && !srv.ready) onRaceBoot(activeScene);
  }

  let pieces = null;
  const trackCache = new Map(); // dailyId/challenge -> Promise<{track, modifiers}>

  // Which race is loaded, from the page path: /daily/<id>, /r/<challenge>, or today.
  function routeManifestUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "r" && parts[1]) return `/api/v1/challenges/${encodeURIComponent(parts[1])}`;
    if (parts[0] === "daily" && parts[1]) return `/api/v1/daily?date=${encodeURIComponent(parts[1])}`;
    return "/api/v1/daily";
  }

  function loadTrack() {
    const key = routeManifestUrl();
    if (!trackCache.has(key)) {
      trackCache.set(
        key,
        (async () => {
          const res = await fetch(key, { credentials: "include" });
          if (!res.ok) throw new Error(`race manifest: HTTP ${res.status}`);
          const manifest = await res.json();
          const rev = manifest?.track?.revision;
          if (!rev) throw new Error("race manifest has no track revision");
          const generated = pieces.generateTrack({ generatorVersion: rev.generatorVersion, seed: rev.seed });
          if (generated?.revision?.trackDigest !== rev.trackDigest) throw new Error("generated track doesn't match the race");
          // The generator stamps its own default ruleset; the race's ruleset
          // comes from the manifest (the replay simulator needs it to match).
          const track = Object.freeze({
            ...generated,
            revision: Object.freeze({ ...generated.revision, rulesetVersion: rev.rulesetVersion }),
          });
          const modifiers = pieces.modifiersFor
            ? pieces.modifiersFor(manifest.dailyId, rev.rulesetVersion, { previewUnreleasedRules: false })
            : undefined;
          return { track, modifiers };
        })()
      );
      trackCache.get(key).catch(() => trackCache.delete(key));
    }
    return trackCache.get(key);
  }

  let bootSeq = 0;
  async function onRaceBoot(scene) {
    const seq = ++bootSeq;
    srv.ready = null;
    if (!pieces || !pieces.RV || !pieces.VD || !pieces.definition || !pieces.generateTrack) return;
    let loaded;
    try {
      loaded = await loadTrack();
    } catch (err) {
      console.error(TAG, "couldn't prepare the race for ghosts/splits", err);
      return;
    }
    if (seq !== bootSeq || scene !== activeScene) return; // superseded
    const liveryUrl = pieces.liveryChunkUrl;
    srv.ready = {
      RV: pieces.RV,
      GL: pieces.GhostView,
      VD: pieces.VD,
      appearance: pieces.appearance,
      carDef: pieces.definition.contentId,
      definition: pieces.definition,
      materialColorOverrides: pieces.colorOverrides,
      buildNameplate: ({ displayName }) => (displayName && String(displayName).trim()) || "Racer",
      viewParent: scene.viewParent,
      materialRegistrar: scene.materialRegistrar,
      modifiers: loaded.modifiers,
      track: loaded.track,
      get assetFactory() {
        if (!assetFactory && pieces.makeAssetFactory) assetFactory = pieces.makeAssetFactory();
        return assetFactory;
      },
      liveryModuleUrl: liveryUrl,
      loadLiveryModule: () => (liveryUrl ? import(liveryUrl) : Promise.reject(new Error("livery module not found"))),
      get camera() {
        return lastCamera;
      },
    };
    if (!race.gateCount) race.gateCount = loaded.track.gates?.length ?? 0;
    try {
      srv.onRaceBoot?.();
    } catch (err) {
      console.error(TAG, "onRaceBoot failed", err);
    }
  }

  start().catch((err) => console.error(TAG, "startup failed", err));
})();
