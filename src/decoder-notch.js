// PAL-S (notch) decoder. Simple per-line: one notch for luma, one
// burst-locked demod for chroma, YUV → RGB. No vertical chroma
// averaging, so phase errors show up as "Hanover bars" — the PAL-D
// delay-line decoder is what removes those.

import { LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import { ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT } from './timing.js'
import { yuvToRgb } from './colorspace.js'
import { decodeLineYuv } from './decode-chroma.js'

const LUMA_SCALE = LEVEL_WHITE - LEVEL_BLACK // 0.7

/**
 * @param {Float32Array} samples     composite signal
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
    const { Y, U, V, length } = decodeLineYuv(samples, meta)
    writeRgbRow(rgb, width, y, Y, U, V, length)
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
