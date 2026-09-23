// Standalone replay viewer overlay. Purely a canvas + HUD driven by decoded
// recorded inputs — it never touches the site's own game/race objects, so
// it cannot be mistaken for (or counted as) a run you drove.
(function (global) {
  const { simulatePath, TICK_RATE } = global.SwervleDecoder;

  const INPUT_LABELS = [
    ["left", "◀"],
    ["throttle", "▲"],
    ["right", "▶"],
    ["reverse", "▼"],
    ["handbrake", ""], // blank, like an actual keyboard spacebar
    ["boost", "BOOST"],
  ];

  function fmtTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(3).padStart(6, "0");
    return `${m}:${s}`;
  }

  class ReplayViewer {
    constructor({ displayName, publicRunId, bytes, tickRate = TICK_RATE }) {
      this.displayName = displayName || "Unknown driver";
      this.publicRunId = publicRunId;
      this.frames = simulatePath(bytes, tickRate);
      this.tickRate = tickRate;
      this.durationSec = this.frames.length / tickRate;
      this.tick = 0;
      this.playing = true;
      this.speed = 1;
      this._raf = null;
      this._lastNow = null;
      this._build();
    }

    _build() {
      const root = document.createElement("div");
      root.className = "srv-viewer-overlay";
      window.SwervleSetHtml(root, `
        <div class="srv-viewer-panel">
          <div class="srv-viewer-header">
            <div class="srv-viewer-badge">SPECTATING REPLAY — not a live run</div>
            <div class="srv-viewer-title">
              <strong>${this._esc(this.displayName)}</strong>
              <span class="srv-viewer-runid">${this._esc(this.publicRunId || "")}</span>
            </div>
            <button class="srv-viewer-close" title="Close">&times;</button>
          </div>
          <canvas class="srv-viewer-canvas" width="960" height="560"></canvas>
          <div class="srv-viewer-hud"></div>
          <div class="srv-viewer-controls">
            <button class="srv-btn srv-play-pause">Pause</button>
            <select class="srv-speed">
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
            <input type="range" class="srv-scrub" min="0" max="${Math.max(0, this.frames.length - 1)}" value="0" />
            <span class="srv-time">0:00.000 / ${fmtTime(this.durationSec)}</span>
          </div>
        </div>
      `);
      document.body.appendChild(root);
      this.root = root;
      this.canvas = root.querySelector(".srv-viewer-canvas");
      this.ctx = this.canvas.getContext("2d");
      this.hudEl = root.querySelector(".srv-viewer-hud");
      this.timeEl = root.querySelector(".srv-time");
      this.scrubEl = root.querySelector(".srv-scrub");

      window.SwervleSetHtml(this.hudEl, INPUT_LABELS.map(
        ([key, label]) => `<div class="srv-hud-key" data-key="${key}">${label}</div>`
      ).join(""));
      this.hudKeyEls = {};
      this.hudEl.querySelectorAll(".srv-hud-key").forEach((el) => {
        this.hudKeyEls[el.dataset.key] = el;
      });

      root.querySelector(".srv-viewer-close").addEventListener("click", () => this.close());
      root.addEventListener("click", (e) => {
        if (e.target === root) this.close();
      });
      root.querySelector(".srv-play-pause").addEventListener("click", (e) => {
        this.playing = !this.playing;
        e.target.textContent = this.playing ? "Pause" : "Play";
        this._lastNow = null;
      });
      root.querySelector(".srv-speed").addEventListener("change", (e) => {
        this.speed = parseFloat(e.target.value);
      });
      this.scrubEl.addEventListener("input", (e) => {
        this.tick = parseInt(e.target.value, 10);
        this._lastNow = null;
      });

      this._esc = this._esc.bind(this);
      this._loop = this._loop.bind(this);
      this._raf = requestAnimationFrame(this._loop);
    }

    _esc(s) {
      const d = document.createElement("div");
      d.textContent = String(s);
      return d.innerHTML;
    }

    _loop(now) {
      if (!this.root.isConnected) return;
      if (this.playing && this.frames.length > 0) {
        if (this._lastNow != null) {
          const dtSec = (now - this._lastNow) / 1000;
          this.tick += dtSec * this.tickRate * this.speed;
        }
        this._lastNow = now;
        if (this.tick >= this.frames.length - 1) {
          this.tick = this.frames.length - 1;
          this.playing = false;
          this.root.querySelector(".srv-play-pause").textContent = "Play";
        }
      } else {
        this._lastNow = null;
      }
      this._render();
      this._raf = requestAnimationFrame(this._loop);
    }

    // Linearly interpolates position/heading/speed between the two whole
    // recorded ticks `this.tick` currently sits between — this simulator's
    // `heading` is an unbounded running total (never wrapped to -π..π), so
    // a plain lerp is exact with no angle-wraparound case to handle. Input
    // key states are discrete booleans with no fractional meaning, so
    // those come from whichever recorded tick playback is currently
    // leaving (f0), not blended.
    _interpolatedFrame(tick) {
      const n = this.frames.length;
      if (n === 0) return null;
      const clamped = Math.max(0, Math.min(n - 1, tick));
      const i0 = Math.floor(clamped);
      const i1 = Math.min(i0 + 1, n - 1);
      const t = clamped - i0;
      const f0 = this.frames[i0], f1 = this.frames[i1];
      return {
        x: f0.x + (f1.x - f0.x) * t,
        y: f0.y + (f1.y - f0.y) * t,
        heading: f0.heading + (f1.heading - f0.heading) * t,
        speed: f0.speed + (f1.speed - f0.speed) * t,
        input: f0.input,
        tick: clamped,
      };
    }

    _render() {
      // Interpolated, not the old Math.round(this.tick) — that snapped to
      // whichever whole recorded tick was nearest, which is the exact same
      // "visibly jumps between ticks instead of moving smoothly between
      // them" issue the live in-game watch path had before it started
      // interpolating between physics ticks every render frame. This
      // standalone fallback viewer only ever runs when live hooks aren't
      // available, so it never got that fix — this brings it in line.
      const frame = this._interpolatedFrame(this.tick);
      if (!frame) return;
      const idx = Math.round(frame.tick);

      this.scrubEl.value = idx;
      this.timeEl.textContent = `${fmtTime(frame.tick / this.tickRate)} / ${fmtTime(this.durationSec)}`;

      for (const [key, el] of Object.entries(this.hudKeyEls)) {
        el.classList.toggle("active", !!frame.input[key]);
      }

      this._drawScene(frame, idx);
    }

    // Chase-cam style: canvas viewport follows the car and keeps it pointed
    // "up", drawing its recent trail so you can see the line it took.
    _drawScene(frame, idx) {
      const ctx = this.ctx;
      const w = this.canvas.width, h = this.canvas.height;
      ctx.fillStyle = "#12151c";
      ctx.fillRect(0, 0, w, h);

      const scale = 6;
      ctx.save();
      ctx.translate(w / 2, h * 0.72);
      ctx.rotate(-frame.heading);
      ctx.translate(-frame.x * scale, -frame.y * scale);

      // trail
      ctx.beginPath();
      ctx.strokeStyle = "rgba(90,170,255,0.55)";
      ctx.lineWidth = 3;
      const start = Math.max(0, idx - 240);
      for (let i = start; i <= idx; i++) {
        const f = this.frames[i];
        const px = f.x * scale, py = f.y * scale;
        if (i === start) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // car
      ctx.save();
      ctx.translate(frame.x * scale, frame.y * scale);
      ctx.rotate(frame.heading);
      ctx.fillStyle = frame.input.boost ? "#ffb347" : "#5ac8ff";
      ctx.beginPath();
      ctx.moveTo(0, -10);
      ctx.lineTo(6, 8);
      ctx.lineTo(-6, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.restore();

      ctx.fillStyle = "#8a93a6";
      ctx.font = "12px sans-serif";
      ctx.fillText(`tick ${idx} / ${this.frames.length}  speed ${frame.speed.toFixed(1)}`, 10, h - 10);
      ctx.fillText("approximate path — reconstructed from recorded inputs, not live track geometry", 10, 16);
    }

    close() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this.root.remove();
    }
  }

  global.SwervleViewer = {
    open(opts) {
      return new ReplayViewer(opts);
    },
  };
})(window);
