#!/usr/bin/env node
// Applies ONLY the proposed "Option A" fix for the roll-accumulation bug
// (see the bug report written up in conversation) to a copy of swervle's
// bundle: gates the roll-angular-acceleration lines in the vehicle's
// prePhysics() by groundedWheelCount, the same way thrust is already
// gated, instead of applying them unconditionally every tick.
//
// This is deliberately kept SEPARATE from tools/patch-bundle.mjs (which
// only adds extension hooks and never changes gameplay behavior) — this
// script is only for building a local test build to verify the proposed
// fix actually resolves the issue before it's reported to the developer.
// It is not part of the extension's normal patched-bundle.js.
//
// Usage: node tools/patch-roll-fix.mjs <input.js> <output.js>

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("Usage: node patch-roll-fix.mjs <input.js> <output.js>");
  process.exit(1);
}

let src = readFileSync(inputPath, "utf8");

// The exact unconditional roll-acceleration application found in
// prePhysics() (see bug report): rollLeft/rollRight add angular velocity
// every tick with no check on how many wheels are actually grounded.
const anchor =
  "this.#o.rollLeft&&c.addScaledVector(i,-X.flight.rollAngularAccelerationPerTick*b)," +
  "this.#o.rollRight&&c.addScaledVector(i,X.flight.rollAngularAccelerationPerTick*b);";

const count = src.split(anchor).length - 1;
if (count !== 1) {
  throw new Error(
    `Roll-fix anchor matched ${count} times (expected exactly 1) — the bundle doesn't match what this ` +
      `script was written against; re-derive the anchor from a fresh copy of the site's bundle.\nAnchor: ${anchor}`
  );
}

// Option A: scale the roll-acceleration term by how much ground contact
// remains (1 = fully airborne/no grounded wheels, 0 = >=2 wheels grounded),
// mirroring the pattern already used for thrust
// (`this.raycastVehicle.groundedWheelCount>0&&(x=0)`) a few lines below
// this same anchor in the original. Grounded behavior is unchanged (the
// term already gets swamped by real suspension/tire forces there); the
// airborne/2-wheel case now decays toward zero instead of applying the
// same acceleration every tick with nothing left to oppose it.
//
// Kept as a single inline expression (no `let`, the factor is just
// repeated) rather than a separate statement — the anchor point sits in
// the middle of a comma-expression chain (`pitchUp&&...,pitchDown&&...,
// ...,rollLeft&&...,rollRight&&...`), not a statement boundary, so a `let`
// declaration there is a syntax error.
const GROUND_FACTOR = "(1-Math.min(this.raycastVehicle.groundedWheelCount,2)/2)";
const replacement =
  `this.#o.rollLeft&&c.addScaledVector(i,-X.flight.rollAngularAccelerationPerTick*b*${GROUND_FACTOR}),` +
  `this.#o.rollRight&&c.addScaledVector(i,X.flight.rollAngularAccelerationPerTick*b*${GROUND_FACTOR});`;

src = src.split(anchor).join(replacement);

writeFileSync(outputPath, src, "utf8");
console.log(`Roll-fix test build written to ${outputPath} (${src.length} bytes).`);
