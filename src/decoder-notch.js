// PAL-S (notch) decoder. Simple per-line: one notch for luma, one
// burst-locked demod for chroma, YUV → RGB. No vertical chroma
// averaging, so phase errors show up as "Hanover bars" — the PAL-D
// delay-line decoder is what removes those.

import { LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import {
  FIELD1_ACTIVE_FIRST, FIELD1_ACTIVE_LAST,
  FIELD2_ACTIVE_FIRST, FIELD2_ACTIVE_LAST,
  FIELD_ACTIVE_LINES, FRAME_ACTIVE_ROWS,
} from './timing.js'
import { yuvToRgb } from './colorspace.js'
import { decodeLineYuv } from './decode-chroma.js'

const LUMA_SCALE = LEVEL_WHITE - LEVEL_BLACK // 0.7

/**
 * @param {Float32Array} samples     composite signal
 * @param {Array} lines              per-line metadata (1-based)
 * @param {number} width             target image width
 * @param {number} height            target image height (≤ FRAME_ACTIVE_ROWS)
 * @returns {Float32Array}           width*height*3 RGB, values in [0,1]
 */
export function decodeFrame(samples, lines, width, height) {
  if (height > FRAME_ACTIVE_ROWS) {
    throw new Error(`height ${height} exceeds frame active rows ${FRAME_ACTIVE_ROWS}`)
  }
  const rgb = new Float32Array(width * height * 3)
  // Interlaced placement: even rows from field 1, odd from field 2.
  const field1Rows = Math.ceil(height / 2)
  const field2Rows = Math.floor(height / 2)
  const first1 = FIELD1_ACTIVE_FIRST + Math.floor((FIELD_ACTIVE_LINES - field1Rows) / 2)
  const first2 = FIELD2_ACTIVE_FIRST + Math.floor((FIELD_ACTIVE_LINES - field2Rows) / 2)

  for (let f1 = 0; f1 < field1Rows; f1++) {
    const line = first1 + f1
    const meta = lines[line]
    if (!meta) continue
    const { Y, U, V, length } = decodeLineYuv(samples, meta)
    writeRgbRow(rgb, width, f1 * 2, Y, U, V, length)
  }
  for (let f2 = 0; f2 < field2Rows; f2++) {
    const line = first2 + f2
    const meta = lines[line]
    if (!meta) continue
    const { Y, U, V, length } = decodeLineYuv(samples, meta)
    writeRgbRow(rgb, width, f2 * 2 + 1, Y, U, V, length)
  }
  return rgb
}

function writeRgbRow(rgb, width, picY, Y, U, V, length) {
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
