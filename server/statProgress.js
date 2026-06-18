// Helpers that keep integer-only stats (issue #2) integer while still allowing
// slow, sub-point growth bonuses to accumulate over time.

/**
 * Add `amount` to a carried-over fractional progress value and split the result
 * into the whole points to apply now and the remaining fraction to carry.
 *
 * Visible stats only ever receive `whole` (an integer), so a stat can never end
 * up as a decimal such as the 6.3 reported in issue #2.
 *
 * @param {number} progress carried fractional progress (0 <= progress < 1)
 * @param {number} amount   increment to add (may be fractional)
 * @returns {{ whole: number, remainder: number }}
 */
export function accumulateFraction(progress, amount) {
  const carried = (Number.isFinite(progress) ? progress : 0)
    + (Number.isFinite(amount) ? amount : 0);
  const whole = Math.floor(carried);
  // toFixed avoids binary floating point drift (e.g. 0.1 + 0.2).
  const remainder = Number((carried - whole).toFixed(4));
  return { whole, remainder };
}
