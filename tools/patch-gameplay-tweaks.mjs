#!/usr/bin/env node
// Applies the requested gameplay/physics tweaks to a copy of swervle's
// bundle, for local testing and for producing a build to hand to the
// developer. Kept SEPARATE from tools/patch-bundle.mjs (extension hooks,
// never changes gameplay) and from tools/patch-roll-fix.mjs (which turned
// out to target the wrong vehicle class entirely — see note at the bottom).
//
// All of this targets `FC`, the *actual* car vehicle class (not the
// separate, apparently-unused "Airplane"/helicopter vehicle class that an
// earlier investigation mistakenly patched). Confirmed real for the player
// car by checking its own held-controls shape
// ({throttle,reverse,left,right,brake,boost} — no pitch/roll/yaw at all)
// and its own distinct config object, `Z`.
//
// Changes:
//   1. shiftCutSeconds 0.2 -> 0.08 — every gear shift (up AND down) cuts
//      engine force to exactly zero for this long. On an incline, a car
//      hovering near a shift threshold can oscillate shift-up/shift-down
//      repeatedly, each costing another 200ms of dead thrust, which reads
//      as "acceleration stops going uphill." Shortening the cut reduces
//      that dead time without removing the shift mechanic.
//   2. Wheel grip (frictionSlip) is bumped slightly (0.8 -> 0.85) and made
//      live-adjustable via window.__srvGripMultiplier (a settings slider).
//   3. Turning circle (steering.maximumAngle) made live-adjustable via
//      window.__srvTurnMultiplier.
//   4. Car tilt/lean (wheel.rollInfluence — the standard raycast-vehicle
//      property controlling how much lateral wheel force banks the
//      chassis) made live-adjustable via window.__srvTiltMultiplier.
//   5. The "brake" control (currently a rear-wheel skid-lock handbrake,
//      Z.handbrake) is replaced with a real 4-wheel brake (via
//      raycastVehicle.setBrake — resistive torque, not a drive command).
//      Total force is engineForce * window.__srvBrakeMultiplier (default
//      4x), *distributed* across the 4 wheels proportional to each
//      wheel's own current suspensionForce (more loaded = more of the
//      brake force, less loaded = less), instead of split evenly. Four
//      earlier versions of this were tried and all had real problems
//      found via testing — see the in-code comments above the patch for
//      the full diagnosis of each: v1 reused the "reverse" engine-force
//      formula (wobble from wheel slip); v2 sized off Z.handbrake.force,
//      calibrated for instant lockup (reproduced handbrake behavior); v3
//      sized off raw suspensionForce, which is far too small in this
//      tuning's units ("does basically nothing"); v4 fixed the magnitude
//      but split it evenly across all 4 wheels, and since braking shifts
//      weight (and grip) forward, the now-lighter rear wheels locked up
//      first and caused the car to spin/turn. Explicitly does nothing
//      while `reverse` is also held, so the two never stack.
//   6. Slope awareness (new). Engine force under throttle now gets a
//      multiplier based on the chassis's *actual* vertical velocity
//      relative to its horizontal speed — i.e. how steeply you're really
//      climbing along the path you're actually driving, not the raw
//      terrain slope angle. This is what makes "diagonal uphill carries
//      more speed" fall out correctly on its own: at equal total speed, a
//      diagonal path across a hill has a shallower real climb rate than
//      driving straight up the fall line, so the physics that already
//      exists (cannon-es's own gravity, which was already being applied
//      correctly — the engine-force model just had no way to *react* to
//      it) gives it proportionally less resistance automatically, once the
//      engine model is allowed to see it at all. Strength is
//      `slopeAssistStrength` (0.6, new property on Z.transmission) times
//      window.__srvSlopeMultiplier (a settings slider, default 1).
//      Deliberately scoped to forward throttle only — reverse/braking are
//      unaffected.
//   7. Pitch resistance (new). Removes a configurable fraction of the
//      chassis's own pitch-axis angular velocity every tick, but *only*
//      while at least one wheel is grounded — this directly cuts down the
//      forward nose-dive under braking (and under hard acceleration/bumps
//      generally) without touching the *intentional* airborne pitch
//      control the car already has (throttle/reverse while fully
//      airborne — see Z.airControl / the #g method) or the diagonal-lean
//      it does mid-air, since the ground-only gate means this never runs
//      during that. Strength is window.__srvPitchDamp (0-0.95, default
//      0.7 = removes 70% of pitch rate every tick while grounded — "a
//      lot", per what was asked for).
//   8. Yaw stability (new, in response to "car randomly swerves left going
//      uphill"). Same technique as #7 but for yaw (rotation about world
//      "up") instead of pitch, and only active while grounded AND neither
//      `left` nor `right` is held — so it only ever cleans up drift the
//      player isn't commanding, never fights a real turn. Note: the
//      reported "wheels colliding with the body" mechanism was checked
//      directly and ruled out — this vehicle's wheels are pure raycasts
//      (stock cannon-es RaycastVehicle) with no collision body to collide
//      with anything. This patch treats the symptom, not a confirmed root
//      cause. Strength window.__srvYawDamp (0-1, default 1 — full removal
//      every tick, not just a fraction, after 0.5 wasn't enough to stop
//      it recurring specifically on surface transitions/steep slopes,
//      which pattern suggests a continuous asymmetric-grip torque that
//      outpaces a partial damper).
//   9. Rollover resistance (new — the *real* fix for "car rolling on 2
//      wheels", replacing an earlier report/patch that turned out to
//      target an entirely different, unused vehicle class). Traced the
//      real car's own airborne-roll mechanic (Z.airControl / the #g
//      method, called from prePhysics) directly: its roll-authority ramp
//      (`r`) is driven by an air-spin timer that resets to 0 the instant
//      *any* wheel touches ground, so that scripted mechanic is already
//      suppressed during a 2-wheel state — it isn't the cause. The real
//      gap: with only 2 of 4 wheels providing counter-torque, whatever
//      tipped the car onto 2 wheels in the first place (a bump, a hard
//      turn) has nothing sufficient stopping it from continuing to roll
//      further, since that's just emergent rigid-body physics, not a
//      scripted behavior with an on/off switch. Fix: same
//      dot-product-against-axis + addAngularVelocity technique as pitch/
//      yaw, this time against the forward axis (`n` — rotation about
//      forward is roll), removing a fraction of roll angular velocity —
//      but *only* while `0 < groundedWheelCount < 4` (partially grounded,
//      the "about to tip" state specifically). Deliberately NOT gated on
//      steering input (unlike yaw): a car shouldn't be allowed to flip
//      over while mid-corner just because you're actively steering, this
//      is closer to stability-control than a "don't fight my input" case.
//      Leaves full-4-wheel cornering lean (the `rollInfluence`/"Car tilt"
//      slider) and full-airborne air-control (`groundedWheelCount===0`)
//      both completely untouched, since neither matches the gate.
//      Strength window.__srvRolloverDamp (0-1, default 0.8).
//
// Still not addressed: "reward carrying speed over the shortest line" —
// this is really about track/corner design and cornering-speed loss, not
// a slope/gravity gap; see the grip changes (#2) for the closest indirect
// lever, but it isn't a claimed fix for this specific point.
//
// Usage: node tools/patch-gameplay-tweaks.mjs <input.js> <output.js>

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("Usage: node patch-gameplay-tweaks.mjs <input.js> <output.js>");
  process.exit(1);
}

