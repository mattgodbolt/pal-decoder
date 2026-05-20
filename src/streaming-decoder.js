// Streaming PAL decoder — the shape of a real TV's signal path.
//
// One state machine, one stream of samples. `push(chunk)` feeds
// samples through the chain; `framebuffer` is read whenever the
// consumer wants to display. No frames, no batch reads, no re-scan
// of the buffer.
//
// Signal path, in order per sample:
//
//   sample in
//     │
//     ▼
//   [sync edge detector]  — threshold cross, classifies broad vs narrow
//     │            │
//     │            ▼
//     │        [V-sync: broad-pulse counter]  — fires field-start event
//     │            │
//     ▼            ▼
//   [H-oscillator: sample-in-line counter]  — pulled to sync edge
//     │
//     ▼
//   [luma/chroma split: 4-sample boxcar zeros Fsc]
//     │
//     ▼
//   [subcarrier NCO: totalSamples·π/2 + θ correction]
//     │
//     ▼
//   [burst accumulator (gated by burst window) → θ loop]
//     │
//     ▼
//   [chroma demod: C·sin, C·cos → 4-sample boxcar → U, V]
//     │
//     ▼
//   [PAL ident: classify per-line vSign from burst phase]
//     │
//     ▼
//   [framebuffer write if in active region of an image row]
//
// Phase A scope: PAL-S (notch/boxcar separator) only, proven
// equivalent to the batch `PalDecoder` on clean signals. PAL-D
// delay-line and comb filters layer on once the backbone is trusted.

import {
  LINE_SAMPLES,
  SYNC_START, SYNC_END,
  BURST_START, BURST_END,
  ACTIVE_START, ACTIVE_END,
  FIELD1_ACTIVE_FIRST, FIELD2_ACTIVE_FIRST,
  FIELD_ACTIVE_LINES, FRAME_ACTIVE_ROWS,
  HALF_LINE_SAMPLES,
} from './timing.js'
import { DEFAULT_SYNC_THRESHOLD, MIN_NORMAL_SYNC_SAMPLES } from './sync.js'
import { LEVEL_BLACK, LEVEL_WHITE } from './signal.js'
import { yuvToRgb } from './colorspace.js'

const LUMA_RANGE = LEVEL_WHITE - LEVEL_BLACK
const SIN_TAB = [0, 1, 0, -1]
const COS_TAB = [1, 0, -1, 0]

// A broad pulse is low for ~HALF_LINE_SAMPLES (568 samples, ~27 µs).
// A normal horizontal sync is ~83 samples (~4.7 µs). Threshold at
// roughly half the half-line width catches every broad pulse while
// comfortably rejecting normal sync.
const BROAD_PULSE_MIN = Math.round(0.6 * HALF_LINE_SAMPLES)

// Burst-mean smoothing: per-line bursts are EMA'd into a running mean
// phasor. Its angle gives θ directly (robust to wrap-around — no local
// minimum at θ=π); the PAL switch is then resolved per-line by cross
// product against the mean. Low α → crystal-like inertia.
const BURST_MEAN_ALPHA = 0.15

// Colour killer: below this burst amplitude, don't pull the NCO. A
// real burst from our encoder is ~0.075 (peak / √2 at 4×Fsc sampled).
const COLOUR_KILLER = 0.02

