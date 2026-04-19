// Colour-burst measurement. Given the sample index of a line start, read
// the burst window and project onto the absolute-sample subcarrier basis.
// At 4×Fsc the subcarrier is continuous across the whole signal with
// phase n·π/2 at absolute sample n, so we index sin/cos tables by the
// absolute sample index, not anything line-relative.
//
// Returns:
//   uComponent   U-axis projection of the burst (sin basis)
//   vComponent   V-axis projection of the burst (cos basis)
//   amplitude    sqrt(U² + V²) — peak amplitude of the continuous burst
//                sinusoid. Equals BURST_PEAK (0.15) for an ideal signal.
//   vSign        +1 on PAL "+V" lines, -1 on "-V" lines (the PAL switch).
//                On an ideal +V line the burst vector is at +135° from the
//                +U axis, so the V-axis projection is positive.
//   phase        atan2(V, U) in radians — the burst vector angle. Ideal
//                values are ±3π/4 (±135°).

const SIN_TAB = [0, 1, 0, -1]
const COS_TAB = [1, 0, -1, 0]

/**
 * @param {Float32Array} samples     full composite signal
 * @param {number} lineStart         integer sample index of this line's start
 * @param {number} burstStart        offset within line where burst begins
 * @param {number} burstEnd          offset within line where burst ends
 * @returns {{
 *   uComponent: number, vComponent: number,
 *   amplitude: number, vSign: 1|-1, phase: number,
 * }}
 */
export function measureBurst(samples, lineStart, burstStart, burstEnd) {
  let uSum = 0, vSum = 0
  const n = burstEnd - burstStart
  for (let k = 0; k < n; k++) {
    const abs = lineStart + burstStart + k
    const p = abs & 3
    const s = samples[abs]
    uSum += s * SIN_TAB[p]
    vSum += s * COS_TAB[p]
  }
  // sin² (and cos²) average to ½ over a full subcarrier cycle, so the
  // 2/N factor recovers the original U/V component amplitude.
  const u = (2 / n) * uSum
  const v = (2 / n) * vSum
  return {
    uComponent: u,
    vComponent: v,
    amplitude: Math.sqrt(u * u + v * v),
    // vSign by sign of V alone isn't meaningful on a rotated subcarrier;
    // callers determine the PAL switch state from burst-alternation
    // across lines. Reported here only for diagnostics.
    vSign: v >= 0 ? +1 : -1,
    phase: Math.atan2(v, u),
  }
}