let src = readFileSync(inputPath, "utf8");

function insertAfter(name, anchor, insertion) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`Patch "${name}" anchor matched ${count} times (expected 1).\nAnchor: ${anchor}`);
  }
  const idx = src.indexOf(anchor) + anchor.length;
  src = src.slice(0, idx) + insertion + src.slice(idx);
}

function replaceOnce(name, anchor, replacement) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`Patch "${name}" anchor matched ${count} times (expected 1).\nAnchor: ${anchor}`);
  }
  src = src.split(anchor).join(replacement);
}

// 1. Faster gear shifts.
replaceOnce("shiftCutSeconds", "shiftCutSeconds:.2,", "shiftCutSeconds:.08,");

// 2. Slight base grip bump.
replaceOnce("gripBaseBump", "frictionSlip:.8,", "frictionSlip:.85,");

// 2b. Live grip slider — applied where the wheel handling config is built.
replaceOnce(
  "gripSlider",
  "frictionSlip:Z.wheel.frictionSlip,",
  "frictionSlip:Z.wheel.frictionSlip*(window.__srvGripMultiplier??1),"
);

// 3. Live turning-circle slider — applied where the steering target angle
//    is computed each tick.
replaceOnce(
  "turnCircleSlider",
  "o=Z.steering.maximumAngle,",
  "o=Z.steering.maximumAngle*(window.__srvTurnMultiplier??1),"
);

