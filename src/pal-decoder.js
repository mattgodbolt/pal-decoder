// Stateful PAL decoder — one instance; horizontal PLL state persists
// across decodeFrame calls the way a real TV's sync circuitry stays
// locked frame-to-frame.
//
// Real-PAL handling: field 1 and field 2 have a half-line sample offset
// between them (field 2 starts at FIELD_2_START ≈ 312.5 × LINE_SAMPLES,
// not at the integer line 313 position). We therefore run TWO PLLs —
// one per field — each tracking 312 full lines of its own field. One
// PLL alone at LINE_SAMPLES-per-step intervals would miss field 2's
// narrow syncs because they sit half a line offset from field 1's.

import { findSyncEdges } from './sync.js'
import { HorizontalPLL, trackLines } from './pll.js'
import { findFieldOneSample } from './vsync.js'
import { measureBurst } from './burst.js'
import { decodeFrame as decodeFrameNotch } from './decoder-notch.js'
import { decodeFrame as decodeFramePald }  from './decoder-pald.js'
import { decodeFrame as decodeFrameComb }  from './decoder-comb.js'
import { LINES_PER_FRAME } from './signal.js'
import {
  SYNC_START, BURST_START, BURST_END, ACTIVE_START, ACTIVE_END, LINE_SAMPLES,
  LINES_PER_FIELD, FIELD_2_START, FIELD2_BROAD_FIRST,
  lineToSample, lineField,
} from './timing.js'
import { BURST_PEAK } from './encoder.js'

const DECODERS = {
  notch: decodeFrameNotch,
  pald:  decodeFramePald,
  comb:  decodeFrameComb,
}

const COLOUR_KILLER = BURST_PEAK * 0.25
const BURST_ANGLE_PLUS  = +3 * Math.PI / 4
const BURST_ANGLE_MINUS = -3 * Math.PI / 4

export class PalDecoder {
  constructor(opts = {}) {
    const { mode = 'pald', width = 720, height = 576 } = opts
    this.mode = mode
    this.width = width
    this.height = height
    // Two long-lived PLLs — one per field. Created lazily on the first
    // frame so they can be seeded from the first vsync detection.
    this.pllField1 = null
    this.pllField2 = null
  }

  /**
   * Decode one frame from `samples`. Advances PLL state by one frame
   * (one field's worth on each PLL). PLLs are created lazily from the
   * first call's vsync detection.
   */
  decodeFrame(samples) {
    const decode = DECODERS[this.mode]
    if (!decode) throw new Error(`unknown decoder mode: ${this.mode}`)

    const edges = findSyncEdges(samples)

    if (!this.pllField1 || !this.pllField2) {
      // findFieldOneSample locates field-1 line 1 (the "frame start").
      // Both PLLs are seeded from this; field 2 PLL sits FIELD_2_START
      // samples later.
      const fieldOneStart = findFieldOneSample(samples) ?? 0
      this.pllField1 = new HorizontalPLL({
        period: LINE_SAMPLES,
        position: fieldOneStart + SYNC_START - 0.5,
      })
      this.pllField2 = new HorizontalPLL({
        period: LINE_SAMPLES,
        position: fieldOneStart + FIELD_2_START + SYNC_START - 0.5,
      })
    }

    // Each PLL advances a full FRAME's worth of line steps
    // (LINES_PER_FRAME = 625). That advances `predicted` by
    // 625·LINE_SAMPLES = FRAME_SAMPLES, keeping the PLL aligned with
    // the next frame for the next decodeFrame call. Within each 625-
    // iteration track, only the first LINES_PER_FIELD = 312 entries
    // carry real narrow-sync matches for that PLL's field; the rest
    // free-run through the other field's territory.
    const trackedF1 = trackLines(edges, LINES_PER_FRAME, { pll: this.pllField1 })
    const trackedF2 = trackLines(edges, LINES_PER_FRAME, { pll: this.pllField2 })
    const lines = buildLineMetadata(samples, trackedF1, trackedF2)
    return decode(samples, lines, this.width, this.height)
  }

  reset() {
    this.pllField1 = null
    this.pllField2 = null
  }

  setMode(mode) {
    if (!DECODERS[mode]) throw new Error(`unknown decoder mode: ${mode}`)
    this.mode = mode
  }
}

/**
 * Build the per-absolute-line metadata array used by the decoders from
 * two per-field tracked-line arrays (each 312 long).
 */
export function buildLineMetadata(samples, trackedF1, trackedF2) {
  const lines = new Array(LINES_PER_FRAME + 1).fill(null)
  const activeLen = ACTIVE_END - ACTIVE_START

  // Convert (tracked, absLine) pairs into per-line metadata.
  const perLine = new Array(LINES_PER_FRAME + 1).fill(null)
  for (let local = 0; local < LINES_PER_FIELD; local++) {
    perLine[local + 1]                     = trackedF1[local]                          // abs 1..312
    perLine[local + FIELD2_BROAD_FIRST]    = trackedF2[local]                          // abs 313..624
  }

  // First pass: compute line starts and measure bursts.
  const lineStarts = new Array(LINES_PER_FRAME + 1).fill(null)
  const rawBursts  = new Array(LINES_PER_FRAME + 1).fill(null)
  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const t = perLine[line]
    if (!t) continue
    const lineStart = t.position - SYNC_START + 0.5
    if (lineStart < -1 || lineStart + ACTIVE_END > samples.length + 1) continue
    lineStarts[line] = lineStart
    const burst = measureBurst(samples, lineStart, BURST_START, BURST_END)
    if (burst.amplitude > COLOUR_KILLER) rawBursts[line] = burst
  }

  // σ convention: first burst-bearing line is +V. σ alternates per
  // absolute line. (Each absolute line of ITU-R 625 numbering has V
  // flipped, including across field boundaries — the "PAL switch"
  // depends on line parity.)
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
      const parity = (line - firstBurstLine) & 1
      vSign = parity === 0 ? +1 : -1
      const ideal = vSign > 0 ? BURST_ANGLE_PLUS : BURST_ANGLE_MINUS
      phaseRotation = burst.phase - ideal
    } else {
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
      field: lineField(line),
    }
  }
  return lines
}
