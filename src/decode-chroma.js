// Per-line YUV demodulation, shared between the PAL-S, PAL-D, and
// comb-filter decoders.
//
// activeStart is *fractional* — the true sub-sample position of the
// first active-video sample on this line, as recovered by the PLL
// without rounding. That's important because real PAL line timing is
// 1135.0064 samples/line at 4×Fsc (ours rounds to 1135), and the
// drift would otherwise shift subcarrier-phase alignment between
// neighbouring lines by up to ±π/2.
//
// Two luma/chroma separators:
//
//   decodeLineYuv(samples, meta)
//      Notch separator. Y[i] = (sig(i-1) + sig(i+1))/2 cancels Fsc
//      because samples 2 apart are 180° out of subcarrier phase at
//      4×Fsc. C = sig − Y.
//
//   decodeLineYuvComb(samples, meta, metaTwoFieldLinesBack)
//      2H vertical comb separator. Lines two field-lines apart
//      differ by 180° of subcarrier phase (± a small real-PAL drift).
//      (sig_N + sig_{N-2})/2 → pure Y, (sig_N − sig_{N-2})/2 → pure
//      chroma. Mathematically exact on vertically-uniform content,
//      softens vertical luma detail over 4 display rows.
//
// Both routines sample via linear interpolation (sampleAt) so any
// fractional activeStart is handled uniformly. The sin/cos basis is
// pre-rotated by (activeStart · π/2) mod 2π so demodulation is done
// in the signal's actual subcarrier frame. The burst-derived
// phaseRotation then captures any residual global phase offset.

import { LEVEL_BLACK } from './signal.js'

/**
 * Linear interpolation at fractional sample index.
 */
export function sampleAt(samples, x) {
  if (x <= 0) return samples[0]
  if (x >= samples.length - 1) return samples[samples.length - 1]
  const i = Math.floor(x)
  const f = x - i
  return (1 - f) * samples[i] + f * samples[i + 1]
}

/**
 * @param {Float32Array} samples
 * @param {{ activeStart: number, length: number, vSign: 1|-1,
 *           phaseRotation?: number }} meta   activeStart may be fractional
 * @returns {{ Y: Float32Array, U: Float32Array, V: Float32Array,
 *             length: number }}
 */
export function decodeLineYuv(samples, meta) {
  const { activeStart, length } = meta

  const Y = new Float32Array(length)
  const C = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const sPrev = sampleAt(samples, activeStart + i - 1) - LEVEL_BLACK
    const sHere = sampleAt(samples, activeStart + i    ) - LEVEL_BLACK
    const sNext = sampleAt(samples, activeStart + i + 1) - LEVEL_BLACK
    Y[i] = 0.5 * (sPrev + sNext)
    C[i] = sHere - Y[i]
  }
  return demodChroma(Y, C, meta)
}

export function decodeLineYuvComb(samples, meta, metaPrev) {
  const { activeStart, length } = meta
  const prevStart = metaPrev.activeStart

  const Y = new Float32Array(length)
  const C = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const a = sampleAt(samples, activeStart + i)
    const b = sampleAt(samples, prevStart   + i)
    Y[i] = 0.5 * (a + b) - LEVEL_BLACK
    C[i] = 0.5 * (a - b)
  }
  return demodChroma(Y, C, meta)
}

function demodChroma(Y, C, meta) {
  const { activeStart, length, vSign, phaseRotation = 0 } = meta

  // Phase of our "i=0" reference relative to the absolute subcarrier.
  // At 4×Fsc the subcarrier advances π/2 per sample, so the phase at
  // the fractional position activeStart is activeStart · π/2 (mod 2π).
  const alpha = activeStart * (Math.PI / 2)
  const s0 = Math.sin(alpha)
  const c0 = Math.cos(alpha)
  // Tables of sin((i+k)·π/2 + alpha) and cos(...) for k = 0..3. Stepping
  // by π/2 cycles (s, c, -s, -c) / (c, -s, -c, s).
  const SIN = [s0, c0, -s0, -c0]
  const COS = [c0, -s0, -c0, s0]

  const cosA = Math.cos(phaseRotation)
  const sinA = Math.sin(phaseRotation)

  const U = new Float32Array(length)
  const V = new Float32Array(length)
  for (let i = 0; i < length - 3; i++) {
    const p = i & 3
    let uSum = 0, vSum = 0
    for (let k = 0; k < 4; k++) {
      const ph = (p + k) & 3
      uSum += C[i + k] * SIN[ph]
      vSum += C[i + k] * COS[ph]
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