// 4. Live tilt/lean slider — applied where the wheel handling config is
//    built (same object literal as the grip patch, different property).
replaceOnce(
  "tiltSlider",
  "rollInfluence:Z.wheel.rollInfluence,",
  "rollInfluence:Z.wheel.rollInfluence*(window.__srvTiltMultiplier??1),"
);

// 5a. Stop the "brake" control from triggering the old rear-wheel skid
//     handbrake on press/release.
replaceOnce(
  "removeHandbrake",
  "#v(e,t){if((e===MC.throttle||e===MC.reverse)&&!t&&this.applyEngineForce(0),e===MC.brake){if(this.#i!==null)return;this.setBrake(t?Z.handbrake.force:0,Z.handbrake.wheelDrive)}}",
  "#v(e,t){(e===MC.throttle||e===MC.reverse)&&!t&&this.applyEngineForce(0)}"
);

// 5b. Give "brake" a real per-tick deceleration.
//
//     FIRST VERSION (superseded — kept here as a note, not applied):
//     reused the "reverse" engine-force formula, i.e. commanded the drive
//     motor to spin backward while the wheels were still turning forward
//     at speed. That's physically "slam it into reverse while moving" —
//     it works (the car does slow down) but it does so by inducing heavy
//     wheel slip, and slipping tires lose lateral grip, which is exactly
//     what caused the large wobble reported when braking downhill (worse
//     there because gravity is adding speed on top of what the reversed
//     drive torque has to fight, widening the mismatch further).
//
//     SECOND VERSION (also superseded — kept as a note): used
//     raycastVehicle.setBrake (a real wheel brake, resistive torque
//     instead of a drive command) but sized it off Z.handbrake.force
//     (1e6) divided across 4 wheels. That constant exists specifically to
//     force an *instant full lockup* for handbrake-style drifting — it's
//     not a "strong but controllable brake" value at all, so even divided
//     by 4 it was still almost certainly locking all four wheels solid
//     the instant brake was pressed. A fully locked tire has ~zero
//     lateral grip, so this reproduced the same "skidding, uncontrollable"
//     character as the old handbrake — just via a cleaner mechanism (pure
//     lockup, rather than lockup caused by a drivetrain torque conflict).
//     Confirmed by tracing: this is exactly what a handbrake *is*, so
//     reusing its calibration constant for a "regular brake" was always
//     going to feel like a handbrake.
//
//     THIRD VERSION (also superseded — kept as a note): sized the brake
//     off each wheel's own current load, brakeForce = suspensionForce *
//     frictionSlip * strength (read via raycastVehicle.getWheelState()).
//     Physically well-motivated in principle, but wrong in practice: this
//     tuning's suspensionForce works out to roughly stiffness(20) *
//     compression(small, a fraction of a metre) * mass(50) — on the order
//     of a few dozen, not the few-hundred-to-thousand scale needed to
//     actually slow the car down. Result: "does basically nothing." The
//     mistake was assuming suspensionForce would land in a real-world-N
//     ballpark without having an actual runtime value to check it
//     against — twice now (this and v2) a plausible-sounding scale turned
//     out to be off by orders of magnitude in opposite directions, which
//     is exactly the risk of picking a physics constant without being
//     able to see it run.
//
//     FOURTH VERSION (also superseded — kept as a note): anchored to a
//     scale already known to be correct for this tuning —
//     Z.transmission.engineForce (500) — applied as a flat, equal force to
//     all 4 wheels. This fixed the "does basically nothing" magnitude
//     problem, but introduced a new one: braking legitimately shifts
//     weight forward (nose dives), increasing front-wheel grip and
//     decreasing rear-wheel grip. Applying the same flat force to every
//     wheel regardless means the now-lighter rear wheels are the first to
//     exceed their (reduced) available grip and lock up while the fronts
//     don't — and a locked rear tire has ~no lateral grip left to resist
//     any existing yaw, which is the classic cause of a car spinning/
//     turning under braking. Real cars deliberately bias braking toward
//     the front for exactly this reason (it's what the game's own
//     dormant ABS system's `frontBias` field exists for).
//
//     FIXED VERSION: keep v4's trusted *total* magnitude (still
//     engineForce * multiplier — the scale that's actually known to work)
//     but *distribute* it across wheels proportional to each wheel's own
//     current suspensionForce (read fresh each tick via
//     raycastVehicle.getWheelState()) instead of splitting it evenly.
//     A more heavily loaded wheel gets a proportionally larger share of
//     the (correctly-scaled) total braking force, a lightly loaded one
//     gets less — which is exactly what naturally prevents the lighter
//     end from locking first, without needing to know the *absolute*
//     suspensionForce scale at all (v3's mistake), since only the
//     *relative* share between wheels matters here, not read as a raw
//     force value on its own.
//
//     Also explicitly releases the brake (sets it back to 0) on every
//     tick brake ISN'T held, since a wheel brake set once otherwise stays
//     applied indefinitely — the engine-force approach didn't need this
//     (force is re-issued or implicitly ends each tick), but a wheel
//     brake is state that persists until told otherwise.
insertAfter(
  "brakeRelease",
  "let t=Z.transmission;",
  "if(!this.#o.brake)for(let srvWheel of this.wheels)this.raycastVehicle.setBrake(0,srvWheel.raycastWheelIndex);"
);
insertAfter(
  "brakeDeceleration",
  "this.applyEngineForce(n);return}",
  "if(this.#o.brake){this.applyEngineForce(0);" +
    "let srvTotalBrake=t.engineForce*(window.__srvBrakeMultiplier??4),srvEntries=[],srvTotalLoad=0;" +
    "for(let srvWheel of this.wheels){let srvState=this.raycastVehicle.getWheelState(srvWheel.raycastWheelIndex),srvLoad=Math.max(0,srvState.suspensionForce);srvEntries.push({srvWheel,srvLoad}),srvTotalLoad+=srvLoad}" +
    "let srvCount=srvEntries.length;" +
    "for(let srvEntry of srvEntries){let srvShare=srvTotalLoad>0?srvEntry.srvLoad/srvTotalLoad:1/srvCount;this.raycastVehicle.setBrake(srvTotalBrake*srvShare,srvEntry.srvWheel.raycastWheelIndex)}" +
    "return}"
);

