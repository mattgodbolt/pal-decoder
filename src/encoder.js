// PAL composite encoder. Consumes an RGB image (Float32Array, layout
// width*height*3, values in [0,1]) and produces:
//   - samples: Float32Array of composite video at 4×Fsc, one full frame
//     (FRAME_SAMPLES = 709375 samples), in IRE-equivalent units (sync =
//     -0.3, blanking = 0, peak white = +0.7).
//   - lines:   per-absolute-line-number metadata (1..624). Each entry is
//              { activeStart, vSign, field, imageRow, length } or null
//              for lines outside an active region.
//
// Real-PAL-shaped output:
//   * Subcarrier phase is CONTINUOUS across the whole frame: every
//     sample at absolute index i carries subcarrier phase i·π/2.
//     Encoder and decoder agree so round-trip is identity; the burst
//     tells generic decoders where the U/V axes sit per line.
//   * Vertical sync: field 1 broad pulses on absolute lines 1–5; field
//     2 broad pulses on absolute lines 313–317, but at a HALF-LINE
//     OFFSET — field 2 begins at sample FIELD_2_START = 354688, i.e.
//     568 samples into what would be the integer "line 313" position.
//     That half-line stagger is what creates real PAL's interlace.
//   * Active-video lines: field 1 = abs lines 23..310 (288 lines);
//     field 2 = abs lines 335..622 (288 lines, at half-line offset).
//   * Image rows map to scanlines as ITU-R BT.470 interlace: even rows
//     → field 1, odd rows → field 2. Use lineToSample() to find each
//     line's sample offset rather than assuming a uniform grid.
//   * Line timing rounded to integer 1135 samples (real PAL is
//     1135.0064); HackTV at 4×Fsc rounds the same way. Documented
//     approximation, not a hidden expedient.

import { LEVEL_BLANKING, LEVEL_SYNC_TIP, LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import { LINES_PER_FRAME } from './signal.js'
import {
  LINE_SAMPLES, SYNC_START, SYNC_END,
  BURST_START, BURST_END, ACTIVE_START, ACTIVE_END,
  FIELD1_ACTIVE_FIRST, FIELD1_ACTIVE_LAST,
  FIELD2_ACTIVE_FIRST, FIELD2_ACTIVE_LAST,
  FIELD_ACTIVE_LINES, FRAME_ACTIVE_ROWS, FRAME_SAMPLES,
  lineToSample, lineField, isBroadPulseLine,
} from './timing.js'
import { rgbToYuv } from './colorspace.js'

// Burst amplitude (peak). Standard PAL burst is 300 mVpp = sync swing;
// peak = 0.15 on our normalised scale.
export const BURST_PEAK = 0.15

const SIN_TAB = [0, 1, 0, -1]
const COS_TAB = [1, 0, -1, 0]
const RT_HALF = Math.SQRT1_2

/**
 * Encode one frame.
 *
 * @param {Float32Array} rgb    width*height*3, values in [0,1]
 * @param {number} width
 * @param {number} height       ≤ FRAME_ACTIVE_ROWS (576)
 * @param {object} [opts]
 * @param {number} [opts.chromaPhaseError]  subcarrier phase offset
 *        injected into active-video modulation but NOT the burst.
 *        Useful to demo Hanover bars under PAL-S.
 * @returns {{ samples: Float32Array, lines: Array }}
 */
export function encodeFrame(rgb, width, height, opts = {}) {
  if (height > FRAME_ACTIVE_ROWS) {
    throw new Error(`height ${height} exceeds frame active rows ${FRAME_ACTIVE_ROWS}`)
  }
  if (rgb.length !== width * height * 3) {
    throw new Error(`rgb length ${rgb.length} != ${width * height * 3}`)
  }
  const chromaPhaseError = opts.chromaPhaseError ?? 0

  const samples = new Float32Array(FRAME_SAMPLES)
  samples.fill(LEVEL_BLANKING)
  const lines = new Array(LINES_PER_FRAME + 1).fill(null)

  const field1Rows = Math.ceil(height / 2)
  const field2Rows = Math.floor(height / 2)
  const pad1 = Math.floor((FIELD_ACTIVE_LINES - field1Rows) / 2)
  const pad2 = Math.floor((FIELD_ACTIVE_LINES - field2Rows) / 2)
  const firstLineField1 = FIELD1_ACTIVE_FIRST + pad1
  const firstLineField2 = FIELD2_ACTIVE_FIRST + pad2

  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    // Line's sample origin respects the half-line offset for field 2.
    // Absolute line numbers 1..312 are field 1 at integer line grid.
    // 313..624 are field 2 at field_2_start + (line-313)·LINE_SAMPLES.
    if (line > 624) continue // line 625 unused in our model
    const base = lineToSample(line)

    writeLineSync(samples, base, line)

    // PAL switch alternates per absolute-line number across the whole
    // frame (each scan line flips V).
    const vSign = ((line - FIELD1_ACTIVE_FIRST) & 1) === 0 ? +1 : -1

    if (isBroadPulseLine(line)) continue

    const inField1 = line >= FIELD1_ACTIVE_FIRST && line <= FIELD1_ACTIVE_LAST
    const inField2 = line >= FIELD2_ACTIVE_FIRST && line <= FIELD2_ACTIVE_LAST
    if (!inField1 && !inField2) continue

    writeBurst(samples, base, vSign)

    // Map this scanline to an image row: field 1 → even rows, field 2 → odd.
    let imageRow = -1
    if (inField1) {
      const fieldY = line - firstLineField1
      if (fieldY >= 0 && fieldY < field1Rows) imageRow = fieldY * 2
    } else {
      const fieldY = line - firstLineField2
      if (fieldY >= 0 && fieldY < field2Rows) imageRow = fieldY * 2 + 1
    }

    if (imageRow >= 0) {
      writeActiveLine(samples, base, rgb, width, imageRow, vSign, chromaPhaseError)
    }
    lines[line] = {
      activeStart: base + ACTIVE_START,
      vSign,
      length: ACTIVE_END - ACTIVE_START,
      field: inField1 ? 1 : 2,
      imageRow,
    }
  }

  return { samples, lines }
}