export class StreamingDecoder {
  constructor({
    width = 720,
    height = 576,
    threshold = DEFAULT_SYNC_THRESHOLD,
  } = {}) {
    if (height > FRAME_ACTIVE_ROWS) {
      throw new Error(`height ${height} exceeds frame active rows ${FRAME_ACTIVE_ROWS}`)
    }
    this.width = width
    this.height = height
    this.threshold = threshold
    this.framebuffer = new Float32Array(width * height * 3)

    // Image-row mapping: centre `height` rows inside the 288-line
    // field-active region, same as the encoder and batch decoder.
    const field1Rows = Math.ceil(height / 2)
    const field2Rows = Math.floor(height / 2)
    this.field1Rows = field1Rows
    this.field2Rows = field2Rows
    this.firstLineField1 = FIELD1_ACTIVE_FIRST + Math.floor((FIELD_ACTIVE_LINES - field1Rows) / 2)
    this.firstLineField2 = FIELD2_ACTIVE_FIRST + Math.floor((FIELD_ACTIVE_LINES - field2Rows) / 2)
    this.lastLineField1 = this.firstLineField1 + field1Rows - 1
    this.lastLineField2 = this.firstLineField2 + field2Rows - 1

    // --- sync edge detector ---
    this.prevBelow = false
    this.belowCount = 0

    // --- H-oscillator / line counter ---
    // sampleInLine = position within current line (0 at leading sync edge).
    // Resets when a narrow sync's leading edge is seen.
    this.sampleInLine = 0
    this.locked = false

    // --- V-sync broad-pulse group detector ---
    this.broadPulsesInGroup = 0
    this.samplesSinceLastBroad = Infinity
    this.field = 0     // 0 = not locked; 1 / 2 once field identified
    this.absLine = 0   // 1..625 within a frame

    // --- field-1 vs field-2 disambiguation by half-line offset ----
    // PAL field 1 broad-pulse block begins at a line boundary; field 2
    // begins half a line later. We classify by the offset between the
    // last narrow sync (line origin) and the first broad pulse of the
    // group, modulo LINE_SAMPLES. Requires H-lock to be meaningful.
    this.lastNarrowSyncAbs = -1
    this.firstBroadAbs = -1
    this.narrowSyncsSeen = 0

    // --- subcarrier NCO ---
    // Phase at sample N = N·π/2 + θ, where θ is the running correction.
    this.totalSamples = 0
    this.theta = 0
    this.cosTheta = 1
    this.sinTheta = 0

    // --- PAL ident (per-line ±V sign) ---
    this.vSign = +1

    // --- per-line burst accumulator ---
    this.burstUAcc = 0
    this.burstVAcc = 0
    this.burstN = 0

    // --- running burst-mean phasor (EMA across lines) -------------
    // Real PAL alternates V-sign each line, so (+V, −V) bursts sum to
    // a vector pointing along the U axis (in the rotated frame). The
    // angle of that running mean encodes θ directly, with no ±π
    // wrap-around ambiguity. The per-line burst minus the mean encodes
    // the V-sign for that line.
    this.burstMeanU = 0
    this.burstMeanV = 0
    this.burstMeanSeen = 0

    // --- luma / chroma streaming ---
    // 4-sample boxcar: sum of last 4 samples. Has zero at Fsc (period=4
    // at 4×Fsc) so subtracting it from the signal leaves chroma.
    this.lumaRing = new Float32Array(4)
    this.lumaSum = 0
    this.ringIdx = 0

    // Running 4-sample correlation of chroma with sin/cos(NCO phase).
    // One subcarrier cycle, so any out-of-band residual cancels.
    this.uRing = new Float32Array(4)
    this.vRing = new Float32Array(4)
    this.uSum = 0
    this.vSum = 0
  }

  /**
   * Push a chunk of composite samples through the decoder. Updates
   * internal state and writes any completed pixels to `framebuffer`.
   */
  push(samples) {
    for (let i = 0; i < samples.length; i++) this._step(samples[i])
  }