// 6a. New tunable on the transmission config: how strong the slope assist
//     (below) is allowed to get at a full vertical climb.
replaceOnce("slopeAssistConfig", "engineForce:500,", "engineForce:500,slopeAssistStrength:.6,");

// 6b/6c/7. Consolidated gear-decision + throttle-force block. Replaces the
//     whole thing (rather than just the throttle branch, as an earlier
//     version of this patch did) because the slope-based adjustment needs
//     to affect the *shift-up decision itself*, not just the force applied
//     once already in that gear.
//
//     Bug found via testing: at high speed on an incline (even a shallow
//     diagonal one), the car could get stuck unable to upshift at all.
//     Cause: upshifting requires reaching within `shiftUpPowerThreshold`
//     (0.1, i.e. within 10%) of the *flat-ground* top speed for the
//     current gear. Climbing legitimately caps your achievable speed below
//     that, especially in higher gears where available force
//     (`engineForce/gear`) is already thin — so the car can plateau at a
//     speed physics won't let it exceed, permanently short of the 90%
//     mark, and just never shift. The original slope-assist patch (a
//     force multiplier only) helped you *approach* the target faster but
//     didn't change the target itself, so it didn't fully fix this.
//
//     Fix: loosen the upshift threshold by the same climb-based factor
//     used for the force boost — climbing steeply both pushes harder AND
//     accepts a lower fraction of flat-ground top speed as "good enough"
//     to shift up, which is the correct combined behavior for a car that
//     physically cannot reach flat-ground speeds while fighting gravity.
replaceOnce(
  "gearAndSlopeBlock",
  "let n=this.#m,r=HC(this.#c)*n,i=HC(this.#c-1)*n,a=(r-this.#s)/(r-i);" +
    "if(a<t.shiftUpPowerThreshold&&this.#c<t.maximumForwardGear)this.shiftUp();" +
    "else if(this.#c>1&&(this.#c>=t.firstExtendedForwardGear?this.#s<i-t.extendedGearDownshiftMargin:a>t.shiftDownPowerThreshold))this.shiftDown();" +
    "else if(this.#o.throttle){let e=t.engineForce*this.#p/this.#c*a;this.applyEngineForce(-e)}",
  "let srvVel=this.chassis.velocity,srvHorizSpeed=Math.hypot(srvVel.x,srvVel.z)," +
    "srvClimbRatio=srvHorizSpeed>.5?YC(srvVel.y/srvHorizSpeed,0,1):0," +
    "srvSlopeAssist=srvClimbRatio*t.slopeAssistStrength*(window.__srvSlopeMultiplier??1);" +
    "let n=this.#m,r=HC(this.#c)*n,i=HC(this.#c-1)*n,a=(r-this.#s)/(r-i);" +
    "if(a<t.shiftUpPowerThreshold+srvSlopeAssist&&this.#c<t.maximumForwardGear)this.shiftUp();" +
    "else if(this.#c>1&&(this.#c>=t.firstExtendedForwardGear?this.#s<i-t.extendedGearDownshiftMargin:a>t.shiftDownPowerThreshold))this.shiftDown();" +
    "else if(this.#o.throttle){let e=t.engineForce*this.#p/this.#c*a*(1+srvSlopeAssist);this.applyEngineForce(-e)}"
);

