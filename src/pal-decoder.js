// Stateful PAL decoder. One instance; PLL, vertical-sync estimate, and
// decoder-mode state persist across decodeFrame calls, the way a real
// TV's sync circuitry stays locked frame-to-frame.
//
// Usage:
//
//   const dec = new PalDecoder({ mode: 'pald', width: 720, height: 576 })
//   dec.decodeFrame(samples1)   // PLL cold-starts, locks on vsync
//   dec.decodeFrame(samples2)   // PLL tracks forward from prior state
//   const rgb = dec.decodeFrame(samples3)   // etc.
//
// Input requirement: each decodeFrame() call takes a buffer that
// contains AT LEAST LINES_PER_FRAME × LINE_SAMPLES samples of signal.
// The tracker consumes one frame of edges per call, advancing its
// state forward by one frame.
//
// (Full sample-streaming — pushSamples(chunk) / readFrame() with an
// internal rolling buffer — is the natural next step; this class is
// the stateful core to build that on.)

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
    this.pll = null // created on first frame using the vsync hint
  }

  /**
   * Decode one frame from `samples`. Advances internal PLL state by
   * one frame of line tracking. PLL is initialised on the first call
   * from the detected vertical sync position.
   *
   * @param {Float32Array} samples
   * @returns {Float32Array}
   */
  decodeFrame(samples) {
    const decode = DECODERS[this.mode]
    if (!decode) throw new Error(`unknown decoder mode: ${this.mode}`)
    const edges = findSyncEdges(samples)

    if (!this.pll) {
      const lineOne = findLineOneSample(samples) ?? 0
      this.pll = new HorizontalPLL({
        period: LINE_SAMPLES,
        position: lineOne + SYNC_START - 0.5,
      })
    }

    // trackLines advances the PLL by exactly LINES_PER_FRAME lines.
    const tracked = trackLines(edges, LINES_PER_FRAME, { pll: this.pll })
    const lines = buildLineMetadata(samples, tracked)
    return decode(samples, lines, this.width, this.height)
  }

  /** Reset PLL/vsync state. Next decodeFrame will cold-lock again. */
  reset() {
    this.pll = null
  }

  /** Change decoder mode between frames; preserves PLL state. */
  setMode(mode) {
    if (!DECODERS[mode]) throw new Error(`unknown decoder mode: ${mode}`)
    this.mode = mode
  }
}

export function buildLineMetadata(samples, tracked) {
  const lines = new Array(LINES_PER_FRAME + 1).fill(null)
  const activeLen = ACTIVE_END - ACTIVE_START

  const rawBursts = new Array(LINES_PER_FRAME + 1).fill(null)
  const lineStarts = new Array(LINES_PER_FRAME + 1).fill(null)
  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const t = tracked[line - 1]
    if (!t) continue
    const lineStart = t.position - SYNC_START + 0.5
    if (lineStart < -1 || lineStart + ACTIVE_END > samples.length + 1) continue
    lineStarts[line] = lineStart
    const burst = measureBurst(samples, lineStart, BURST_START, BURST_END)
    if (burst.amplitude > COLOUR_KILLER) rawBursts[line] = burst
  }

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
    }
  }
  return lines
}
