// PAL-D (delay line) decoder. Same per-line luma + demodulation as the
// notch decoder, but chroma is averaged with the PREVIOUS LINE IN THE
// SAME FIELD before YUV→RGB. On an interlaced signal the relevant
// "previous" line is the output row two above (same field), not the
// row one above (other field, different subcarrier phase over a much
// longer temporal gap).
//
// Why this works: if the subcarrier arrives with a small phase error φ
// on line N, the decoded (U_N, V_N) is rotated by φ. Adjacent lines in
// the same field have their V sign flipped by the PAL switch (σ toggles
// per scanline across the whole frame, so two same-field lines two apart
// have opposite σ). Averaging cancels φ's first-order contribution in
// both U and V.

import { LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import {
  FIELD1_ACTIVE_FIRST, FIELD2_ACTIVE_FIRST,
  FIELD_ACTIVE_LINES, FRAME_ACTIVE_ROWS,
} from './timing.js'
import { yuvToRgb } from './colorspace.js'
import { decodeLineYuv } from './decode-chroma.js'

const LUMA_SCALE = LEVEL_WHITE - LEVEL_BLACK

export function decodeFrame(samples, lines, width, height) {
  if (height > FRAME_ACTIVE_ROWS) {
    throw new Error(`height ${height} exceeds frame active rows ${FRAME_ACTIVE_ROWS}`)
  }
  const rgb = new Float32Array(width * height * 3)
  const field1Rows = Math.ceil(height / 2)
  const field2Rows = Math.floor(height / 2)
  const first1 = FIELD1_ACTIVE_FIRST + Math.floor((FIELD_ACTIVE_LINES - field1Rows) / 2)
  const first2 = FIELD2_ACTIVE_FIRST + Math.floor((FIELD_ACTIVE_LINES - field2Rows) / 2)

  decodeField(rgb, samples, lines, width, first1, field1Rows, 0) // field 1 → even output rows
  decodeField(rgb, samples, lines, width, first2, field2Rows, 1) // field 2 → odd  output rows
  return rgb
}

function decodeField(rgb, samples, lines, width, firstLine, nRows, outputRowOffset) {
  // One-line delay buffer *within this field*.
  let prev = null
  for (let f = 0; f < nRows; f++) {
    const meta = lines[firstLine + f]
    if (!meta) continue
    const cur = decodeLineYuv(samples, meta)
    const prevUsed = prev ?? cur
    const outputRow = f * 2 + outputRowOffset
    writeRgbRowAveraged(rgb, width, outputRow, cur.Y, cur.U, cur.V, prevUsed.U, prevUsed.V, cur.length)
    prev = cur
  }
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