// 8. Speed cap slider. `HC(gear)` looks up each gear's rated top speed
//    from the fixed forwardGearMaxSpeeds table; scaling its return value
//    by a single multiplier stretches/compresses that whole table
//    uniformly, preserving the existing relative spacing between gears
//    (same percentage intervals) rather than adding new gears beyond 7.
//    The UI (srv-tweaks-ui.js) presents this as an absolute km/h target
//    (100-200) and computes the multiplier as target/99, since 99 km/h
//    (27.5 m/s * 3.6) is the current top speed.
replaceOnce(
  "speedCapSlider",
  "function HC(e){let t=Z.transmission.forwardGearMaxSpeeds[e];if(t===void 0)throw RangeError(`Unknown car gear: ${String(e)}.`);return t}",
  "function HC(e){let t=Z.transmission.forwardGearMaxSpeeds[e];if(t===void 0)throw RangeError(`Unknown car gear: ${String(e)}.`);return t*(window.__srvSpeedCapMultiplier??1)}"
);

// 9. Pitch resistance slider. Inserted right after the world axes (n =
//    forward, r = right, i = up) get computed each tick in prePhysics()
//    and the existing air-control call runs — reuses `r` (the world-space
//    right axis, i.e. the pitch rotation axis) rather than recomputing it.
//    Removes a fraction of the chassis's current pitch-axis angular
//    velocity, but only while raycastVehicle.groundedWheelCount>0, so it
//    never fights the car's own intentional airborne pitch control.
//    Uses chassis.addAngularVelocity(...) — the same confirmed-working API
//    the car's own airborne pitch/roll control (#g, a few lines above)
//    already uses to modify angular velocity — rather than assuming
//    direct mutation of the angularVelocity property persists (unverified,
//    and this session has already hit two silent-no-op-style failures
//    from unverified assumptions about this codebase's internals, with
//    the brake force scale).
insertAfter(
  "pitchResistance",
  "this.#s=qC(t,n),this.#g(n,r,i);",
  "if(this.raycastVehicle.groundedWheelCount>0){" +
    "let srvAv=this.chassis.angularVelocity," +
    "srvPitchRate=srvAv.x*r.x+srvAv.y*r.y+srvAv.z*r.z," +
    "srvPitchRemove=srvPitchRate*YC(window.__srvPitchDamp??.7,0,.95);" +
    "this.chassis.addAngularVelocity({x:-srvPitchRemove*r.x,y:-srvPitchRemove*r.y,z:-srvPitchRemove*r.z})}"
);

