// Comb-filter PAL decoder.
//
// Replaces the per-line notch separator with a 2-line vertical comb:
// pure luma from summing adjacent same-field lines, pure chroma from
// their difference (see decode-chroma.js for the algebra). Also keeps
// PAL-D's 1-H delay-line chroma averaging on top, so phase errors are
// suppressed as well.
//
// Best quality of the three modes on vertical-edge content (colour
// bars, pixel-art-style rasters). The price: vertical luma detail is
// softened over a 2-line kernel, visible on horizontally-bandlimited
// material with fine vertical edges.

import { LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import {
  FIELD1_ACTIVE_FIRST, FIELD2_ACTIVE_FIRST,
  FIELD_ACTIVE_LINES, FRAME_ACTIVE_ROWS, LINE_SAMPLES,
} from './timing.js'
import { yuvToRgb } from './colorspace.js'
import { decodeLineYuv, decodeLineYuvComb } from './decode-chroma.js'

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

  decodeField(rgb, samples, lines, width, first1, field1Rows, 0) // field 1 → even rows
  decodeField(rgb, samples, lines, width, first2, field2Rows, 1) // field 2 → odd rows
  return rgb
}

function decodeField(rgb, samples, lines, width, firstLine, nRows, outputRowOffset) {
  // Delay-line state per field.
  //
  // For clean luma/chroma separation we need the two signal lines being
  // combed to be 180° apart in subcarrier phase. With 1135
  // samples/line (mod 4 = 3), one signal line advances the subcarrier
  // by 3·π/2 = 270°. So we use the line TWO field-lines back (2·270° =
  // 540° ≡ 180°) — the standard "2H comb" arrangement. Vertically
  // that softens luma over 4 display rows (2 same-field lines × 2 rows
  // per field-line), which is tolerable because chroma detail is
  // already vertically low-res.
  //
  // PAL-D's 1-H chroma averaging still operates on adjacent field-line
  // demodulated (U, V); it's orthogonal to the separator and addresses
  // phase-error Hanover bars.
  let metaPrev1 = null   // one field-line back
  let metaPrev2 = null   // two field-lines back
  let curPrev1  = null

  for (let f = 0; f < nRows; f++) {
    const meta = lines[firstLine + f]
    if (!meta) continue

    // Comb is only valid when the 2-back line's samples are *exactly*
    // 2·LINE_SAMPLES earlier — that's the precondition for 180°
    // subcarrier phase difference. Real PAL's fractional line timing
    // (1135.0064 vs our integer 1135) means the PLL's integer-rounded
    // activeStart occasionally drifts by one sample between lines; if
    // it has, 2·LINE_SAMPLES is wrong and the comb will leak chroma.
    // Fall back to notch on those lines.
    const combValid = metaPrev2 &&
      meta.activeStart - metaPrev2.activeStart === 2 * LINE_SAMPLES
    const cur = combValid
      ? decodeLineYuvComb(samples, meta, metaPrev2)
      : decodeLineYuv    (samples, meta)
    const prevForAvg = curPrev1 ?? cur

    const outputRow = f * 2 + outputRowOffset
    writeRgbRowAveraged(rgb, width, outputRow, cur.Y, cur.U, cur.V, prevForAvg.U, prevForAvg.V, cur.length)

    metaPrev2 = metaPrev1
    metaPrev1 = meta
    curPrev1  = cur
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