  _step(s) {
    // --- sync edge detection ------------------------------------
    const below = s < this.threshold
    if (below && !this.prevBelow) {
      // Falling edge — pulse starts. Count is zeroed below.
      this.belowCount = 0
    } else if (!below && this.prevBelow) {
      // Rising edge — pulse ended; classify by width.
      this._onPulseEnd(this.belowCount)
    }
    if (below) this.belowCount++
    this.prevBelow = below

    // --- broad-pulse group timeout -----------------------------
    this.samplesSinceLastBroad++
    if (this.broadPulsesInGroup > 0 && this.samplesSinceLastBroad > LINE_SAMPLES) {
      this._closeBroadGroup()
    }

    // --- H-oscillator counter ----------------------------------
    this.sampleInLine++

    // --- luma (4-sample boxcar) --------------------------------
    const oldest = this.lumaRing[this.ringIdx]
    this.lumaRing[this.ringIdx] = s
    this.lumaSum += s - oldest
    const Y = this.lumaSum * 0.25
    const C = s - Y

    // --- subcarrier NCO index ----------------------------------
    const p = this.totalSamples & 3
    this.totalSamples++
    const sinN = SIN_TAB[p]
    const cosN = COS_TAB[p]

    // --- chroma demod (running 4-tap correlation with sin/cos) -
    const uMix = C * sinN
    const vMix = C * cosN
    this.uSum += uMix - this.uRing[this.ringIdx]
    this.vSum += vMix - this.vRing[this.ringIdx]
    this.uRing[this.ringIdx] = uMix
    this.vRing[this.ringIdx] = vMix
    this.ringIdx = (this.ringIdx + 1) & 3

    // --- burst accumulation, applied the instant the window closes
    // Burst and active video sit on the SAME line; the burst tells us
    // what PAL-switch state and θ to demod this line's active region
    // with. So fold the accumulated burst into the NCO loop at the
    // sample just past BURST_END, before ACTIVE_START arrives.
    if (this.locked && this.sampleInLine >= BURST_START && this.sampleInLine < BURST_END) {
      this.burstUAcc += C * sinN
      this.burstVAcc += C * cosN
      this.burstN++
    } else if (this.sampleInLine === BURST_END) {
      this._applyBurstToNco()
    }

    // --- framebuffer write if in active region + valid image row
    if (this.locked && this.sampleInLine >= ACTIVE_START && this.sampleInLine < ACTIVE_END) {
      const row = this._imageRowForCurrentLine()
      if (row >= 0) {
        // Apply θ-rotation: correct U, V basis for running phase error.
        // (θ comes from burst loop — it's small once locked.)
        const U = 0.5 * (this.uSum * this.cosTheta + this.vSum * this.sinTheta)
        const V = 0.5 * (-this.uSum * this.sinTheta + this.vSum * this.cosTheta) * this.vSign
        const yNorm = (Y - LEVEL_BLACK) / LUMA_RANGE
        const activeOffset = this.sampleInLine - ACTIVE_START
        const activeLen = ACTIVE_END - ACTIVE_START
        const x = Math.min(this.width - 1, Math.floor(activeOffset * this.width / activeLen))
        const [r, g, b] = yuvToRgb(yNorm, U, V)
        const o = (row * this.width + x) * 3
        this.framebuffer[o]     = clamp01(r)
        this.framebuffer[o + 1] = clamp01(g)
        this.framebuffer[o + 2] = clamp01(b)
      }
    }
  }

  // ---------------- sync / vertical / line events ---------------

  _onPulseEnd(width) {
    // Leading edge of this pulse, in absolute sample coordinates.
    // (totalSamples hasn't been incremented for the current sample yet.)
    const leadingAbs = this.totalSamples - width
    if (width >= BROAD_PULSE_MIN) {
      // Broad pulse — part of a field-sync block.
      if (this.broadPulsesInGroup === 0) {
        this.firstBroadAbs = leadingAbs
      }
      this.broadPulsesInGroup++
      this.samplesSinceLastBroad = 0
    } else if (width >= MIN_NORMAL_SYNC_SAMPLES) {
      // Normal horizontal sync. The leading edge was `width` samples
      // back; reset sampleInLine so the new line starts at 0 at that
      // historical edge position (i.e. sampleInLine = width now).
      this.lastNarrowSyncAbs = leadingAbs
      this.narrowSyncsSeen++
      this._onLineStart(width)
    }
    // Shorter below-threshold events are chroma dips on saturated
    // colour lines (width a few samples); real TVs' sync separators
    // had AGC + low-pass so these never reached the line oscillator's
    // phase discriminator. We do the same via a width gate.
  }

  _closeBroadGroup() {
    if (this.broadPulsesInGroup >= 3) {
      this._onFieldStart()
    }
    this.broadPulsesInGroup = 0
  }

