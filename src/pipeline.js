// End-to-end stage-2 pipeline: composite samples -> RGB image, without
// the encoder-supplied line metadata. Line starts come from the PLL and
// vSign comes from the burst.

import { findSyncEdges } from './sync.js'
import { trackLines } from './pll.js'
import { measureBurst } from './burst.js'
import { decodeFrame } from './decoder-notch.js'
import { LINES_PER_FRAME } from './signal.js'
import {
  SYNC_START, BURST_START, BURST_END, ACTIVE_START, ACTIVE_END,
} from './timing.js'
import { BURST_PEAK } from './encoder.js'

// Colour-killer threshold: below this burst amplitude we treat the line
// as monochrome (vSign falls back to +1; decoded chroma is still derived
// from the signal but will be near zero if no modulation is present).
const COLOUR_KILLER = BURST_PEAK * 0.25

/**
 * Decode a full PAL frame from raw composite samples.
 *
 * Assumes the first detected sync edge corresponds to line 1 of the
 * 625-line frame — vertical sync recovery is a later stage. For the
 * stage-1 fixture, whose encoder emits lines in order, this holds.
 *
 * @param {Float32Array} samples
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array} RGB, width*height*3, values in [0,1]
 */
export function decodeComposite(samples, width, height) {
  const edges = findSyncEdges(samples)
  const tracked = trackLines(edges, LINES_PER_FRAME)
  const lines = buildLineMetadata(samples, tracked)
  return decodeFrame(samples, lines, width, height)
}

export function buildLineMetadata(samples, tracked) {
  const lines = new Array(LINES_PER_FRAME + 1).fill(null)
  const activeLen = ACTIVE_END - ACTIVE_START
  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const t = tracked[line - 1]
    if (!t) continue
    // For an idealised sharp sync transition, the threshold crossing is
    // exactly half a sample before the first in-sync sample, i.e. at
    // base + SYNC_START - 0.5. Float32 signal precision can nudge the
    // interpolated edge a few ulps either side of that, so we re-centre
    // on SYNC_START - 0.5 before rounding — otherwise Math.round(-0.5)
    // lands on the wrong integer and every line is off by one sample
    // (π/2 of subcarrier phase, catastrophic for chroma).
    const lineStart = Math.round(t.position - SYNC_START + 0.5)
    if (lineStart < 0 || lineStart + ACTIVE_END > samples.length) continue

    const burst = measureBurst(samples, lineStart, BURST_START, BURST_END)
    const vSign = burst.amplitude > COLOUR_KILLER ? burst.vSign : +1
    lines[line] = {
      activeStart: lineStart + ACTIVE_START,
      vSign,
      length: activeLen,
      burstAmplitude: burst.amplitude,
      burstPhase: burst.phase,
    }
  }
  return lines
}
