// Decodes swervle's "car-state-byte-v1" replay format and produces a
// self-contained kinematic approximation for visualization purposes only.
// This never touches the live game/track — it's a standalone reconstruction
// from the recorded input bitmask, so watching a replay can never be counted
// as a run you drove.
(function (global) {
  const BITS = {
    throttle: 1,
    reverse: 2,
    steerLeft: 4,
    steerRight: 8,
    handbrake: 16,
    recovery: 32,
    boost: 64,
  };

  // Assumed fixed simulation tick rate. Adjust if playback timing looks off
  // relative to the recorded run's real duration.
  const TICK_RATE = 60;

  function decodeStatesBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function readInputByte(byte) {
    return {
      throttle: (byte & BITS.throttle) !== 0,
      reverse: (byte & BITS.reverse) !== 0,
      left: (byte & BITS.steerLeft) !== 0,
      right: (byte & BITS.steerRight) !== 0,
      handbrake: (byte & BITS.handbrake) !== 0,
      recovery: (byte & BITS.recovery) !== 0,
      boost: (byte & BITS.boost) !== 0,
    };
  }

  // Very simple bicycle-model style integrator. Not the real physics engine —
  // just enough to produce a plausible, smoothly animated path that reacts to
  // the exact recorded inputs (accel/brake/steer/boost) tick by tick.
  function simulatePath(bytes, tickRate = TICK_RATE) {
    const dt = 1 / tickRate;
    let x = 0, y = 0, heading = 0, speed = 0;
    const maxSpeed = 42, accel = 60, brakeDecel = 90, drag = 18;
    const boostAccel = 34, turnRate = 2.6;

    const frames = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const inp = readInputByte(bytes[i]);

      let a = 0;
      if (inp.throttle) a += accel;
      if (inp.boost) a += boostAccel;
      if (inp.reverse || inp.handbrake) a -= brakeDecel;
      a -= Math.sign(speed) * drag * (Math.abs(speed) / maxSpeed);

      speed += a * dt;
      speed = Math.max(-maxSpeed * 0.5, Math.min(maxSpeed, speed));

      const steerInput = (inp.left ? -1 : 0) + (inp.right ? 1 : 0);
      const turnFactor = Math.min(1, Math.abs(speed) / (maxSpeed * 0.3));
      heading += steerInput * turnRate * turnFactor * dt * Math.sign(speed || 1);

      x += Math.sin(heading) * speed * dt;
      y -= Math.cos(heading) * speed * dt;

      frames[i] = { x, y, heading, speed, input: inp, tick: i };
    }
    return frames;
  }

  // Buckets a list of tick-durations into "exactly 1 tick" / "exactly 2" /
  // "exactly 3" / "exactly 4" / "5 or more", plus what fraction were under
  // 5 ticks — a quick read on "mostly quick taps" vs "mostly held inputs"
  // without having to eyeball a raw list of however many events a full run
  // produced.
  function bucketDurations(durations) {
    const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, "5+": 0 };
    for (const d of durations) {
      if (d >= 5) buckets["5+"]++;
      else if (d >= 1) buckets[d]++;
    }
    const total = durations.length;
    const under5 = buckets[1] + buckets[2] + buckets[3] + buckets[4];
    return { buckets, total, pctUnder5: total > 0 ? (under5 / total) * 100 : 0 };
  }

  // The 4 steering/drive directions (excludes handbrake/boost/recovery,
  // which aren't "steering" inputs). For each, walks every tick looking for
  // 0->1 ("press") and 1->0 ("release") transitions, pairs them up in
  // order (presses and releases for one bit strictly alternate — one byte
  // per tick means at most one transition per tick), and buckets:
  //   - how many ticks each PRESS lasted (press tick -> its own release)
  //   - how many ticks each subsequent RELEASE lasted (that release -> the
  //     next press) — i.e. the gap between two taps
  // A press with no closing release (still held at the final tick) or a
  // release with no following press (run ends while released) can't have a
  // duration computed and is excluded rather than guessed at.
  //
  // Also records every recovery ("respawn") press tick separately, since
  // that's not a steering direction but content.js needs it (to report how
  // long after a checkpoint each one was sent).
  const STEERING_DIRECTIONS = ["throttle", "reverse", "left", "right"];
  function analyzeInputs(bytes) {
    const perDirection = {};
    for (const dir of STEERING_DIRECTIONS) perDirection[dir] = { pressTicks: [], releaseTicks: [] };
    const recoveryPressTicks = [];

    let prev = readInputByte(0); // tick -1: nothing held
    for (let tick = 0; tick < bytes.length; tick++) {
      const cur = readInputByte(bytes[tick]);
      for (const dir of STEERING_DIRECTIONS) {
        if (cur[dir] && !prev[dir]) perDirection[dir].pressTicks.push(tick);
        else if (!cur[dir] && prev[dir]) perDirection[dir].releaseTicks.push(tick);
      }
      if (cur.recovery && !prev.recovery) recoveryPressTicks.push(tick);
      prev = cur;
    }

    for (const dir of STEERING_DIRECTIONS) {
      const { pressTicks, releaseTicks } = perDirection[dir];
      const pressDurations = [];
      for (let i = 0; i < releaseTicks.length; i++) pressDurations.push(releaseTicks[i] - pressTicks[i]);
      const releaseDurations = [];
      for (let i = 0; i < releaseTicks.length; i++) {
        if (i + 1 < pressTicks.length) releaseDurations.push(pressTicks[i + 1] - releaseTicks[i]);
      }
      perDirection[dir].presses = bucketDurations(pressDurations);
      perDirection[dir].releases = bucketDurations(releaseDurations);
    }

    // Highest CPS: the most presses of any *single* direction that ever
    // landed within any 1-second span of the run — not summed across
    // directions (holding forward while also tapping left doesn't count as
    // 2 inputs at once for this purpose), just whichever one direction was
    // tapped fastest anywhere in the run.
    let highestCps = 0;
    for (const dir of STEERING_DIRECTIONS) {
      highestCps = Math.max(highestCps, maxPressesPerSecond(perDirection[dir].pressTicks));
    }

    return { perDirection, recoveryPressTicks, highestCps, totalTicks: bytes.length };
  }

  // Sliding-window max: for each press, counts how many presses (including
  // itself) fall within the trailing TICK_RATE-tick (1 real second) window
  // ending at it, and keeps the largest such count seen. `pressTicks` is
  // already ascending (built tick-by-tick above), so a simple two-pointer
  // sweep suffices — no need to check every possible window start, since
  // the densest window is always anchored at an actual press.
  function maxPressesPerSecond(pressTicks) {
    let left = 0,
      max = 0;
    for (let right = 0; right < pressTicks.length; right++) {
      while (pressTicks[right] - pressTicks[left] >= TICK_RATE) left++;
      max = Math.max(max, right - left + 1);
    }
    return max;
  }

  global.SwervleDecoder = {
    BITS,
    TICK_RATE,
    decodeStatesBase64,
    readInputByte,
    simulatePath,
    analyzeInputs,
  };
})(window);
