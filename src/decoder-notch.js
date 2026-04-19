// PAL-S (notch) reference decoder. Pure JS; the GLSL port later will be
// tested against this.
//
// Given a composite Float32Array at 4×Fsc and per-line metadata from the
// encoder (activeStart, vSign, length), reconstruct an RGB Float32Array.
//
// Stage-1 simplifications match the encoder:
//   * Subcarrier phase is 0 at the start of each active region.
//   * Line metadata supplies vSign directly (stage 2 PLL will recover it
//     from the burst).
//
// Algorithm per line:
//   1. Extract active samples, remove DC at black.
//   2. Luma: 3-tap symmetric notch at Fsc.   Y[i] = (x[i-1] + x[i+1]) / 2
//      At 4×Fsc, Fsc is π/2 per sample, so samples 2 apart are 180° out
//      of phase and average to zero.
//   3. Chroma: C = signal - Y.
//   4. Demodulate with the known reference subcarrier. sin/cos at 4×Fsc
//      from phase 0 cycle through [0,1,0,-1] and [1,0,-1,0]. Multiply and
//      apply a 4-tap running-sum LPF (one subcarrier period) with a factor
//      of 2 to undo the sin²=½ demodulation gain.
//   5. YUV → RGB.

import {
  LEVEL_BLACK, LEVEL_WHITE,
} from './signal.js'
import {
  ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT,
} from './timing.js'
import { yuvToRgb } from './colorspace.js'

const LUMA_SCALE = LEVEL_WHITE - LEVEL_BLACK // 0.7

/**
 * @param {Float32Array} samples     composite signal (from encoder)
 * @param {Array} lines              per-line metadata (1-based)
 * @param {number} width             target image width
 * @param {number} height            target image height (≤ ACTIVE_LINE_COUNT)
 * @returns {Float32Array}           width*height*3 RGB, values in [0,1]
 */
export function decodeFrame(samples, lines, width, height) {
  if (height > ACTIVE_LINE_COUNT) {
    throw new Error(`height ${height} exceeds active region ${ACTIVE_LINE_COUNT}`)
  }
  const rgb = new Float32Array(width * height * 3)
  const firstPictureLine = ACTIVE_FIRST_LINE + Math.floor((ACTIVE_LINE_COUNT - height) / 2)

  for (let y = 0; y < height; y++) {
    const meta = lines[firstPictureLine + y]
    if (!meta) continue
    decodeLine(samples, meta, rgb, width, y)
  }
  return rgb
}

function decodeLine(samples, meta, rgb, width, picY) {
  const { activeStart, length, vSign, phaseRotation = 0 } = meta
  // Rotation from the line's natural (U, V) basis to our fixed (sin, cos)
  // demodulation basis. cos/sin here are applied to (U_fixed, V_fixed) to
  // recover (U_nat, σ·V_nat); σ is folded in at the end.
  const cosA = Math.cos(phaseRotation)
  const sinA = Math.sin(phaseRotation)

  // 1. Active signal with DC removed (black = 0).
  const sig = new Float32Array(length)
  for (let i = 0; i < length; i++) sig[i] = samples[activeStart + i] - LEVEL_BLACK

  // 2. Luma via 3-tap symmetric notch at Fsc.
  const Y = new Float32Array(length)
  for (let i = 1; i < length - 1; i++) Y[i] = 0.5 * (sig[i - 1] + sig[i + 1])
  Y[0] = sig[0]
  Y[length - 1] = sig[length - 1]

  // 3. Chroma.
  const C = new Float32Array(length)
  for (let i = 0; i < length; i++) C[i] = sig[i] - Y[i]

  // 4. Demodulate. 4-tap box filter = one subcarrier period = LPF with
  // zeros at Fsc and 2·Fsc. Factor of 2 undoes the sin²=½ demod gain,
  // and we apply it once at the end: U = (sum of 4 taps) / 2. Phase
  // index is absolute-sample (continuous subcarrier).
  const U = new Float32Array(length)
  const V = new Float32Array(length)
  for (let i = 0; i < length - 3; i++) {
    const p = (activeStart + i) & 3
    let uSum = 0, vSum = 0
    for (let k = 0; k < 4; k++) {
      const ph = (p + k) & 3
      const s = [0, 1, 0, -1][ph]
      const c = [1, 0, -1, 0][ph]
      uSum += C[i + k] * s
      vSum += C[i + k] * c
    }
    // Fixed-frame demodulation: U·sin + σV·cos projected onto (sin, cos).
    const uFixed = 0.5 * uSum
    const vFixed = 0.5 * vSum
    // Rotate back to the line's natural frame. For our own encoder
    // phaseRotation is 0 (cosA=1, sinA=0) so this collapses to identity.
    const uNat = uFixed * cosA + vFixed * sinA
    const vNatSigned = -uFixed * sinA + vFixed * cosA
    U[i + 1] = uNat
    V[i + 1] = vNatSigned * vSign   // fold PAL switch back out.
  }

  // 5. YUV → RGB per output pixel, nearest-neighbour from active samples.
  for (let x = 0; x < width; x++) {
    const i = Math.min(length - 1, Math.floor(((x + 0.5) * length) / width))
    const yNorm = Y[i] / LUMA_SCALE
    const [r, g, b] = yuvToRgb(yNorm, U[i], V[i])
    const o = (picY * width + x) * 3
    rgb[o]     = clamp01(r)
    rgb[o + 1] = clamp01(g)
    rgb[o + 2] = clamp01(b)
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
