import test from "node:test";
import assert from "node:assert/strict";

import { accumulateFraction } from "./statProgress.js";

// Reproduces issue #2: 行動力 (action_power) reaching a decimal such as 6.3.
// The living-alone bonus adds +0.3 every third round. Applying it directly to
// the stat produced 0.3, 0.6, ... 6.3. The accumulator must keep the visible
// stat an integer while still granting the same long-run total.
test("repeated +0.3 bonus never makes the visible stat a decimal", () => {
  let visible = 1; // defaultExperience().action_power
  let progress = 0;

  for (let i = 0; i < 30; i += 1) {
    const { whole, remainder } = accumulateFraction(progress, 0.3);
    progress = remainder;
    visible += whole;

    assert.ok(Number.isInteger(visible), `visible stat became ${visible} at step ${i}`);
    assert.ok(progress >= 0 && progress < 1, `progress out of range: ${progress}`);
  }

  // 30 * 0.3 = 9.0 whole points granted, no fractional residue left over.
  assert.equal(visible, 1 + 9);
  assert.equal(progress, 0);
});

test("repeated +0.5 bonus stays integer and grants whole points in pairs", () => {
  let visible = 1; // intellect baseline
  let progress = 0;
  const granted = [];

  for (let i = 0; i < 6; i += 1) {
    const { whole, remainder } = accumulateFraction(progress, 0.5);
    progress = remainder;
    visible += whole;
    granted.push(whole);
    assert.ok(Number.isInteger(visible));
  }

  // +0.5 grants a point on every second application: 0,1,0,1,0,1.
  assert.deepEqual(granted, [0, 1, 0, 1, 0, 1]);
  assert.equal(visible, 1 + 3);
  assert.equal(progress, 0);
});

test("integer increments pass straight through with no carried fraction", () => {
  const { whole, remainder } = accumulateFraction(0, 3);
  assert.equal(whole, 3);
  assert.equal(remainder, 0);
});

test("floating point drift does not leak a phantom fraction", () => {
  // 0.1 + 0.2 === 0.30000000000000004 in IEEE754; the helper must not carry it
  // forward as a stat-corrupting fraction.
  const a = accumulateFraction(0, 0.1);
  const b = accumulateFraction(a.remainder, 0.2);
  assert.equal(b.whole, 0);
  assert.equal(b.remainder, 0.3);
});
