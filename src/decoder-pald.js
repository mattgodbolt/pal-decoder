// PAL-D (delay line) decoder. Same per-line luma + demodulation as the
// notch decoder, but chroma is averaged with the previous line's chroma
// before YUV→RGB.
//
// Why this works: if the subcarrier arrives with a small phase error φ
// on line N, the decoded (U_N, V_N) is rotated by φ. On line N+1 the
// PAL switch flips V, so the same physical error manifests as a
// rotation by -φ on V. Averaging (U_N+U_{N-1})/2 and (V_N+V_{N-1})/2
// after σ has already been folded out gives:
//   U:  ½(U + U)         = U                    (cos φ ≈ 1)
//   V:  ½(V·cos φ + V·cos(-φ)) = V·cos φ        (2nd-order error)
// so φ's first-order contribution cancels. The cost: vertical chroma
// resolution is halved — fine for PAL material, whose bandwidth budget
// already puts chroma detail below luma detail.
//
// Hanover bars (the horizontal stripe pattern that shows up on PAL-S
// when the signal has a phase error) disappear.

import { LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import { ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT } from './timing.js'
import { yuvToRgb } from './colorspace.js'
import { decodeLineYuv } from './decode-chroma.js'

const LUMA_SCALE = LEVEL_WHITE - LEVEL_BLACK

export function decodeFrame(samples, lines, width, height) {
  if (height > ACTIVE_LINE_COUNT) {
    throw new Error(`height ${height} exceeds active region ${ACTIVE_LINE_COUNT}`)
  }
  const rgb = new Float32Array(width * height * 3)
  const firstPictureLine = ACTIVE_FIRST_LINE + Math.floor((ACTIVE_LINE_COUNT - height) / 2)

  // One-line delay buffer for chroma. Initialised with the first decoded
  // line so the very first output row has something sensible to average
  // against (it'll be identical to the current line, i.e. no averaging
  // on line 0 — equivalent to PAL-S there).
  let prev = null

  for (let y = 0; y < height; y++) {
    const meta = lines[firstPictureLine + y]
    if (!meta) continue
    const cur = decodeLineYuv(samples, meta)
    const prevUsed = prev ?? cur
    writeRgbRowAveraged(rgb, width, y, cur.Y, cur.U, cur.V, prevUsed.U, prevUsed.V, cur.length)
    prev = cur
  }
  return rgb
}

function writeRgbRowAveraged(rgb, width, picY, Y, U, V, Uprev, Vprev, length) {
  for (let x = 0; x < width; x++) {
    const i = Math.min(length - 1, Math.floor(((x + 0.5) * length) / width))
    const yNorm = Y[i] / LUMA_SCALE
    const uAvg = 0.5 * (U[i] + Uprev[i])
    const vAvg = 0.5 * (V[i] + Vprev[i])
    const [r, g, b] = yuvToRgb(yNorm, uAvg, vAvg)
    const o = (picY * width + x) * 3
    rgb[o]     = clamp01(r)
    rgb[o + 1] = clamp01(g)
    rgb[o + 2] = clamp01(b)
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
