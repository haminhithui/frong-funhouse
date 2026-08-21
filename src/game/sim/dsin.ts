const TWO_PI = 2 * Math.PI

/**
 * Deterministic sine on a phase in turns ([0, 1) maps to [0, 2π)).
 *
 * Math.sin is NOT guaranteed bit-identical across JS engines, which would break
 * cross-platform replay verification. This uses only +, -, * on doubles (IEEE-754
 * exact-rounded everywhere): phase folding plus a Taylor polynomial. Max error
 * versus Math.sin is ~1e-9 — invisible at game precision.
 */
export function dsin(phase: number): number {
  let p = phase - Math.floor(phase)
  let sign = 1
  if (p >= 0.5) {
    p -= 0.5
    sign = -1
  }
  if (p > 0.25) {
    p = 0.5 - p
  }
  const x = p * TWO_PI
  const x2 = x * x
  const s =
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))))
  return sign * s
}