  _onFieldStart() {
    // Classify field 1 vs field 2 by the half-line offset between the
    // last narrow sync (which sits at a line origin) and the first
    // broad pulse of this group:
    //   field 1: broad block starts at a line boundary → gap ≡ 0
    //   field 2: broad block starts mid-line             → gap ≡ HALF_LINE_SAMPLES
    // We need a few narrow syncs first so the H-oscillator is trusted.
    let fieldGuess = 0
    const HALF_LINE_TOLERANCE = HALF_LINE_SAMPLES / 4
    if (this.narrowSyncsSeen >= 3 &&
        this.lastNarrowSyncAbs >= 0 &&
        this.firstBroadAbs >= 0) {
      const raw = this.firstBroadAbs - this.lastNarrowSyncAbs
      const gap = ((raw % LINE_SAMPLES) + LINE_SAMPLES) % LINE_SAMPLES
      const distTo0 = Math.min(gap, LINE_SAMPLES - gap)
      const distToHalf = Math.abs(gap - HALF_LINE_SAMPLES)
      if (distTo0 < HALF_LINE_TOLERANCE) fieldGuess = 1
      else if (distToHalf < HALF_LINE_TOLERANCE) fieldGuess = 2
    }
    if (fieldGuess !== 0) {
      this.field = fieldGuess
    } else if (this.field !== 0) {
      // No half-line evidence (e.g. mid-stream cut-in inside a broad
      // block, no prior H-lock). Fall back to alternation; the next
      // group will give us a real classification.
      this.field = this.field === 1 ? 2 : 1
    } else {
      // First-ever group with no H-lock; ignore and wait for the next.
      this.firstBroadAbs = -1
      return
    }
    // The first narrow sync after a field's broad block is encoder
    // line 6 (field 1) or line 318 (field 2). Seed absLine so the
    // next _onLineStart increments to the right number.
    this.absLine = this.field === 1 ? 5 : 317
    this.locked = true
    this.firstBroadAbs = -1
  }

  _onLineStart(syncWidth) {
    // sampleInLine was tracking the outgoing line; reset to the
    // new line's frame (leading edge was syncWidth samples back).
    this.sampleInLine = syncWidth
    this.absLine++
  }

  _applyBurstToNco() {
    if (this.burstN === 0) return
    const uLine = this.burstUAcc / this.burstN
    const vLine = this.burstVAcc / this.burstN
    this.burstUAcc = 0
    this.burstVAcc = 0
    this.burstN = 0
    // Colour killer: VBI lines write no burst, so (uLine, vLine) ≈ 0.
    // Don't pull the mean toward zero on those.
    const amp = Math.hypot(uLine, vLine)
    if (amp < COLOUR_KILLER) return
    // Seed mean on the first burst; EMA thereafter. With α=0.15 the
    // mean settles to within a few percent of true after ~30 lines.
    if (this.burstMeanSeen === 0) {
      this.burstMeanU = uLine
      this.burstMeanV = vLine
    } else {
      this.burstMeanU += BURST_MEAN_ALPHA * (uLine - this.burstMeanU)
      this.burstMeanV += BURST_MEAN_ALPHA * (vLine - this.burstMeanV)
    }
    this.burstMeanSeen++
    // Mean phasor points along the U axis in the rotated frame, i.e.
    // at angle π + θ (both ±V bursts have U component = -1/√2 ·
    // BURST_PEAK, so the mean lies on the negative U axis). Recover θ.
    const meanPhase = Math.atan2(this.burstMeanV, this.burstMeanU)
    this.theta = wrap(meanPhase - Math.PI)
    this.cosTheta = Math.cos(this.theta)
    this.sinTheta = Math.sin(this.theta)
    // Per-line vSign: cross product of this line's burst against the
    // mean. +V bursts sit on one side of the mean's U axis, −V on the
    // other; the cross product's sign distinguishes them.
    const cross = vLine * this.burstMeanU - uLine * this.burstMeanV
    this.vSign = cross < 0 ? +1 : -1
  }

  _imageRowForCurrentLine() {
    const L = this.absLine
    if (this.field === 1 && L >= this.firstLineField1 && L <= this.lastLineField1) {
      return (L - this.firstLineField1) * 2
    }
    if (this.field === 2 && L >= this.firstLineField2 && L <= this.lastLineField2) {
      return (L - this.firstLineField2) * 2 + 1
    }
    return -1
  }

  /** Clear the framebuffer to black. */
  clearFramebuffer() {
    this.framebuffer.fill(0)
  }
}

function wrap(a) {
  while (a >  Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