/**
 * Helper for progressive callers: build a 2N-row image from an N-row
 * image by duplicating each row. Both fields then carry the same
 * content when fed to encodeFrame.
 */
export function progressive(rgb, width, height) {
  const out = new Float32Array(width * (height * 2) * 3)
  for (let y = 0; y < height; y++) {
    const src = y * width * 3
    const dst0 = (y * 2) * width * 3
    const dst1 = (y * 2 + 1) * width * 3
    for (let i = 0; i < width * 3; i++) {
      out[dst0 + i] = rgb[src + i]
      out[dst1 + i] = rgb[src + i]
    }
  }
  return out
}

function writeLineSync(samples, base, line) {
  if (isBroadPulseLine(line)) {
    // Broad pulses: two ~half-line-wide sync-tip pulses per broad-pulse
    // line, each separated by a short blanking gap. (We emit a
    // simplified broad-pulse structure — enough for vertical-sync
    // detection. Real PAL has 5 broad pulses across 2.5 lines; our
    // per-line model gives the decoder the same wide-pulse signal
    // regardless.)
    const half = LINE_SAMPLES >> 1
    const gap  = Math.round(2.3e-6 * 17_734_475) // ~2.3 µs
    for (let i = 0;    i < half - gap;          i++) samples[base + i] = LEVEL_SYNC_TIP
    for (let i = half; i < LINE_SAMPLES - gap;  i++) samples[base + i] = LEVEL_SYNC_TIP
    return
  }
  for (let i = SYNC_START; i < SYNC_END; i++) samples[base + i] = LEVEL_SYNC_TIP
}

function writeBurst(samples, base, vSign) {
  const uCoef = -RT_HALF * BURST_PEAK
  const vCoef = vSign * RT_HALF * BURST_PEAK
  for (let i = BURST_START; i < BURST_END; i++) {
    const p = (base + i) & 3
    samples[base + i] = uCoef * SIN_TAB[p] + vCoef * COS_TAB[p]
  }
}

function writeActiveLine(samples, base, rgb, width, picY, vSign, chromaPhaseError) {
  const active = ACTIVE_END - ACTIVE_START
  const cosE = Math.cos(chromaPhaseError)
  const sinE = Math.sin(chromaPhaseError)
  for (let i = 0; i < active; i++) {
    const x = Math.min(width - 1, Math.floor((i * width) / active))
    const o = (picY * width + x) * 3
    const [y, u, v] = rgbToYuv(rgb[o], rgb[o + 1], rgb[o + 2])
    const abs = base + ACTIVE_START + i
    const p = abs & 3
    const sinN = SIN_TAB[p]
    const cosN = COS_TAB[p]
    const sinR = sinN * cosE + cosN * sinE
    const cosR = cosN * cosE - sinN * sinE
    const sc = u * sinR + vSign * v * cosR
    samples[abs] = lumaToIreLocal(y) + sc
  }
}

function lumaToIreLocal(y) {
  return LEVEL_BLACK + (LEVEL_WHITE - LEVEL_BLACK) * y
}
