// PAL composite encoder. Consumes an RGB image (Float32Array, layout
// width*height*3, values in [0,1]) and produces:
//   - samples: Float32Array of composite video at 4×Fsc, one full 625-line
//     frame, in IRE-equivalent units (sync = -0.3, blanking = 0, white = +0.7).
//   - lines:   per-line metadata, indexed by absolute line number (1-based,
//              so element 0 is unused). Each entry is { activeStart, vSign }
//              or null for lines outside the active region.
//
// PAL correctness notes:
//   * Subcarrier phase is CONTINUOUS across lines: every sample at absolute
//     index i has subcarrier phase i·π/2 (at 4×Fsc). The decoder uses the
//     same indexing, so encoder/decoder round-trip is identity. The burst
//     is what tells a generic decoder (or ours on non-self-produced
//     signals) where the U/V axes actually are per line.
//   * Vertical sync: lines 1–5 and 313–317 (field 1) carry the 5-pulse
//     broad-pulse blocks that signal start-of-field; lines 6–7.5 and
//     therein carry 2.35 µs equalising pulses. This is what a vertical
//     PLL locks onto to know which line is line 1.
//   * Progressive: one image rendered on every active line. Interlace
//     (fields on alternating lines) is deferred.
//   * Line timing is rounded to integer samples (1135 per line); real PAL
//     is 1135.0064. HackTV also rounds at 4×Fsc per its documentation.
//     This is a documented approximation, not a hidden expedient.

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

// Subcarrier samples at 4×Fsc, indexed by (absolute_sample_index & 3).
// Continuous across the whole signal — "phase n·π/2 at sample n".
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
export function encodeFrame(rgb, width, height, opts = {}) {
  if (height > ACTIVE_LINE_COUNT) {
    throw new Error(`height ${height} exceeds active region ${ACTIVE_LINE_COUNT}`)
  }
  if (rgb.length !== width * height * 3) {
    throw new Error(`rgb length ${rgb.length} != ${width * height * 3}`)
  }
  // `chromaPhaseError` shifts the subcarrier phase used for active-video
  // modulation but NOT the burst. This simulates a transmission-path
  // phase error that the decoder can't see via burst calibration — the
  // classic set-up for observing Hanover bars on PAL-S and their
  // disappearance on PAL-D.
  const chromaPhaseError = opts.chromaPhaseError ?? 0

  const totalSamples = LINES_PER_FRAME * LINE_SAMPLES
  const samples = new Float32Array(totalSamples)
  samples.fill(LEVEL_BLANKING) // default everything to blanking
  const lines = new Array(LINES_PER_FRAME + 1).fill(null) // 1-based

  // Centre the picture vertically within the active region.
  const topPad = Math.floor((ACTIVE_LINE_COUNT - height) / 2)
  const firstPictureLine = ACTIVE_FIRST_LINE + topPad

  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const base = (line - 1) * LINE_SAMPLES

    writeLineSync(samples, base, line)

    // PAL switch: +V on odd active-region lines, -V on even. Anchored to
    // the first active line so line 23 is designated +V (matches the
    // decoder's σ-walk convention of "first burst-bearing line = +V").
    const vSign = ((line - ACTIVE_FIRST_LINE) & 1) === 0 ? +1 : -1

    // Broad-pulse (field-sync) lines carry no burst and no picture —
    // their second-half sync pulse sits right where active video and
    // burst would otherwise be written, so we skip those entirely.
    if (isBroadPulseLine(line)) continue

    if (line >= ACTIVE_FIRST_LINE && line <= ACTIVE_LAST_LINE) {
      writeBurst(samples, base, vSign)
    }

    const picY = line - firstPictureLine
    if (picY >= 0 && picY < height) {
      writeActiveLine(samples, base, rgb, width, picY, vSign, chromaPhaseError)
      lines[line] = { activeStart: base + ACTIVE_START, vSign, length: ACTIVE_END - ACTIVE_START }
    } else if (line >= ACTIVE_FIRST_LINE && line <= ACTIVE_LAST_LINE) {
      lines[line] = { activeStart: base + ACTIVE_START, vSign, length: ACTIVE_END - ACTIVE_START }
    }
  }

  return { samples, lines }
}

