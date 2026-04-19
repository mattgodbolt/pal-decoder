// Per-line YUV demodulation, shared between the PAL-S (notch) and
// PAL-D (delay line) decoders.
//
// Algorithm (per line):
//   1. Extract active samples, remove DC at black.
//   2. Luma: 3-tap symmetric notch at Fsc  → Y[i] = (x[i-1] + x[i+1])/2.
//      At 4×Fsc, Fsc is π/2 per sample, so samples 2 apart are 180° out
//      of phase and average to zero.
//   3. Chroma C = signal − Y.
//   4. Demodulate in a fixed absolute-sample basis (sin/cos tables
//      indexed by (activeStart + i) & 3), low-pass with a 4-tap box
//      filter (one subcarrier period ⇒ zeros at Fsc and 2·Fsc), and
//      rotate from our fixed frame into this line's natural (U, V)
//      frame using the burst-measured phaseRotation. σ (PAL switch) is
//      folded out at the end.

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
export function decodeLineYuv(samples, meta) {
  const { activeStart, length, vSign, phaseRotation = 0 } = meta
  const cosA = Math.cos(phaseRotation)
  const sinA = Math.sin(phaseRotation)

  const sig = new Float32Array(length)
  for (let i = 0; i < length; i++) sig[i] = samples[activeStart + i] - LEVEL_BLACK

  const Y = new Float32Array(length)
  for (let i = 1; i < length - 1; i++) Y[i] = 0.5 * (sig[i - 1] + sig[i + 1])
  Y[0] = sig[0]
  Y[length - 1] = sig[length - 1]

  const C = new Float32Array(length)
  for (let i = 0; i < length; i++) C[i] = sig[i] - Y[i]

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
    // Rotate fixed-frame (U,V) into natural (U, σV), then unfold σ.
    const uNat       =  uFixed * cosA + vFixed * sinA
    const vNatSigned = -uFixed * sinA + vFixed * cosA
    U[i + 1] = uNat
    V[i + 1] = vNatSigned * vSign
  }

  return { Y, U, V, length }
}
