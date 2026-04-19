// PAL composite encoder. Consumes an RGB image (Float32Array, layout
// width*height*3, values in [0,1]) and produces:
//   - samples: Float32Array of composite video at 4×Fsc, one full 625-line
//     frame, in IRE-equivalent units (sync = -0.3, blanking = 0, white = +0.7).
//   - lines:   per-line metadata, indexed by absolute line number (1-based,
//              so element 0 is unused). Each entry is { activeStart, vSign }
//              or null for lines outside the active region.
//
// Stage-1 simplifications (see CLAUDE.md):
//   * Progressive: active picture lines are rendered on every line in the
//     active region. Interlace (odd/even field on alternating lines) is a
//     later concern.
//   * Subcarrier phase is reset to 0 at the start of every line. Real PAL
//     carries phase across lines; the PLL will reconcile that at stage 2.
//   * Vertical blanking lines are flat blanking with normal horizontal sync
//     (no equalising / broad pulses, no VBI data).

import {
  LEVEL_BLANKING, LEVEL_SYNC_TIP, LEVEL_BLACK, LEVEL_WHITE,
} from './signal.js'
import {
  LINES_PER_FRAME,
} from './signal.js'
import {
  LINE_SAMPLES, SYNC_START, SYNC_END,
  BURST_START, BURST_END, ACTIVE_START, ACTIVE_END,
  ACTIVE_FIRST_LINE, ACTIVE_LAST_LINE, ACTIVE_LINE_COUNT,
} from './timing.js'
import { rgbToYuv } from './colorspace.js'

// Burst amplitude (peak, not peak-to-peak) on our normalised scale.
// Standard PAL burst is 300 mVpp — equal to the sync pulse swing — so peak
// amplitude is half the sync depth: 0.15.
export const BURST_PEAK = 0.15

// Subcarrier samples at 4×Fsc. Because the sample rate is exactly four
// times Fsc, sin(ωt) and cos(ωt) cycle through fixed 4-sample patterns
// indexed by (n mod 4):
//   sin: 0, 1,  0, -1
//   cos: 1, 0, -1,  0
// Every line resets to n = 0 (phase 0) in this stage-1 simplification.
const SIN_TAB = [0, 1, 0, -1]
const COS_TAB = [1, 0, -1, 0]

// PAL swinging burst: on +V lines the burst vector is at +135° from the
// +U axis; on -V lines, -135°. Decomposed into sin/cos components:
//   +V line: burst(t) =  A · (-√½ sin ωt + √½ cos ωt)   [U = -A/√2, V = +A/√2]
//   -V line: burst(t) =  A · (-√½ sin ωt - √½ cos ωt)   [U = -A/√2, V = -A/√2]
const RT_HALF = Math.SQRT1_2 // 1/√2

/**
 * Encode one progressive frame.
 *
 * @param {Float32Array} rgb    image data, width*height*3, values in [0,1]
 * @param {number} width
 * @param {number} height       must be <= ACTIVE_LINE_COUNT (600)
 * @returns {{ samples: Float32Array, lines: Array }}
 */
export function encodeFrame(rgb, width, height) {
  if (height > ACTIVE_LINE_COUNT) {
    throw new Error(`height ${height} exceeds active region ${ACTIVE_LINE_COUNT}`)
  }
  if (rgb.length !== width * height * 3) {
    throw new Error(`rgb length ${rgb.length} != ${width * height * 3}`)
  }

  const totalSamples = LINES_PER_FRAME * LINE_SAMPLES
  const samples = new Float32Array(totalSamples)
  samples.fill(LEVEL_BLANKING) // default everything to blanking
  const lines = new Array(LINES_PER_FRAME + 1).fill(null) // 1-based

  // Centre the picture vertically within the active region.
  const topPad = Math.floor((ACTIVE_LINE_COUNT - height) / 2)
  const firstPictureLine = ACTIVE_FIRST_LINE + topPad

  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const base = (line - 1) * LINE_SAMPLES

    // Horizontal sync pulse (every line).
    for (let i = SYNC_START; i < SYNC_END; i++) samples[base + i] = LEVEL_SYNC_TIP

    // PAL switch: +V on odd active-region lines, -V on even. Anchor to the
    // first active line so "line 23" is treated as +V by convention.
    const vSign = ((line - ACTIVE_FIRST_LINE) & 1) === 0 ? +1 : -1

    if (line >= ACTIVE_FIRST_LINE && line <= ACTIVE_LAST_LINE) {
      // Colour burst in the back porch, gated by colour-killer amplitude
      // (always on for non-degraded encode).
      writeBurst(samples, base, vSign)
    }

    // Active video (only within the picture region).
    const picY = line - firstPictureLine
    if (picY >= 0 && picY < height) {
      writeActiveLine(samples, base, rgb, width, picY, vSign)
      lines[line] = { activeStart: base + ACTIVE_START, vSign, length: ACTIVE_END - ACTIVE_START }
    } else if (line >= ACTIVE_FIRST_LINE && line <= ACTIVE_LAST_LINE) {
      // Active region but no picture data: leave at blanking (black).
      lines[line] = { activeStart: base + ACTIVE_START, vSign, length: ACTIVE_END - ACTIVE_START }
    }
  }

  return { samples, lines }
}

function writeBurst(samples, base, vSign) {
  const uCoef = -RT_HALF * BURST_PEAK
  const vCoef = vSign * RT_HALF * BURST_PEAK
  for (let i = BURST_START; i < BURST_END; i++) {
    const p = i & 3
    samples[base + i] = uCoef * SIN_TAB[p] + vCoef * COS_TAB[p]
  }
}

function writeActiveLine(samples, base, rgb, width, picY, vSign) {
  const active = ACTIVE_END - ACTIVE_START
  for (let i = 0; i < active; i++) {
    // Map active-video sample index to source pixel (nearest-neighbour;
    // stage 1 doesn't need a fancy resampler).
    const x = Math.min(width - 1, Math.floor((i * width) / active))
    const o = (picY * width + x) * 3
    const [y, u, v] = rgbToYuv(rgb[o], rgb[o + 1], rgb[o + 2])

    const p = (i) & 3 // subcarrier phase index — reset to 0 at ACTIVE_START
    const sc = u * SIN_TAB[p] + vSign * v * COS_TAB[p]

    samples[base + ACTIVE_START + i] = lumaToIreLocal(y) + sc
  }
}

// Inline to avoid a function call per sample in the hot loop. Equivalent
// to lumaToIre(y) in signal.js.
function lumaToIreLocal(y) {
  return LEVEL_BLACK + (LEVEL_WHITE - LEVEL_BLACK) * y
}