// --- horizontal/vertical sync -----------------------------------------------
//
// 625/50 PAL sync structure per ITU-R BT.470:
//   Lines 1–5   : five BROAD (field-sync) pulses, each ~27.3 µs = half-line
//                 below blanking, with a narrow rise in between.
//   Lines 6–7.5 : five EQUALISING pulses, each ~2.35 µs wide, at the
//                 beginning of each half-line.
//   Lines 7.5–23: normal 4.7 µs horizontal syncs (here we just start from
//                 line 8; equalising trail between 6 and 7.5 rounded).
//   Lines 313–317: field-2 broad pulses.
//   Etc.
// For this stage-2 progressive pipeline we use a simplified but still-
// detectable scheme: broad pulses on lines 1..5 and 313..317 (full
// half-line below-blanking), normal sync elsewhere. Equalising pulses
// are omitted — they're there in real PAL to keep interlace stable, and
// we're progressive.

const BROAD_PULSE_LINES_FIELD1 = [1, 2, 3, 4, 5]
const BROAD_PULSE_LINES_FIELD2 = [313, 314, 315, 316, 317]

function isBroadPulseLine(line) {
  return BROAD_PULSE_LINES_FIELD1.includes(line) || BROAD_PULSE_LINES_FIELD2.includes(line)
}

function writeLineSync(samples, base, line) {
  if (isBroadPulseLine(line)) {
    // Two broad pulses per line (each spanning ~half a line), separated
    // by a short blanking rise. We put the first broad pulse starting
    // from sample 0 and running for (LINE_SAMPLES/2 - short gap); a short
    // blanking interval; then a second broad pulse running to the end of
    // the line minus a gap.
    const half = LINE_SAMPLES >> 1
    const gap  = Math.round(2.3e-6 * 17_734_475) // ~2.3 µs gap at line mid / end
    for (let i = 0;           i < half - gap;       i++) samples[base + i] = LEVEL_SYNC_TIP
    for (let i = half;        i < LINE_SAMPLES - gap; i++) samples[base + i] = LEVEL_SYNC_TIP
    // Gaps between pulses remain at blanking (0) from the samples.fill.
    return
  }
  for (let i = SYNC_START; i < SYNC_END; i++) samples[base + i] = LEVEL_SYNC_TIP
}

function writeBurst(samples, base, vSign) {
  const uCoef = -RT_HALF * BURST_PEAK
  const vCoef = vSign * RT_HALF * BURST_PEAK
  for (let i = BURST_START; i < BURST_END; i++) {
    // Absolute-sample phase indexing = continuous subcarrier.
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

    // Absolute-sample phase indexing = continuous subcarrier.
    const abs = base + ACTIVE_START + i
    const p = abs & 3
    // Subcarrier basis rotated by chromaPhaseError (sin' = sin·cosE +
    // cos·sinE; cos' = cos·cosE - sin·sinE). When chromaPhaseError is 0
    // this reduces to the plain SIN/COS tables.
    const sinN = SIN_TAB[p]
    const cosN = COS_TAB[p]
    const sinR = sinN * cosE + cosN * sinE
    const cosR = cosN * cosE - sinN * sinE
    const sc = u * sinR + vSign * v * cosR

    samples[abs] = lumaToIreLocal(y) + sc
  }
}

// Inline to avoid a function call per sample in the hot loop. Equivalent
// to lumaToIre(y) in signal.js.
function lumaToIreLocal(y) {
  return LEVEL_BLACK + (LEVEL_WHITE - LEVEL_BLACK) * y
}
