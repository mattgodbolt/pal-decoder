// End-to-end decode pipeline: composite samples -> RGB image.
//
// Real PAL decoders lock onto the colour burst on *every* line and use
// its phase as the chroma demodulation reference, because the subcarrier
// is continuous across lines and the burst is the per-line calibration
// signal that tells you where the U/V axes actually are. We do the same
// thing: the decoder demodulates in a fixed reference frame, then rotates
// into each line's natural (U, V) frame using the burst-measured phase.
//
// The PAL switch flips V on every line. Real signals use an 8-field
// sequence to tell you which is which; since we don't recover vertical
// sync yet, `firstVSign` lets the caller try both orderings — for our
// own encoder +1 is correct.

import { findSyncEdges } from './sync.js'
import { HorizontalPLL, trackLines } from './pll.js'
import { findLineOneSample } from './vsync.js'
import { measureBurst } from './burst.js'
import { decodeFrame as decodeFrameNotch } from './decoder-notch.js'
import { decodeFrame as decodeFramePald }  from './decoder-pald.js'
import { decodeFrame as decodeFrameComb }  from './decoder-comb.js'
import { LINES_PER_FRAME } from './signal.js'
import {
  SYNC_START, BURST_START, BURST_END, ACTIVE_START, ACTIVE_END, LINE_SAMPLES,
} from './timing.js'
import { BURST_PEAK } from './encoder.js'

// Colour-killer threshold: below this burst amplitude we treat the line
// as monochrome and skip the burst-derived phase rotation.
const COLOUR_KILLER = BURST_PEAK * 0.25

// Burst angles in a line's natural frame. ±135° from the +U axis is the
// PAL spec (it's what "swinging burst" means).
const BURST_ANGLE_PLUS  = +3 * Math.PI / 4
const BURST_ANGLE_MINUS = -3 * Math.PI / 4

const DECODERS = {
  notch: decodeFrameNotch,
  pald:  decodeFramePald,
  comb:  decodeFrameComb,
}

/**
 * Decode a full PAL frame from raw composite samples.
 *
 * @param {Float32Array} samples
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {'notch'|'pald'|'comb'} [opts.mode]  decoder to use.
 *        - `notch`: PAL-S, per-line notch + no chroma averaging.
 *        - `pald`:  PAL-D, notch separator + 1-H chroma averaging
 *                   (cancels phase-error Hanover bars).
 *        - `comb`:  comb separator + PAL-D averaging (also cancels
 *                   cross-luminance dot crawl at sharp transitions).
 *        Default: 'pald'.
 * @returns {Float32Array}
 */
export function decodeComposite(samples, width, height, opts = {}) {
  const mode = opts.mode ?? 'pald'
  const decodeFrame = DECODERS[mode]
  if (!decodeFrame) throw new Error(`unknown decoder mode: ${mode}`)
  const edges = findSyncEdges(samples)

  // Vertical sync: locate line 1. If we can't find a broad-pulse sequence
  // we fall back to assuming line 1 = sample 0, which matches our encoder
  // when capture starts exactly at the frame boundary. In general this is
  // where a real CRT would briefly roll until it locked.
  const lineOneSample = findLineOneSample(samples) ?? 0

  // Seed the horizontal PLL at line 1's predicted sync edge, so that
  // the 5 VBI lines free-run (we have no narrow sync edges there) and
  // the PLL locks on at line 6.
  const pll = new HorizontalPLL({
    period: LINE_SAMPLES,
    position: lineOneSample + SYNC_START - 0.5,
  })
  const tracked = trackLines(edges, LINES_PER_FRAME, { pll })

  const lines = buildLineMetadata(samples, tracked)
  return decodeFrame(samples, lines, width, height)
}

export function buildLineMetadata(samples, tracked) {
  const lines = new Array(LINES_PER_FRAME + 1).fill(null)
  const activeLen = ACTIVE_END - ACTIVE_START

  // First pass: measure burst on every line that has one.
  const rawBursts = new Array(LINES_PER_FRAME + 1).fill(null)
  const lineStarts = new Array(LINES_PER_FRAME + 1).fill(null)
  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const t = tracked[line - 1]
    if (!t) continue
    const lineStart = Math.round(t.position - SYNC_START + 0.5)
    if (lineStart < 0 || lineStart + ACTIVE_END > samples.length) continue
    lineStarts[line] = lineStart
    const burst = measureBurst(samples, lineStart, BURST_START, BURST_END)
    if (burst.amplitude > COLOUR_KILLER) rawBursts[line] = burst
  }

  // Second pass: walk the σ sequence. The PAL switch flips V every line,
  // so burst vectors on adjacent lines in the natural frame differ by
  // 270° (or 90° — same direction, different sign convention). The
  // measurement frame rotates continuously with the subcarrier (since
  // our decoder uses absolute-phase indexing and line length isn't a
  // multiple of the subcarrier period), so inter-line burst-phase diffs
  // encode σ directly:
  //   Δα per line (structural, from LINE_SAMPLES mod 4 = 3) = 3π/2 mod 2π
  //   diff = -σ·270° + Δα  →  σ = -1  when diff ≈  +180°
  //                          σ = +1  when diff ≈  0
  // Convention: first burst-bearing line is +V.
  let firstBurstLine = -1
  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    if (rawBursts[line]) { firstBurstLine = line; break }
  }

  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const lineStart = lineStarts[line]
    if (lineStart === null) continue
    const burst = rawBursts[line]

    let vSign, phaseRotation
    if (burst) {
      // σ by alternation from firstBurstLine.
      const parity = (line - firstBurstLine) & 1
      vSign = parity === 0 ? +1 : -1
      const ideal = vSign > 0 ? BURST_ANGLE_PLUS : BURST_ANGLE_MINUS
      phaseRotation = burst.phase - ideal
    } else {
      // No burst (typically outside active region or dropped). Decoder
      // skips chroma effectively since colour killer will have zeroed
      // everything; vSign doesn't matter here.
      vSign = +1
      phaseRotation = 0
    }

    lines[line] = {
      activeStart: lineStart + ACTIVE_START,
      vSign,
      length: activeLen,
      phaseRotation,
      burstAmplitude: burst ? burst.amplitude : 0,
      burstPhase: burst ? burst.phase : 0,
    }
  }
  return lines
}