// 10. Yaw stability (new, in response to "car randomly swerves left going
//     uphill"). Investigated the "wheels colliding with the body" theory
//     directly: this.raycastVehicle = new Qb(chassis,{...}) is a stock
//     cannon-es RaycastVehicle — its wheels are pure raycasts with no
//     collision body of their own, so there's nothing for a wheel to
//     collide with in the traditional sense; that specific mechanism can
//     be ruled out with reasonable confidence. Two real possibilities that
//     couldn't be told apart without live testing: (a) a side effect of
//     the pitch-resistance patch just above (worth checking directly by
//     setting that slider to 0), or (b) a pre-existing asymmetry
//     (terrain-mesh quality on steep sections, or similar) unrelated to
//     any patch here. Rather than guess at which and patch the wrong
//     thing, this addresses the reported *symptom* directly regardless of
//     cause: removes a fraction of yaw-axis (rotation about the world "up"
//     axis, `i`) angular velocity each tick, same technique as the pitch
//     patch (dot product against the axis, chassis.addAngularVelocity to
//     remove that component) — but *only* while grounded AND neither
//     `left` nor `right` is held, so it only ever cleans up drift the
//     player isn't actively commanding and can never fight a real turn.
//     UPDATE: 0.5 (capped at 0.95) wasn't enough — still swerving when
//     crossing onto a different surface or on a steep slope. That pattern
//     (specifically surface transitions and steep grades, not general
//     driving) points at a *continuous* asymmetric-grip torque — e.g. one
//     side of the car briefly on different-friction ground than the
//     other while crossing a boundary, or unevenly loaded left/right
//     wheels on a steep/cambered slope generating uneven traction from
//     the *same* applied engine force. A fractional-removal damper fights
//     a one-time impulse fine, but a continuous source just keeps
//     reintroducing yaw velocity faster than a partial (<100%) damper
//     clears it, so it visibly still turns even though it's damped some.
//     Since "never randomly turn" was the explicit ask, this now allows
//     the multiplier up to 1 (full removal) instead of capping at 0.95,
//     and defaults there — every tick, while grounded and not steering,
//     yaw angular velocity is fully zeroed, not just reduced. This can't
//     leave residual drift no matter how strong or continuous the
//     underlying torque is, since it's reasserted fresh every tick.
insertAfter(
  "yawStability",
  "this.chassis.addAngularVelocity({x:-srvPitchRemove*r.x,y:-srvPitchRemove*r.y,z:-srvPitchRemove*r.z})}",
  "if(this.raycastVehicle.groundedWheelCount>0&&!this.#o.left&&!this.#o.right){" +
    "let srvAv2=this.chassis.angularVelocity," +
    "srvYawRate=srvAv2.x*i.x+srvAv2.y*i.y+srvAv2.z*i.z," +
    "srvYawRemove=srvYawRate*YC(window.__srvYawDamp??1,0,1);" +
    "this.chassis.addAngularVelocity({x:-srvYawRemove*i.x,y:-srvYawRemove*i.y,z:-srvYawRemove*i.z})}"
);

// 9. Rollover resistance — see the full write-up in the header comment
//    above (search "Rollover resistance"). Reuses the same anchor as the
//    pitch/yaw patches (this insertAfter call runs after them in this
//    script, so its insertion lands after theirs in the output, but
//    ordering between these three independent axis corrections doesn't
//    affect correctness).
insertAfter(
  "rolloverResistance",
  "this.#s=qC(t,n),this.#g(n,r,i);",
  "if(this.raycastVehicle.groundedWheelCount>0&&this.raycastVehicle.groundedWheelCount<4){" +
    "let srvAv3=this.chassis.angularVelocity," +
    "srvRollRate=srvAv3.x*n.x+srvAv3.y*n.y+srvAv3.z*n.z," +
    "srvRollRemove=srvRollRate*YC(window.__srvRolloverDamp??.8,0,1);" +
    "this.chassis.addAngularVelocity({x:-srvRollRemove*n.x,y:-srvRollRemove*n.y,z:-srvRollRemove*n.z})}"
);

writeFileSync(outputPath, src, "utf8");
console.log(`Gameplay-tweaks build written to ${outputPath} (${src.length} bytes).`);
