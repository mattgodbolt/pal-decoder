// Per-line YUV demodulation, shared between the PAL-S, PAL-D, and
// comb-filter decoders.
//
// Two luma/chroma separators:
//
//   decodeLineYuv(samples, meta)
//      Notch separator. Y[i] = (sig[i-1] + sig[i+1])/2 cancels Fsc
//      because samples 2 apart are 180° out of subcarrier phase at
//      4×Fsc. C = sig − Y. Fast and cheap, but leaks sharp luma
//      transitions into chroma (dot crawl at colour-bar edges).
//
//   decodeLineYuvComb(samples, meta, metaTwoFieldLinesBack)
//      Vertical 2H comb separator. With 1135 samples/line (mod 4 = 3)
//      one signal line advances the subcarrier by 270°, so lines two
//      field-lines apart (= two signal lines, = four display rows)
//      differ by exactly 2·270° ≡ 180°. σ (PAL switch) toggles per
//      line so returns to the same sign over two lines. That gives:
//         (sig_N + sig_{N-2}) / 2 = pure Y          (chroma cancels)
//         (sig_N − sig_{N-2}) / 2 = pure chroma     (luma cancels)
//      At vertical bar edges where Y is identical row-to-row, this is
//      mathematically exact and eliminates cross-luminance. The cost
//      is vertical luma softening over 4 display rows when Y varies
//      vertically.
//
// After separation, both routines demodulate chroma the same way: LPF
// via 4-tap box filter (one subcarrier period), rotate from our
// fixed-sample basis into this line's natural (U, V) frame using the
// burst-measured phaseRotation, then fold σ out.

import { LEVEL_BLACK } from './signal.js'

const SIN_TAB = [0, 1, 0, -1]
const COS_TAB = [1, 0, -1, 0]

/**
 * @param {Float32Array} samples
 * @param {{ activeStart: number, length: number, vSign: 1|-1,
 *           phaseRotation?: number }} meta
 * @returns {{ Y: Float32Array, U: Float32Array, V: Float32Array,
 *             length: number }}
 */
/**
 * Notch-separator path. See file header.
 *
 * @param {Float32Array} samples
 * @param {{ activeStart: number, length: number, vSign: 1|-1,
 *           phaseRotation?: number }} meta
 * @returns {{ Y: Float32Array, U: Float32Array, V: Float32Array,
 *             length: number }}
 */
export function decodeLineYuv(samples, meta) {
  const { activeStart, length } = meta

  const sig = new Float32Array(length)
  for (let i = 0; i < length; i++) sig[i] = samples[activeStart + i] - LEVEL_BLACK

  const Y = new Float32Array(length)
  for (let i = 1; i < length - 1; i++) Y[i] = 0.5 * (sig[i - 1] + sig[i + 1])
  Y[0] = sig[0]
  Y[length - 1] = sig[length - 1]

  const C = new Float32Array(length)
  for (let i = 0; i < length; i++) C[i] = sig[i] - Y[i]

  return demodChroma(Y, C, meta)
}

/**
 * Comb-separator path: takes the current line plus the same-field line
 * one field-line earlier (two 625-line numbers earlier).
 *
 * @param {Float32Array} samples
 * @param {object} meta           current line's metadata (see above)
 * @param {object} metaPrev       previous same-field line's metadata
 * @returns {{ Y, U, V, length }}
 */
export function decodeLineYuvComb(samples, meta, metaPrev) {
  const { activeStart, length } = meta
  const prevStart = metaPrev.activeStart

  const Y = new Float32Array(length)
  const C = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const a = samples[activeStart + i]
    const b = samples[prevStart   + i]
    Y[i] = 0.5 * (a + b) - LEVEL_BLACK
    C[i] = 0.5 * (a - b)
  }

  return demodChroma(Y, C, meta)
}

function demodChroma(Y, C, meta) {
  const { activeStart, length, vSign, phaseRotation = 0 } = meta
  const cosA = Math.cos(phaseRotation)
  const sinA = Math.sin(phaseRotation)

  const U = new Float32Array(length)
  const V = new Float32Array(length)
  for (let i = 0; i < length - 3; i++) {
    const p = (activeStart + i) & 3
    let uSum = 0, vSum = 0
    for (let k = 0; k < 4; k++) {
      const ph = (p + k) & 3
      uSum += C[i + k] * SIN_TAB[ph]
      vSum += C[i + k] * COS_TAB[ph]
    }
    const uFixed = 0.5 * uSum
    const vFixed = 0.5 * vSum
    const uNat       =  uFixed * cosA + vFixed * sinA
    const vNatSigned = -uFixed * sinA + vFixed * cosA
    U[i + 1] = uNat
    V[i + 1] = vNatSigned * vSign
  }

  return { Y, U, V, length }
}
