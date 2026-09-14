#!/usr/bin/env node
// Applies ONLY the "Option 3" friction-budget smoothing fix for the
// turn-exit inconsistency ("wobble") bug — see the write-up in conversation.
// Produces a build that is IDENTICAL to the live site's bundle except for
// this one change. Deliberately kept separate from patch-gameplay-tweaks.mjs
// (which bundles a whole set of unrelated tuning changes/sliders) so this
// can be handed to the developer as a single, isolated, reviewable diff.
//
// Root cause (traced in the real vendored cannon-es RaycastVehicle code,
// not guessed): the car's suspension is lightly damped relative to its
// stiffness (dampingCompression/Relaxation: 2 vs suspensionStiffness: 20)
// and rollInfluence is high (0.8), so cornering forces pump body-roll
// oscillation into the suspension, which shows up as the visible "wobble."
// updateSuspension() recomputes each wheel's suspensionForce every tick
// from the (currently oscillating) spring compression/velocity. The bug:
// updateFriction() then sizes that wheel's ENTIRE per-tick traction budget
// (forward grip + cornering grip combined, in one circle) directly off that
// same raw, oscillating suspensionForce:
//   budget = (suspensionForce * dt * frictionSlip)^2
// So the instant a wheel's suspensionForce dips mid-oscillation, its grip
// budget shrinks for that tick — simultaneously widening your line AND
// bleeding speed, then recovering a tick later. Because the outcome depends
// on the oscillation's phase at turn-in, identical-looking corners produce
// different results.
//
// Fix: smooth suspensionForce with a per-wheel exponential moving average,
// and use ONLY that smoothed value to size the traction-circle budget in
// updateFriction(). The raw, unsmoothed suspensionForce is left completely
// untouched everywhere else (in particular, the actual suspension spring
// impulse applied to the chassis a few lines earlier in the step is
// unaffected) — so ride feel / suspension response is unchanged. Only the
// grip-budget calculation is desensitized to single-tick suspension noise.
//
// SRV_GRIP_SMOOTHING is the EMA weight given to each new sample per tick
// (0 = frozen/no smoothing effect, 1 = no smoothing at all, identical to
// live). 0.35 was chosen as a first pass: fast enough to track real,
// sustained load changes (e.g. braking, cresting a hill) within a few
// ticks, slow enough to absorb single-tick oscillation spikes. Tune to
// taste — the dev may want this exposed as a named constant either way.
//
// Usage: node tools/patch-friction-smoothing.mjs <input.js> <output.js>

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("Usage: node patch-friction-smoothing.mjs <input.js> <output.js>");
  process.exit(1);
}

let src = readFileSync(inputPath, "utf8");

const SRV_GRIP_SMOOTHING = 0.35;

// The exact per-wheel traction-circle sizing statement inside
// RaycastVehicle.updateFriction(), found by searching the bundle for
// "suspensionForce" and "frictionSlip" used together. `t` here is the
// traction-circle radius (grip budget) for this wheel this tick.
const anchor = "let t=r.suspensionForce*e*r.frictionSlip,n=t*t;r.forwardImpulse=s;";

const count = src.split(anchor).length - 1;
if (count !== 1) {
  throw new Error(
    `Friction-smoothing anchor matched ${count} times (expected exactly 1) — the bundle doesn't match what ` +
      `this script was written against; re-derive the anchor from a fresh copy of the site's bundle.\nAnchor: ${anchor}`
  );
}

const replacement =
  "r.srvGripForce=r.srvGripForce==null?r.suspensionForce:" +
  `r.srvGripForce+(r.suspensionForce-r.srvGripForce)*${SRV_GRIP_SMOOTHING};` +
  "let t=r.srvGripForce*e*r.frictionSlip,n=t*t;r.forwardImpulse=s;";

src = src.split(anchor).join(replacement);

writeFileSync(outputPath, src, "utf8");
console.log(`Friction-smoothing test build written to ${outputPath} (${src.length} bytes).`);
