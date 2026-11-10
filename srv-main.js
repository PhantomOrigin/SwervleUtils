// Runs in the PAGE's own JS world (not the extension's isolated world), at
// document_start. hooks.js (loaded just before this) watches the game
// through its own classes and provides window.__srv.ready plus the
// onRaceBoot/onTick/onRender callbacks this file defines; swervle.com's code
// itself is never modified.
//
// content.js (an isolated-world content script) can't see any of this
// directly — isolated and MAIN worlds don't share JS state, only the DOM.
// So this file and content.js talk over CustomEvents on `document`.
(function () {
  window.__srv = window.__srv || {};

  // Extension settings toggles (content.js's Swervle Utils menu,
  // DRIVING_SETTINGS), read by hooks.js. Applied on page load.
  try {
    window.__srvNoPointerLock = localStorage.getItem("srv-no-pointer-lock") === "true";
    window.__srvEnableReverseCam = localStorage.getItem("srv-enable-reverse-cam") === "true";
    window.__srvDisableFreecam = localStorage.getItem("srv-disable-freecam") === "true";
    window.__srvHideGateMarkers = localStorage.getItem("srv-hide-gate-markers") === "true";
  } catch {}

  // Automatic (not a setting — always on) pointer-lock bypass while
  // actively spectating a replay: kept up to date by the
  // srv:setCameraFollow handler below, whenever the currently-followed
  // ghost changes. There's no legitimate reason to want the cursor
  // captured while watching rather than driving, so this isn't gated
  // behind an opt-in the way __srvNoPointerLock is.
  window.__srvWatchingReplay = false;
  // True only while a replay is being watched AND the player's own race is
  // running; hooks.js then keeps the player's car still (handbrake held,
  // throttle ignored).
  window.__srvWatchingReplayActive = false;
  function updateWatchingReplayActive() {
    window.__srvWatchingReplayActive = window.__srvWatchingReplay === true && playerPhase === "racing";
  }

  // Pause-suppression flag (read by hooks.js) —
  // content.js/splits.js can't set window.__srvSuppressPause directly,
  // since isolated and MAIN worlds don't share a `window`, so they dispatch
  // this event instead and this file (which DOES share the real page
  // window) sets the actual flag hooks.js checks. Reference-
  // counted, not a flat boolean: the leaderboard and the splits panel each
  // wrap their own DOM writes in this independently, and their suppress
  // windows can overlap (both mutating DOM within the same couple of
  // frames) — a flat boolean would let whichever one finishes first
  // prematurely clear it while the other's mutation is still in its own
  // suppress window.
  let suppressPauseCount = 0;
  window.__srvSuppressPause = false;
  document.addEventListener("srv:suppressPause", (e) => {
    suppressPauseCount = Math.max(0, suppressPauseCount + (e.detail?.suppress ? 1 : -1));
    window.__srvSuppressPause = suppressPauseCount > 0;
  });

  // Ghosts are keyed by `key` (the run's publicRunId), not an opaque id —
  // this is what makes spawning idempotent: asking to spawn a key that's
  // already up (or already being spawned) just reuses it instead of adding
  // a second overlapping car.
  //
  // `manual` (null unless this is the currently-followed/watched ghost) is
  // what makes the progress-bar/speed-multiplier controls possible: normal
  // ghosts step exactly once per real physics tick (see onTick below), tied
  // 1:1 to the player's own race — fine for a PB ghost racing alongside
  // you, but it means a plain "watch" has no independent speed or seek at
  // all. The followed ghost instead gets stepped from onRender using its
  // own accumulated virtual clock ({ speed, accumTicks }), completely
  // decoupled from the player's real tick/phase — scaled by `speed`, and
  // seekable by resetting and fast-forwarding to an arbitrary tick (see
  // seekGhost) the same way computeSplits silently fast-forwards a PB to
  // read its splits. `seeking` pauses manual stepping while a seek's
  // fast-forward loop is in flight, so the two don't fight over the same
  // rv.step() calls.
  const ghosts = new Map(); // key -> { rv, gl, states, disposed, manual, seeking }
  const pendingSpawns = new Map(); // key -> Promise<void>
  let followKey = null;
  let lastTick = -1;
  let nextGateIndex = 0; // from onTick telemetry — which gate marker (see below) should be visible
  let playerPhase = null; // the real player's own race phase, from onTick telemetry — see stepManualGhosts
  // The site's own fixed physics step is exactly 1/60s (confirmed directly
  // from its GameLoop constants) — can't read decoder.js's own TICK_RATE
  // constant instead since it's an isolated-world script and this file runs
  // in the MAIN world; the two don't share `window` state at all.
  const TICK_RATE = 60;

  function dispatch(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // A genuinely new race (new day, new track, or the daily's own "run again"
  // flow — not a simple in-place retry) reassigns window.__srv.ready to a
  // fresh scene context (hooks.js calls this right after). Ghosts spawned
  // against the *old* context have no business surviving into a new one, so
  // clear them out rather than risk them referencing stale/disposed scene
  // objects (which is one plausible source of "duplicate car" rendering
  // artifacts — an orphaned ghost still being stepped/rendered alongside a
  // freshly (re)spawned one for the same run).
  window.__srv.onRaceBoot = () => {
    for (const key of [...ghosts.keys()]) despawnGhost(key);
    lastTick = -1;
    nextGateIndex = 0;
    rebuildGateMarkers();
  };

  // ---- checkpoint number / finish markers ----
  //
  // Floating HTML labels, one per gate in the track manifest (already
  // exposed as ready.track.gates — no bundle patch needed for this), kept
  // pinned over each gate's live 3D position via plain screen-space
  // projection every render frame (see projectToScreen below) rather than
  // real THREE.js Sprites — srv-main.js has no import of the site's THREE.js
  // build, and grabbing one just for this would mean depending on yet
  // another chunk's internal export layout. Camera.matrixWorldInverse/
  // projectionMatrix are plain properties already present on the real
  // camera object hooks.js hands us, so the actual math needs nothing
  // beyond that.
  //
  // Only the marker for the CURRENT next gate (nextGateIndex, tracked from
  // onTick telemetry below) is ever shown — all others stay built (so
  // there's no rebuild cost mid-race) but hidden, so exactly one number is
  // ever on screen at a time, whichever gate you're actually headed for
  // next. That's also why the finish gate's own marker only appears once
  // it's genuinely next — it's just gate index 3 like any other, not a
  // special case.
  let gateMarkers = []; // { el, worldPos: {x,y,z}, gateIndex }

  function rebuildGateMarkers() {
    for (const m of gateMarkers) m.el.remove();
    gateMarkers = [];
    if (window.__srvHideGateMarkers) return;
    const gates = window.__srv.ready?.track?.gates;
    if (!gates) return;
    for (const gate of gates) {
      const isFinish = gate.kind === "finish";
      const el = document.createElement("div");
      el.className = "srv-gate-marker";
      el.textContent = isFinish ? "FINISH" : String(gate.index + 1);
      Object.assign(el.style, {
        position: "fixed",
        left: "0",
        top: "0",
        transform: "translate(-50%, -100%)",
        padding: isFinish ? "3px 7px" : "2px 7px",
        borderRadius: "999px",
        background: isFinish ? "rgba(214, 40, 40, 0.88)" : "rgba(12, 14, 20, 0.78)",
        border: isFinish ? "1px solid rgba(255, 120, 120, 0.9)" : "1px solid rgba(255, 255, 255, 0.25)",
        color: "#fff",
        fontFamily: "sans-serif",
        fontWeight: "800",
        fontSize: isFinish ? "13px" : "12px",
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        zIndex: "999996",
        textShadow: "0 1px 3px rgba(0, 0, 0, 0.6)",
        display: "none",
      });
      document.body.appendChild(el);
      // A little above the gate's own physical top edge (halfHeight above
      // its center, along its own "vertical" axis), not just above center,
      // so the label clears the gate structure instead of overlapping it.
      const worldPos = {
        x: gate.center.x + gate.vertical.x * (gate.halfHeight + 1.2),
        y: gate.center.y + gate.vertical.y * (gate.halfHeight + 1.2),
        z: gate.center.z + gate.vertical.z * (gate.halfHeight + 1.2),
      };
      gateMarkers.push({ el, worldPos, gateIndex: gate.index });
    }
  }

  // Projects a world-space point through the live camera's own matrices
  // (view * projection) into CSS pixel coordinates — the same math
  // THREE.Vector3.project() does, done by hand so this doesn't need a
  // THREE.js class reference. Returns null if the point is behind the
  // camera (nothing sensible to draw there).
  function projectToScreen(pos, camera) {
    const ve = camera.matrixWorldInverse.elements;
    const pe = camera.projectionMatrix.elements;
    const { x, y, z } = pos;
    const vx = ve[0] * x + ve[4] * y + ve[8] * z + ve[12];
    const vy = ve[1] * x + ve[5] * y + ve[9] * z + ve[13];
    const vz = ve[2] * x + ve[6] * y + ve[10] * z + ve[14];
    const cx = pe[0] * vx + pe[4] * vy + pe[8] * vz + pe[12];
    const cy = pe[1] * vx + pe[5] * vy + pe[9] * vz + pe[13];
    const cw = pe[3] * vx + pe[7] * vy + pe[11] * vz + pe[15];
    if (cw <= 0.0001) return null;
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return {
      x: (ndcX * 0.5 + 0.5) * window.innerWidth,
      y: (1 - (ndcY * 0.5 + 0.5)) * window.innerHeight,
    };
  }

  function updateGateMarkers(camera) {
    if (gateMarkers.length === 0 || !camera) return;
    for (const m of gateMarkers) {
      if (m.gateIndex !== nextGateIndex) {
        m.el.style.display = "none";
        continue;
      }
      const screen = projectToScreen(m.worldPos, camera);
      if (screen === null) {
        m.el.style.display = "none";
        continue;
      }
      m.el.style.display = "block";
      m.el.style.left = `${screen.x}px`;
      m.el.style.top = `${screen.y}px`;
    }
  }

  // ---- per-tick / per-render hooks called by hooks.js ----

  // Ghosts only advance once the *real* race is actually racing (phase
  // `racing`, i.e. countdown/pointer-lock-grab is over) — one real physics
  // tick steps every live ghost exactly once, so a ghost's own countdown
  // lines up with the player's instead of it having ticked in the
  // background the whole time.
  // One physics step of a ghost's replay, plus bookkeeping the watch-mode HUD
  // needs: how many checkpoints it has passed and, once it finishes, the
  // game's own exact finish time. (Ghost replays are created with
  // capturePresentationData, so each frame carries the race events from that step.)
  function stepGhost(g) {
    g.rv.step();
    for (const ev of g.rv.frame.events ?? []) {
      if (ev.type === "race-checkpoint" || ev.type === "race-finish") {
        const passed = Number.isFinite(ev.payload?.nextGateIndex) ? ev.payload.nextGateIndex : (ev.payload?.gateIndex ?? 0) + 1;
        g.gatesPassed = Math.max(g.gatesPassed ?? 0, passed);
        if (ev.type === "race-finish" && Number.isFinite(ev.payload?.displayTimeMs)) g.finishMs = ev.payload.displayTimeMs;
      }
    }
  }
  function resetGhostProgress(g) {
    g.gatesPassed = 0;
    g.finishMs = null;
  }

  window.__srv.onTick = (telemetry) => {
    dispatch("srv:tick", telemetry);
    nextGateIndex = telemetry.nextGateIndex ?? nextGateIndex;
    playerPhase = telemetry.phase ?? playerPhase;
    updateWatchingReplayActive();

    // A big backwards jump in tick count means the player retried/reset the
    // race in place (same scene, no onRaceBoot) — restart every live ghost
    // back to its own start line so it replays from the beginning alongside
    // the player's new attempt, instead of continuing (or sitting finished)
    // from wherever it was. That includes the watched (manual) ghost: pressing
    // restart resets it to the start too, and it then waits at the line until
    // the player's own timer actually starts (awaitGo, cleared in
    // stepManualGhosts), so it runs level with every other ghost instead of
    // restarting early and running ahead of the timer.
    if (telemetry.tick < lastTick - 5) {
      master.tick = 0;
      master.accum = 0;
      for (const g of ghosts.values()) {
        if (g.disposed) continue;
        try {
          g.rv.restart(g.states);
          resetGhostProgress(g);
          if (!g.seeking) g.gl.consumeSnapshot(g.rv.frame.car); // snap the car back to the start line
          if (g.manual) {
            g.manual.accumTicks = 0;
            g.manual.lastTimestamp = null;
            g.manual.awaitGo = true;
          }
        } catch (err) {
          console.error("[Swervle Replay Viewer] ghost restart failed", err);
        }
      }
    }
    lastTick = telemetry.tick;

    if (telemetry.phase === "racing") {
      for (const g of ghosts.values()) {
        // Manual ghosts step from onRender on their own virtual clock (see
        // stepManualGhosts below), not here — this loop is only for ghosts
        // still synced 1:1 to the player's real race ticks.
        if (g.disposed || g.manual || followKey !== null || g.rv.finished) continue;
        try {
          stepGhost(g);
          // consumeSnapshot only needs the fresh tick data step() just
          // produced — it does NOT depend on alpha/render-frame timing —
          // so it belongs here, once per tick, not in onRender. It used to
          // run there instead, meaning every ghost repeated this same
          // (non-free — it's the site's own consumeSnapshot, doing real
          // per-call work, not a trivial reference copy) call once per
          // RENDERED frame even though frame.car hadn't changed since the
          // last tick. At a 60Hz tick rate that's harmless on a 60Hz
          // display, but on a 240Hz display it's 4x redundant work per
          // ghost per tick — exactly the kind of per-frame cost that can
          // make this hook's own execution time the bottleneck, silently
          // capping ghost updates near the tick rate while everything
          // else on screen (driven by the engine directly, not by this
          // handler) keeps rendering at the display's true refresh rate.
          g.gl.consumeSnapshot(g.rv.frame.car);
        } catch (err) {
          console.error("[Swervle Replay Viewer] ghost step failed", err);
        }
      }
    }
  };

  // Advances every "manual" (currently-followed/watched) ghost on its own
  // independent virtual clock, completely decoupled from the player's real
  // race tick/phase — this is what makes the progress bar and speed
  // multiplier possible. Driven from onRender (called every rendered frame
  // regardless of the player's own race phase — even sitting at the ready
  // screen or pause menu) rather than onTick (which only ever fires while
  // the player is actually "racing"), so a replay can be watched/scrubbed
  // any time a race scene exists, not just mid-race.
  //
  // Also does what onTick's per-tick dispatch used to do for the followed
  // ghost (the live input-overlay/progress-bar feed) — onTick no longer
  // touches manual ghosts at all, so that dispatch moved here with it.
  const MAX_STEPS_PER_FRAME = 30; // guards a huge catch-up burst after e.g. a backgrounded tab
  // One shared clock for the whole watch session: every extension ghost
  // (not just the followed one) is stepped from it, so pause, speed and the
  // scrub bar affect all of them together. Ghosts all start at tick 0, so a
  // given master tick is the same moment in every run.
  const master = { tick: 0, accum: 0, paused: false };
  function masterTotal() {
    let t = 0;
    for (const g of ghosts.values()) if (!g.disposed) t = Math.max(t, g.states.length);
    return t;
  }
  function stepManualGhosts(now) {
    const fg = followKey !== null ? ghosts.get(followKey) : null;
    if (!fg || fg.disposed || !fg.manual || fg.seeking) return;
    const m = fg.manual;
    // Held during the player's own countdown, and after a restart until the
    // player's timer starts (awaitGo), so replays line up with "GO". Also held
    // while paused. Keeps resetting lastTimestamp rather than skipping the
    // accumulation, so no backlog of real time builds up to release at once.
    if (m.awaitGo && playerPhase === "racing") m.awaitGo = false;
    const holding = playerPhase === "countdown" || m.awaitGo === true || master.paused;
    const total = masterTotal();
    if (m.lastTimestamp === null || holding) {
      m.lastTimestamp = now;
    } else {
      const dt = (now - m.lastTimestamp) / 1000;
      m.lastTimestamp = now;
      if (master.tick < total) {
        master.accum += dt * TICK_RATE * m.speed;
        let steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(master.accum));
        if (steps > 0) {
          master.accum -= steps;
          master.tick = Math.min(total, master.tick + steps);
          for (const g of ghosts.values()) {
            if (g.disposed || g.seeking) continue;
            try {
              let n = steps;
              while (n-- > 0 && !g.rv.finished) stepGhost(g);
              g.gl.consumeSnapshot(g.rv.frame.car);
            } catch (err) {
              console.error("[Swervle Replay Viewer] ghost step failed", err);
            }
          }
        }
      }
    }
    const car = fg.rv.frame?.car;
    dispatch("srv:ghostInput", {
      key: followKey,
      inputByte: fg.states[fg.rv.replayTick] ?? 0,
      tick: fg.rv.replayTick,
      totalTicks: fg.states.length,
      masterTick: master.tick,
      masterTotal: total,
      paused: master.paused,
      finished: fg.rv.finished,
      // What the watch-mode HUD shows in place of the player's own run.
      speed: car?.speed ?? 0,
      gear: car?.gear ?? 0,
      shiftTimer: car?.shiftTimer ?? 0,
      gatesPassed: fg.gatesPassed ?? 0,
      gateCount: window.__srv.ready?.track?.gates?.length ?? 0,
      timeMs: fg.finishMs ?? (fg.rv.replayTick * 1000) / TICK_RATE,
    });
  }

  // The camera's view matrix is normally refreshed by the renderer AFTER this
  // runs, so anything projected from the camera's pose here (checkpoint
  // numbers, nameplates) would use last frame's matrix — visibly trailing
  // behind whenever the camera moves, which is constant while a chase-cam
  // follows a replay. Recompute it from the camera's current pose first.
  function refreshCameraMatrices(camera) {
    try {
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    } catch {}
  }

  // ===================================================================
  // Sky clouds: a big dome around the camera whose surface is a procedural
  // cloud layer (noise in a shader), seen in perspective so the clouds shrink
  // and bunch up toward the horizon, and slowly scroll. Drawn over the game's
  // own sky and behind everything else (depth-tested), so terrain and cars
  // cover it. Purely cosmetic. The game's 3D classes aren't imported anywhere
  // we can reach, so they're borrowed from an object already in the scene (an
  // existing mesh's constructors), like ghost views do. Toggled live with the
  // `srv-hide-clouds` class the settings menu puts on <html>.
  // ===================================================================
  const clouds = { vp: null, mesh: null, material: null, uniforms: null, tries: 0, start: 0, failed: false };

  function findSceneClasses(root) {
    let found = null;
    root.traverse((o) => {
      if (found || !o.isMesh || Array.isArray(o.material) || !o.geometry?.attributes?.position) return;
      const m = o.material;
      if (!(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshBasicMaterial || m.isMeshToonMaterial)) return;
      found = { Mesh: o.constructor, Material: m.constructor, Geometry: o.geometry.constructor, Attribute: o.geometry.attributes.position.constructor };
    });
    return found;
  }

  // Low-poly unit sphere (icosahedron, subdivided once) as a flat position array.
  function domePositions() {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    const norm = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
    const V = raw.map(norm);
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const mid = (a, b) => norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    const out = [];
    for (const [i, j, k] of F) {
      const a = V[i], b = V[j], c = V[k];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      for (const tri of [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]) for (const v of tri) out.push(v[0], v[1], v[2]);
    }
    return new Float32Array(out);
  }

  const CLOUD_VERT_DECL = "varying vec3 vSkyDir;\n";
  const CLOUD_FRAG_DECL = `
    varying vec3 vSkyDir;
    uniform float uTime;
    uniform vec3 uFog;
    float srvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float srvNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(srvHash(i), srvHash(i + vec2(1.0, 0.0)), f.x), mix(srvHash(i + vec2(0.0, 1.0)), srvHash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float srvFbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * srvNoise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; }
      return v;
    }
  `;
  const CLOUD_FRAG_MAIN = `
    {
      vec3 d = normalize(vSkyDir);
      if (d.y <= 0.0) discard;
      // Project the view direction onto a flat cloud layer: perspective makes
      // the clouds shrink and crowd together toward the horizon.
      vec2 uv = d.xz / (d.y + 0.07) * 1.1 + vec2(uTime * 0.010, uTime * 0.004);
      float c = srvFbm(uv);
      float cover = smoothstep(0.43, 0.68, c);
      float shade = srvFbm(uv + vec2(0.05, 0.10));
      float lit = clamp(0.55 + (c - shade) * 3.5, 0.0, 1.0);
      vec3 cloudCol = mix(vec3(0.76, 0.82, 0.92), vec3(1.0), lit);
      // Blue sky: pale haze at the horizon deepening to a clear blue overhead.
      vec3 sky = mix(vec3(0.66, 0.82, 0.97), vec3(0.14, 0.42, 0.92), pow(clamp(d.y, 0.0, 1.0), 0.45));
      float fade = smoothstep(0.0, 0.2, d.y);
      vec3 col = mix(sky, cloudCol, cover * 0.97);
      col = mix(uFog, col, fade);
      float a = smoothstep(0.0, 0.07, d.y);
      gl_FragColor = vec4(col, a);
    }
  `;

  function disposeClouds() {
    if (clouds.mesh) {
      clouds.mesh.removeFromParent();
      clouds.mesh.geometry.dispose?.();
      clouds.material?.dispose?.();
    }
    clouds.mesh = null;
    clouds.material = null;
    clouds.uniforms = null;
    clouds.vp = null;
  }

  function buildClouds(vp, camera) {
    const cls = findSceneClasses(vp);
    if (!cls) return false;
    let top = vp;
    while (top.parent) top = top.parent;

    const uniforms = { uTime: { value: 0 }, uFog: { value: { r: 0.72, g: 0.82, b: 0.93 } } };
    const fog = top.fog?.color;
    const mat = new cls.Material();
    if ("fog" in mat) mat.fog = false;
    mat.side = 2; // DoubleSide: winding doesn't matter, it's seen from inside
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uFog = uniforms.uFog;
      shader.vertexShader = CLOUD_VERT_DECL + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vSkyDir = position;");
      shader.fragmentShader = CLOUD_FRAG_DECL + shader.fragmentShader.replace("#include <dithering_fragment>", "#include <dithering_fragment>\n" + CLOUD_FRAG_MAIN);
      if (!shader.fragmentShader.includes("srvFbm(uv)") || !shader.vertexShader.includes("vSkyDir = position")) {
        // This material type doesn't have the chunks we hook into: draw nothing rather than a white dome.
        clouds.failed = true;
        if (clouds.mesh) clouds.mesh.visible = false;
        console.error("[Swervle Replay Viewer] clouds disabled: unsupported material");
      }
    };
    mat.customProgramCacheKey = () => "swervle-utils-clouds";
    mat.needsUpdate = true;

    const geo = new cls.Geometry();
    for (const name of Object.keys(geo.attributes ?? {})) geo.deleteAttribute(name);
    geo.setIndex(null);
    geo.setAttribute("position", new cls.Attribute(domePositions(), 3));
    const mesh = new cls.Mesh(geo, mat);
    mesh.name = "swervle-utils-clouds";
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = -10000; // first among transparent objects, so cars/ghosts blend over it
    top.add(mesh);

    clouds.mesh = mesh;
    clouds.material = mat;
    clouds.uniforms = uniforms;
    clouds.vp = vp;
    clouds.start = performance.now();
    if (fog && "r" in fog) {
      uniforms.uFog.value = { r: fog.r, g: fog.g, b: fog.b };
    }
    return true;
  }

  function updateClouds(camera, now) {
    if (clouds.failed) return;
    try {
      const vp = window.__srv.ready?.viewParent;
      if (!vp || !camera) return;
      const hidden = document.documentElement.classList.contains("srv-hide-clouds");
      if (clouds.mesh && clouds.vp !== vp) disposeClouds(); // a new race scene
      if (!clouds.mesh) {
        if (hidden || clouds.tries++ % 30 !== 0) return; // retry every ~30 frames until the scene has a mesh to borrow from
        if (!buildClouds(vp, camera)) return;
      }
      clouds.mesh.visible = !hidden;
      if (hidden) return;
      const far = camera.far > 0 ? camera.far : 1000;
      const r = Math.max(50, far * 0.9);
      clouds.mesh.scale.set(r, r, r);
      clouds.mesh.position.set(camera.position.x, camera.position.y, camera.position.z);
      clouds.uniforms.uTime.value = (now - clouds.start) / 1000;
    } catch (err) {
      clouds.failed = true;
      console.error("[Swervle Replay Viewer] clouds disabled", err);
    }
  }

  window.__srv.onRender = ({ alpha, camera }) => {
    stepManualGhosts(performance.now());

    // Chase-cam repositioning must happen BEFORE the nameplate billboarding
    // below, not after — updateNameplate() bakes in whatever camera
    // orientation is current *right now*, so doing this after would leave
    // every nameplate always one frame stale relative to the chase camera.
    // At 60fps that's a ~16ms lag, not the "frozen for the entire race"
    // that was reported, so this alone probably isn't the full story, but
    // it's a real bug worth fixing regardless.
    if (followKey !== null && camera) {
      const g = ghosts.get(followKey);
      if (g && !g.disposed) {
        try {
          followCameraOnGhost(camera, g, getGhostAlpha(g, alpha));
        } catch (err) {
          console.error("[Swervle Replay Viewer] camera follow failed", err);
        }
      }
    }

    updateClouds(camera, performance.now());

    if (camera) {
      refreshCameraMatrices(camera);
      updateGateMarkers(camera);
    }

    for (const g of ghosts.values()) {
      if (g.disposed) continue;
      try {
        const frame = g.rv.frame;
        const ghostAlpha = getGhostAlpha(g, alpha);
        // Force the near/far distance check GL.update() always does to
        // read "near" (fully solid) by passing, as the reference point, the
        // *exact same* interpolated position it computes internally for
        // itself — not just "close to it". The far state renders the car
        // semi-transparent/depth-write-disabled (a deliberate fade-out for
        // distant native ghosts); passing merely the raw end-of-tick
        // position (not interpolated) was close enough most of the time but
        // could still drift past the threshold on a fast car, which is why
        // the ghosting/duplicate-look persisted. Matching GL's own lerp
        // exactly makes the distance always precisely 0.
        const chassis = frame.car.vehicle.chassis;
        const exactSelfPosition = {
          x: lerp(chassis.previousPosition.x, chassis.position.x, ghostAlpha),
          y: lerp(chassis.previousPosition.y, chassis.position.y, ghostAlpha),
          z: lerp(chassis.previousPosition.z, chassis.position.z, ghostAlpha),
        };
        g.gl.update(ghostAlpha, exactSelfPosition);
        // Watched replay = should look like you're actually driving, not
        // like a ghost — see forceGhostOpaque's own comment. Only the
        // followed/manual ghost, not any other still-visible (eye-toggled)
        // ghost racing alongside you, which really is someone else's run
        // and should keep looking like one.
        if (g.manual) forceGhostOpaque(g.gl.root);
        // Passing the raw camera directly — matching exactly what the
        // native opponent/PB ghosts do (`this.#ye?.updateNameplate(camera)`
        // in the patched bundle). An earlier version of this wrapped it in
        // a computed world-space quaternion/position on a theory that the
        // camera might be parented under a rig; that added complexity
        // didn't fix the reported "nameplate frozen facing its spawn
        // direction" issue, and since native ghosts' nameplates work
        // correctly with the raw camera, the wrapper was more likely
        // introducing a problem than solving one. Reverted.
        if (camera) g.gl.updateNameplate(camera);
      } catch (err) {
        console.error("[Swervle Replay Viewer] ghost render update failed", err);
      }
    }
  };

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // A manual ghost's own accumulated fractional tick (how far past its
  // last whole step() it currently is) is its real interpolation fraction
  // — the site's own `siteAlpha` reflects the PLAYER's frame timing, which
  // has nothing to do with a ghost that's now stepping on its own
  // independent, speed-scaled virtual clock instead. Shared by both the
  // chase-camera and the ghost's own visible-mesh update so they always
  // agree on exactly how far into the current tick interval "now" is.
  function getGhostAlpha(g, siteAlpha) {
    return followKey !== null ? Math.min(1, Math.max(0, master.accum)) : siteAlpha;
  }

  // A watched replay is meant to look exactly like you're driving it
  // yourself (you're just not actually the one doing it) — not like a
  // translucent "ghost". GL's own construction-time setup makes every
  // material on a ghost's car permanently transparent (a real see-through
  // fade for distant native ghosts/PBs racing alongside you), and its
  // per-frame update() keeps resetting opacity to one of two low values
  // depending on distance from the player — there's no flag to just turn
  // that off, so opacity is overridden directly on the actual materials
  // every frame instead, right after GL's own update() call (which is
  // what last touched it).
  //
  // Only `opacity` — with `transparent` left at `true`, a material with
  // opacity 1 blends as `src*1 + dst*0 = src`, i.e. renders pixel-for-pixel
  // identical to a fully opaque material, so this alone is enough to kill
  // the see-through look. An earlier version of this also forced
  // `depthWrite`/`depthTest` to match a "real" opaque material and made
  // the whole car invisible instead: these materials use `depthFunc:
  // EqualDepth`, deliberately paired with a separate depth-only "primer"
  // mesh (GL's own `ghost-depth:`-named helper, rendered first) that
  // writes the true depth — the color mesh is normally depthWrite:false
  // and only ever draws where its own depth exactly matches what the
  // primer already wrote. Flipping depthWrite on for the color mesh too
  // broke that pairing (now writing its own, still order-of-operations-
  // dependent depth into the same test its rendering depends on) and it
  // stopped passing its own depth test. Leaving depth/transparency state
  // alone entirely avoids touching a mechanism this code doesn't need to
  // understand fully to know not to disturb.
  function forceGhostOpaque(root) {
    root.traverse((obj) => {
      if (!obj.isMesh || (obj.name && obj.name.startsWith("ghost-depth:"))) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (mat) mat.opacity = 1;
      }
    });
  }

  // Standard optimized quaternion*vector rotation:
  // v' = v + 2*q.w*cross(q.xyz, v) + 2*cross(q.xyz, cross(q.xyz, v))
  function rotateByQuaternion(v, q) {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const cx = qy * v.z - qz * v.y, cy = qz * v.x - qx * v.z, cz = qx * v.y - qy * v.x;
    const c2x = qy * cz - qz * cy, c2y = qz * cx - qx * cz, c2z = qx * cy - qy * cx;
    return {
      x: v.x + 2 * qw * cx + 2 * c2x,
      y: v.y + 2 * qw * cy + 2 * c2y,
      z: v.z + 2 * qw * cz + 2 * c2z,
    };
  }

  // Normalized-lerp, not a true slerp — between two ADJACENT physics ticks
  // (which is the only gap this is ever asked to bridge: `alpha` never
  // spans more than one tick), the rotation delta is tiny enough that
  // nlerp is visually indistinguishable from a proper slerp and needs no
  // trig. Takes the shorter path around by flipping the sign of qb when
  // the two quaternions are more than 90° apart (negative dot product) —
  // otherwise lerping straight between them can rotate the "long way".
  function nlerpQuat(qa, qb, t) {
    let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
    if (qa.x * bx + qa.y * by + qa.z * bz + qa.w * bw < 0) {
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    const x = qa.x + (bx - qa.x) * t, y = qa.y + (by - qa.y) * t, z = qa.z + (bz - qa.z) * t, w = qa.w + (bw - qa.w) * t;
    const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    return { x: x / len, y: y / len, z: z / len, w: w / len };
  }

  // `alpha` here must be the SAME interpolation fraction the ghost's own
  // visible mesh is being rendered with (see onRender's ghostAlpha) — using
  // the raw, un-interpolated end-of-tick chassis.position/quaternion
  // instead (as this used to) moves the camera in the same discrete,
  // once-per-physics-tick jumps the mesh itself no longer makes, so the
  // whole view appears to jump even though the car's own motion is
  // perfectly smooth: the camera **is** the viewer's frame of reference,
  // so a jumpy camera reads as jumpy everything, including a smoothly
  // moving object inside it.
  const chaseCam = { yaw: null, last: 0 }; // reset whenever the followed ghost changes
  function followCameraOnGhost(camera, ghost, alpha) {
    const chassis = ghost.rv.frame.car.vehicle.chassis;
    const pos = {
      x: lerp(chassis.previousPosition.x, chassis.position.x, alpha),
      y: lerp(chassis.previousPosition.y, chassis.position.y, alpha),
      z: lerp(chassis.previousPosition.z, chassis.position.z, alpha),
    };
    const quat = nlerpQuat(chassis.previousQuaternion, chassis.quaternion, alpha);
    // Chase cam: sits behind the direction the car is actually TRAVELLING, not
    // the way it's facing, so a car driving backwards is seen from its front
    // (and a spin or drift doesn't whip the view around). The heading eases
    // toward the travel direction, and holds when the car is nearly stopped.
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - chaseCam.last) / 1000));
    chaseCam.last = now;
    const vx = (chassis.position.x - chassis.previousPosition.x) * TICK_RATE;
    const vz = (chassis.position.z - chassis.previousPosition.z) * TICK_RATE;
    if (chaseCam.yaw === null) {
      const f = rotateByQuaternion({ x: 0, y: 0, z: 1 }, quat);
      chaseCam.yaw = Math.atan2(f.x, f.z);
    }
    if (Math.hypot(vx, vz) > 1.5) {
      const target = Math.atan2(vx, vz);
      let diff = target - chaseCam.yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // shortest way round
      chaseCam.yaw += diff * (1 - Math.exp(-dt * 5));
    }
    const dx = Math.sin(chaseCam.yaw);
    const dz = Math.cos(chaseCam.yaw);
    camera.position.set(pos.x - dx * 7.5, pos.y + 3.2, pos.z - dz * 7.5);
    camera.lookAt(pos.x, pos.y + 1, pos.z);
  }

  // Deterministic per-run pseudo-random color (same run always gets the
  // same color across toggles/sessions). Run ids from the same day are
  // often sortable/near-sequential (long shared prefixes, differing only in
  // their last couple of characters) — a naive `h = h*31 + charCode` hash
  // doesn't scramble that kind of input enough, so consecutive runs ended
  // up with near-identical hues ("most of the cars appear to be roughly the
  // same colour"). FNV-1a + a finalizer mix gives real avalanche (small
  // input changes flip most output bits); multiplying the result by the
  // golden ratio and taking the fractional part then spreads even the
  // remaining close hash values evenly around the hue circle.
  function hashKey(key) {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function colorForKey(key) {
    const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;
    const frac = (hashKey(key) * GOLDEN_RATIO_CONJUGATE) % 1;
    const hue = Math.floor(frac * 360);
    return hslToHexNumber(hue, 70, 55);
  }

  function hslToHexNumber(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toByte = (n) => Math.round(f(n) * 255);
    return (toByte(0) << 16) | (toByte(8) << 8) | toByte(4);
  }

  // ---- ghost spawn / despawn (keyed, idempotent) ----

  // Applies a run's real, official livery (the same paint job the driver
  // set up in the livery editor) onto a spawned ghost's car mesh, the same
  // way the site's own native opponent/PB ghosts do — mirrors the site's own
  // async #Ir(carView, livery) pattern one-for-one, just reimplemented here
  // since that method is private. `livery` is whatever came back on the
  // ghost-fetch response's `.livery` field: {design, gridSignature, revision}
  // (design is the JSON-encoded paint design string), or null/absent for
  // runs that predate the livery system / never customized their car.
  let liveryModulePromise = null;
  async function wearLivery(carView, livery) {
    if (livery == null || typeof livery.design !== "string") return null;
    const ready = window.__srv.ready;
    if (typeof ready?.loadLiveryModule !== "function") return null;
    try {
      if (!liveryModulePromise) {
        liveryModulePromise = ready.loadLiveryModule().catch((err) => {
          liveryModulePromise = null; // don't poison future spawns with a cached rejection
          throw err;
        });
      }
      const mod = await liveryModulePromise;
      const handle = mod.createRaceLiveryV1({
        designText: livery.design,
        materialRegistrar: ready.materialRegistrar,
        source: carView.root,
      });
      if (handle === null) return null;
      handle.wear(carView.root);
      return handle;
    } catch (err) {
      console.error("[Swervle Replay Viewer] livery apply failed", err);
      return null;
    }
  }

  async function spawnGhostOnce(key, states, displayName, livery) {
    // Temporary diagnostic — trying to pin down a report of 2-4 duplicate
    // cars for a single ghost, immediately on first watch. If this logs
    // more than once for the same key without a despawn in between, the
    // bug is a real dedup failure (spawnGhostOnce actually running more
    // than once); if it only ever logs once, the duplication is happening
    // somewhere inside the site's own GL/VD/RV classes, not in our spawn
    // logic, and this can come back out.
    console.log(`[Swervle Replay Viewer] spawnGhostOnce ENTER key=${key} ghosts.has=${ghosts.has(key)} pendingSpawns.has=${pendingSpawns.has(key)}`);

    const ready = window.__srv.ready;
    if (!ready) throw new Error("Live hooks unavailable (the race isn't ready yet)");

    const rv = new ready.RV({ modifiers: ready.modifiers, states, track: ready.track, capturePresentationData: true });
    const initial = rv.create();
    let carView, gl, liveryHandle;
    try {
      const assetInstance = await ready.assetFactory.instantiate(ready.carDef);
      // Falls back to the old deterministic color-per-run only when this run
      // has no real livery to show (e.g. it predates the livery system) —
      // otherwise the livery texture is what actually paints the car, so the
      // flat override color underneath it is irrelevant.
      const hasLivery = livery != null && typeof livery.design === "string";
      carView = new ready.VD({
        appearance: ready.appearance,
        assetInstance,
        definition: ready.definition,
        entityId: initial.car.entityId,
        materialColorOverrides: hasLivery
          ? ready.materialColorOverrides
          : { ...ready.materialColorOverrides, Car: colorForKey(key) },
        materialRegistrar: ready.materialRegistrar,
      });
      liveryHandle = await wearLivery(carView, livery);
      const nameplate = ready.buildNameplate({ displayName, relationship: "friend", surface: "gameplay" });
      gl = new ready.GL({
        carView,
        initialSnapshot: initial.car,
        nameplate: nameplate === null ? null : { label: nameplate },
        parent: ready.viewParent,
      });
    } catch (err) {
      liveryHandle?.dispose();
      rv.dispose?.();
      throw err;
    }

    // A despawn (or a page/race reset that invalidated `ready`) could have
    // happened while the above `await`s were in flight — don't let a
    // now-stale spawn add itself back into the scene.
    if (!pendingSpawns.has(key)) {
      liveryHandle?.dispose();
      gl.dispose();
      return;
    }
    // Not stepped here — see window.__srv.onTick above, which advances every
    // live ghost exactly once per real physics tick (and only while the
    // real race is actually racing), so a ghost's own countdown/start lines
    // up with the player's.
    ghosts.set(key, { rv, gl, states, liveryHandle, disposed: false, manual: null, seeking: false, gatesPassed: 0, finishMs: null });
    console.log(`[Swervle Replay Viewer] spawnGhostOnce ADDED key=${key} ghosts.size=${ghosts.size} carView.root.uuid=${carView.root.uuid} viewParent.children.length=${ready.viewParent.children.length}`);
  }

  async function spawnGhost(key, states, displayName, livery) {
    console.log(`[Swervle Replay Viewer] spawnGhost CALLED key=${key} ghosts.has=${ghosts.has(key)} pendingSpawns.has=${pendingSpawns.has(key)}`);
    if (ghosts.has(key)) return; // already visible — nothing to do
    let promise = pendingSpawns.get(key);
    if (!promise) {
      promise = spawnGhostOnce(key, states, displayName, livery).finally(() => pendingSpawns.delete(key));
      pendingSpawns.set(key, promise);
    }
    return promise;
  }

  function despawnGhost(key) {
    console.log(`[Swervle Replay Viewer] despawnGhost CALLED key=${key} hadGhost=${ghosts.has(key)}`);
    pendingSpawns.delete(key); // marks any in-flight spawn for this key as stale
    const g = ghosts.get(key);
    if (!g) return;
    g.disposed = true;
    // Despawning the currently-followed ghost directly (e.g. via the eye
    // toggle, rather than "Stop watching") bypasses srv:setCameraFollow
    // entirely — has to clear __srvWatchingReplay here too, or the
    // automatic pointer-lock bypass would stay stuck on indefinitely with
    // nothing left actually being watched.
    if (followKey === key) {
      followKey = null;
      window.__srvWatchingReplay = false;
      updateWatchingReplayActive();
    }
    try {
      g.liveryHandle?.dispose();
    } catch {}
    try {
      g.gl.dispose();
    } catch {}
    ghosts.delete(key);
  }

  // Silently fast-forwards a replay through the real physics (as fast as JS
  // can loop, not real time) purely to read out its exact checkpoint/"gate"
  // crossing ticks + speeds — used to get real PB splits, not an
  // approximation. Reads the race events the simulator reports each step.
  //
  // Runs in small chunks with a yield between them instead of one long
  // synchronous loop — a run can be thousands of ticks, and stepping
  // physics for all of them in one go blocks the main thread long enough to
  // visibly stall the game's own render loop (reported as "the game pauses
  // whenever the leaderboard loads", since this is what triggers right
  // after finding a PB to compute splits for). A CHUNK_SIZE of 100 with a
  // setTimeout(0) yield was tried first and the stall was still landing —
  // 100 real physics steps back-to-back is still enough synchronous work to
  // blow through whatever stall threshold the game's pause-on-stutter
  // detection uses, and setTimeout(0) doesn't actually guarantee a frame
  // paints before the next chunk starts (it just queues a macrotask, which
  // can still run before the browser gets around to painting). Chunking
  // much smaller AND yielding via requestAnimationFrame instead — rAF
  // callbacks are scheduled right before a paint, so each yield now
  // corresponds to an actual rendered frame of the game's own loop getting
  // to run, not just a queued callback that might not.
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }
  async function computeSplits(states) {
    const ready = window.__srv.ready;
    if (!ready) throw new Error("Live hooks unavailable");
    // capturePresentationData makes each frame carry the race events the
    // simulation produced that tick (checkpoints, finish with its exact time).
    // frame.tick counts from the race start, like the live timer.
    const rv = new ready.RV({ modifiers: ready.modifiers, states, track: ready.track, capturePresentationData: true });
    rv.create();
    await nextFrame(); // rv.create() itself can be non-trivial work — paint before stepping starts
    const gates = [];
    let totalTicks = null;
    const maxSteps = states.length + 600; // states.length ticks + settle tail
    const CHUNK_SIZE = 12;
    for (let i = 0; i < maxSteps && !rv.finished; i++) {
      rv.step();
      const frame = rv.frame;
      for (const ev of frame.events ?? []) {
        if (ev.type !== "race-checkpoint" && ev.type !== "race-finish") continue;
        const gateIndex = ev.payload?.gateIndex;
        if (!Number.isSafeInteger(gateIndex) || gates.some((g) => g.gateIndex === gateIndex)) continue;
        const timeMs = ev.type === "race-finish" && Number.isFinite(ev.payload?.displayTimeMs) ? ev.payload.displayTimeMs : null;
        gates.push({ gateIndex, tick: frame.tick, speed: frame.car?.speed ?? 0, timeMs });
        if (ev.type === "race-finish") totalTicks = frame.tick;
      }
      if (i % CHUNK_SIZE === CHUNK_SIZE - 1) {
        await nextFrame();
      }
    }
    gates.sort((x, y) => x.gateIndex - y.gateIndex);
    if (totalTicks === null) totalTicks = rv.replayTick;
    rv.dispose?.();
    return { gates, totalTicks };
  }

  // Seeks a live, currently-spawned ghost to an arbitrary tick — this is
  // what the progress-bar scrubber calls. Real physics can only be stepped
  // forward, never jumped to directly, so "seeking" (including seeking
  // *backward*) means resetting to tick 0 and fast-forwarding back up to
  // the target, exactly like computeSplits above silently fast-forwards a
  // whole run to read its splits. Chunked with rAF yields for the same
  // reason: a multi-thousand-tick run stepped in one synchronous burst
  // would visibly stall the game's own render loop.
  //
  // Only moves the ghost's own state — intermediate frames during the
  // fast-forward are never rendered (consumeSnapshot is only called once,
  // at the very end), so this reads as an instant cut to the new position
  // once it resolves, the same way scrubbing a video jumps straight to the
  // dropped frame instead of visibly fast-forwarding through every one in
  // between.
  async function seekGhost(key, targetTick) {
    const fg = ghosts.get(key);
    if (!fg || fg.disposed) throw new Error("That ghost isn't live right now.");
    // Every extension ghost is moved to the same moment, so the scrub bar
    // controls the whole session, not just the followed run.
    const live = [...ghosts.values()].filter((g) => !g.disposed);
    const clamped = Math.max(0, Math.min(Math.floor(targetTick), masterTotal()));
    for (const g of live) g.seeking = true; // pause stepManualGhosts while this loop owns rv.step()
    try {
      for (const g of live) {
        g.rv.restart(g.states);
        resetGhostProgress(g);
      }
      const CHUNK_SIZE = 25;
      for (let i = 0; i < clamped; i++) {
        if (fg.disposed) return; // stopped watching mid-seek
        for (const g of live) if (!g.disposed && !g.rv.finished) stepGhost(g);
        if (i % CHUNK_SIZE === CHUNK_SIZE - 1) await nextFrame();
      }
      for (const g of live) if (!g.disposed) g.gl.consumeSnapshot(g.rv.frame.car);
      master.tick = clamped;
      master.accum = 0;
    } finally {
      for (const g of live) g.seeking = false;
      if (fg.manual) fg.manual.lastTimestamp = null; // next stepManualGhosts tick just resyncs the clock, doesn't jump
    }
  }

  // ---- audio: while a replay is being watched, the game's own car sounds
  // (engine, tyre/surface noise, landings) are fed from the REPLAY car instead
  // of the player's. hooks.js calls this for each audio update the game makes
  // and swaps the arguments for what's returned. Returns undefined when not
  // watching (nothing is changed). ----
  function followedFrame() {
    if (followKey === null) return null;
    const g = ghosts.get(followKey);
    if (!g || g.disposed) return null;
    const frame = g.rv.frame;
    return frame?.car?.vehicle?.chassis ? frame : null;
  }
  // Most common surface among the wheels that are touching the ground, like the game does.
  function frameMaterial(frame, fallback) {
    const counts = new Map();
    for (const w of frame.wheelSurfaceSamples ?? []) {
      if (!w.grounded || !Number.isInteger(w.surfaceId) || w.surfaceId < 0 || w.surfaceId > 6) continue;
      counts.set(w.surfaceId, (counts.get(w.surfaceId) ?? 0) + 1);
    }
    let best = null;
    let n = 0;
    for (const [id, c] of counts) if (c > n) [best, n] = [id, c];
    return counts.size ? best : fallback;
  }
  window.__srv.audioReplace = (kind, arg) => {
    const frame = followedFrame();
    if (!frame || !arg) return undefined;
    const car = frame.car;
    const chassis = car.vehicle.chassis;
    const grounded = car.vehicle.raycastVehicle?.groundedWheelCount ?? arg.groundedWheelCount;
    const held = car.heldControls ?? {};
    const material = frameMaterial(frame, arg.material);
    switch (kind) {
      case "setEngine":
        return {
          gear: car.gear,
          groundedWheelCount: grounded,
          reverse: !!held.reverse,
          shiftTimer: car.shiftTimer,
          speed: car.speed,
          throttle: !!held.throttle,
        };
      case "setSurface": {
        const q = chassis.quaternion;
        const n = 1 - 2 * (q.y ** 2 + q.z ** 2);
        const r = 2 * (q.x * q.z - q.w * q.y);
        const h = Math.hypot(n, r);
        const lateralSpeed = h <= 1e-9 ? 0 : Math.abs((chassis.velocity.x * n + chassis.velocity.z * r) / h);
        const wheels = car.vehicle.raycastVehicle?.wheels ?? [];
        return {
          brake: !!held.brake || (!!held.reverse && car.speed > 0.25),
          groundedWheelCount: grounded,
          lateralSpeed,
          material,
          speed: Math.hypot(chassis.velocity.x, chassis.velocity.z),
          steeringAngle: wheels.reduce((m, w) => Math.max(m, Math.abs(w.steering ?? 0)), 0),
        };
      }
      case "observeContact":
        return { groundedWheelCount: grounded, material, verticalSpeed: chassis.velocity.y };
      default:
        return undefined;
    }
  };

  // ---- bridge to the isolated-world content script ----

  document.addEventListener("srv:checkHooks", (e) => {
    dispatch("srv:hooksStatus", { requestId: e.detail?.requestId, available: !!window.__srv.ready });
  });

  document.addEventListener("srv:spawnGhost", async (e) => {
    const { requestId, key, states, displayName, livery } = e.detail || {};
    try {
      await spawnGhost(key, states, displayName, livery);
      dispatch("srv:spawnGhostResult", { requestId, key });
    } catch (err) {
      dispatch("srv:spawnGhostResult", { requestId, key, error: String(err?.message || err) });
    }
  });

  document.addEventListener("srv:despawnGhost", (e) => {
    despawnGhost(e.detail?.key);
  });

  // Following a ghost is what puts it into "manual" mode (see
  // stepManualGhosts) — independent speed/seek only ever applies to
  // whichever one ghost is actually being watched. Un-following (or
  // switching to a different ghost) hands the previous one back to the
  // normal real-tick-synced path.
  document.addEventListener("srv:setCameraFollow", (e) => {
    const newKey = e.detail?.key ?? null;
    if (followKey !== null && followKey !== newKey) {
      const prev = ghosts.get(followKey);
      if (prev) prev.manual = null;
    }
    followKey = newKey;
    chaseCam.yaw = null;
    if (followKey !== null) {
      const g = ghosts.get(followKey);
      if (g) g.manual = { speed: 1, accumTicks: 0, lastTimestamp: null };
      // Start a fresh session: everything back at the start line on the shared clock.
      master.tick = 0;
      master.accum = 0;
      master.paused = false;
      for (const og of ghosts.values()) {
        if (og.disposed) continue;
        try {
          og.rv.restart(og.states);
          resetGhostProgress(og);
          og.gl.consumeSnapshot(og.rv.frame.car);
        } catch (err) {
          console.error("[Swervle Replay Viewer] ghost reset failed", err);
        }
      }
    }
    window.__srvWatchingReplay = followKey !== null;
    updateWatchingReplayActive();
  });

  document.addEventListener("srv:setReplaySpeed", (e) => {
    const { key, speed } = e.detail || {};
    const g = ghosts.get(key);
    if (g?.manual && Number.isFinite(speed) && speed > 0) g.manual.speed = speed;
  });

  document.addEventListener("srv:setReplayPaused", (e) => {
    master.paused = !!e.detail?.paused;
  });

  document.addEventListener("srv:seekReplay", async (e) => {
    const { requestId, key, tick } = e.detail || {};
    try {
      await seekGhost(key, tick);
      dispatch("srv:seekReplayResult", { requestId, key });
    } catch (err) {
      dispatch("srv:seekReplayResult", { requestId, key, error: String(err?.message || err) });
    }
  });

  document.addEventListener("srv:computeSplits", async (e) => {
    const { requestId, states } = e.detail || {};
    try {
      const result = await computeSplits(states);
      dispatch("srv:splitsResult", { requestId, ...result });
    } catch (err) {
      dispatch("srv:splitsResult", { requestId, error: String(err?.message || err) });
    }
  });
})();
