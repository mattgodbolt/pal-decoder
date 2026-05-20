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
  FIELD_2_START, HALF_LINE_SAMPLES,
  FIELD1_BROAD_FIRST, FIELD1_BROAD_LAST,
  FIELD2_BROAD_FIRST, FIELD2_BROAD_LAST,
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
 * @param {number} [opts.absoluteSampleStart=0]  global sample index
 *        that this frame's sample 0 corresponds to. Emit successive
 *        frames with absoluteSampleStart = k·FRAME_SAMPLES and the
 *        subcarrier is continuous across frame boundaries — required
 *        for any honest multi-frame test signal, since our 4×Fsc
 *        grid has FRAME_SAMPLES mod 4 = 3 (a real broadcast's
 *        subcarrier walks through an 8-field / 4-frame supercycle,
 *        it does not restart at zero every frame).
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
  const absoluteSampleStart = opts.absoluteSampleStart ?? 0

  const samples = new Float32Array(FRAME_SAMPLES)
  samples.fill(LEVEL_BLANKING)
  const lines = new Array(LINES_PER_FRAME + 1).fill(null)

  const field1Rows = Math.ceil(height / 2)
  const field2Rows = Math.floor(height / 2)
  const pad1 = Math.floor((FIELD_ACTIVE_LINES - field1Rows) / 2)
  const pad2 = Math.floor((FIELD_ACTIVE_LINES - field2Rows) / 2)
  const firstLineField1 = FIELD1_ACTIVE_FIRST + pad1
  const firstLineField2 = FIELD2_ACTIVE_FIRST + pad2

  // Field 1 broad pulses occupy lines 1-5 (integer line grid).
  writeBroadPulseBlock(samples, 0)
  // Field 2 broad pulses sit at FIELD_2_START — HALF-LINE offset into
  // what would be the integer start of line 313. They span line
  // boundaries rather than lining up with any one line's integer
  // start, which is how real PAL's 2.5-line-per-5-half-pulses
  // structure fits into 312.5-line interlace.
  writeBroadPulseBlock(samples, FIELD_2_START)

  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    if (line > 624) continue // line 625 unused in our model
    const base = lineToSample(line)

    // Broad-pulse lines: sync samples come entirely from the broad-pulse
    // block; no narrow sync on these lines. (Real PAL has equalising
    // pulses flanking the broad block; we skip them — the surrounding
    // lines stay at blanking.)
    if (isBroadPulseLine(line)) continue

    writeLineSync(samples, base, line)

    const vSign = ((line - FIELD1_ACTIVE_FIRST) & 1) === 0 ? +1 : -1

    const inField1 = line >= FIELD1_ACTIVE_FIRST && line <= FIELD1_ACTIVE_LAST
    const inField2 = line >= FIELD2_ACTIVE_FIRST && line <= FIELD2_ACTIVE_LAST
    if (!inField1 && !inField2) continue

    writeBurst(samples, base, vSign, absoluteSampleStart)

    let imageRow = -1
    if (inField1) {
      const fieldY = line - firstLineField1
      if (fieldY >= 0 && fieldY < field1Rows) imageRow = fieldY * 2
    } else {
      const fieldY = line - firstLineField2
      if (fieldY >= 0 && fieldY < field2Rows) imageRow = fieldY * 2 + 1
    }

    if (imageRow >= 0) {
      writeActiveLine(samples, base, rgb, width, imageRow, vSign, chromaPhaseError, absoluteSampleStart)
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

// Broad-pulse block starting at `blockStart`. Writes 5 half-line-wide
// sync-tip pulses spanning 2.5 lines, matching real PAL / HackTV VBI.
function writeBroadPulseBlock(samples, blockStart) {
  const pulseWidth = HALF_LINE_SAMPLES - Math.round(2.3e-6 * 17_734_475) // ~526
  for (let p = 0; p < 5; p++) {
    const pStart = blockStart + p * HALF_LINE_SAMPLES
    for (let i = 0; i < pulseWidth; i++) {
      samples[pStart + i] = LEVEL_SYNC_TIP
    }
  }
}

/**
 * Emit N frames of the same image back-to-back with subcarrier phase
 * continuous across frame boundaries. Honest multi-frame test signal.
 */
export function encodeFrames(rgb, width, height, nFrames, opts = {}) {
  const out = new Float32Array(FRAME_SAMPLES * nFrames)
  for (let k = 0; k < nFrames; k++) {
    const { samples } = encodeFrame(rgb, width, height, {
      ...opts,
      absoluteSampleStart: k * FRAME_SAMPLES,
    })
    out.set(samples, k * FRAME_SAMPLES)
  }
  return out
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
  for (let i = SYNC_START; i < SYNC_END; i++) samples[base + i] = LEVEL_SYNC_TIP
}

function writeBurst(samples, base, vSign, absoluteSampleStart) {
  const uCoef = -RT_HALF * BURST_PEAK
  const vCoef = vSign * RT_HALF * BURST_PEAK
  for (let i = BURST_START; i < BURST_END; i++) {
    const p = (base + i + absoluteSampleStart) & 3
    samples[base + i] = uCoef * SIN_TAB[p] + vCoef * COS_TAB[p]
  }
}

function writeActiveLine(samples, base, rgb, width, picY, vSign, chromaPhaseError, absoluteSampleStart) {
  const active = ACTIVE_END - ACTIVE_START
  const cosE = Math.cos(chromaPhaseError)
  const sinE = Math.sin(chromaPhaseError)
  for (let i = 0; i < active; i++) {
    const x = Math.min(width - 1, Math.floor((i * width) / active))
    const o = (picY * width + x) * 3
    const [y, u, v] = rgbToYuv(rgb[o], rgb[o + 1], rgb[o + 2])
    const abs = base + ACTIVE_START + i
    const p = (abs + absoluteSampleStart) & 3
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
