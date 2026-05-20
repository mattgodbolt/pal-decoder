// 625/50 PAL timing, in samples at 4×Fsc.
//
// Real PAL uses *half-line-offset interlace*: field 1 spans 312.5 lines
// worth of signal time, field 2 also 312.5 — the half-line staggers
// field 2's vertical scan position halfway between field 1's, creating
// the full 625-line raster on a CRT.
//
// Practical sample-grid implementation:
//   - Frame: 625 × LINE_SAMPLES = 709375 samples (integer at 4×Fsc).
//   - Field 1: samples 0 to FIELD_2_START - 1 (354688 samples).
//   - Field 2: samples FIELD_2_START to FRAME_SAMPLES - 1 (354687 samples).
//   - FIELD_2_START = round(312.5 × LINE_SAMPLES) = 354688, i.e. 568
//     samples into what would be "absolute line 313". That 568-sample
//     offset (≈ half a line) is the physical half-line stagger.
//
// Line numbering is field-local with an "absolute" view:
//   - Lines 1..312 belong to field 1, at samples (N-1) × LINE_SAMPLES.
//   - Lines 313..624 belong to field 2, at samples FIELD_2_START +
//     (N-313) × LINE_SAMPLES. (Use lineToSample() rather than assuming
//     a uniform grid.)

import { SAMPLE_RATE_HZ, FSC_HZ } from './signal.js'

const usToSamples = (us) => Math.round((us * 1e-6) * SAMPLE_RATE_HZ)

export const T_FRONT_PORCH_US = 1.65
export const T_SYNC_US        = 4.7
export const T_BACK_PORCH_US  = 5.7
export const T_ACTIVE_US      = 52.0
export const T_LINE_US        = T_FRONT_PORCH_US + T_SYNC_US + T_BACK_PORCH_US + T_ACTIVE_US

export const T_BURST_DELAY_US = 0.9
export const N_BURST_CYCLES   = 10
export const T_BURST_US       = (N_BURST_CYCLES / FSC_HZ) * 1e6

export const FRONT_PORCH_SAMPLES = usToSamples(T_FRONT_PORCH_US)
export const SYNC_SAMPLES        = usToSamples(T_SYNC_US)
export const BACK_PORCH_SAMPLES  = usToSamples(T_BACK_PORCH_US)
export const BURST_DELAY_SAMPLES = usToSamples(T_BURST_DELAY_US)
export const BURST_SAMPLES       = usToSamples(T_BURST_US)
export const ACTIVE_SAMPLES      = usToSamples(T_ACTIVE_US)

// Line offsets (sample index within a line, 0-based) using the real-PAL
// convention: SYNC starts at sample 0, back porch + burst follow, then
// active, and finally FRONT PORCH at the end. This matches HackTV's
// output so captures can be decoded against the same grid.
export const SYNC_START    = 0
export const SYNC_END      = SYNC_START + SYNC_SAMPLES
export const BURST_START   = SYNC_END + BURST_DELAY_SAMPLES
export const BURST_END     = BURST_START + BURST_SAMPLES
export const ACTIVE_START  = SYNC_END + BACK_PORCH_SAMPLES
export const ACTIVE_END    = ACTIVE_START + ACTIVE_SAMPLES
export const FRONT_PORCH_START = ACTIVE_END
export const LINE_SAMPLES  = ACTIVE_END + FRONT_PORCH_SAMPLES

// Frame / field structure.
export const LINES_PER_FRAME  = 625 // total absolute line count
export const LINES_PER_FIELD  = 312 // full lines per field (+ half-line ≈ 312.5)
export const FRAME_SAMPLES    = LINES_PER_FIELD * 2 * LINE_SAMPLES + LINE_SAMPLES // = 625·1135 = 709375
// FIELD_2_START: round(312.5 × LINE_SAMPLES). Use 568 for the half-line
// offset (slightly rounded from the true 567.5). HackTV at 4×Fsc uses
// the same offset — group-1 at sample 354688 — so our encoder and
// HackTV agree on the grid.
export const HALF_LINE_SAMPLES = 568
export const FIELD_2_START     = 312 * LINE_SAMPLES + HALF_LINE_SAMPLES // 354688

// Field-1 active region: local lines 23..310 (288 lines of picture).
// Absolute line numbers are the same since field-1 lines start at sample
// (N-1) × LINE_SAMPLES with N matching the absolute line number.
export const FIELD1_ACTIVE_FIRST = 23
export const FIELD1_ACTIVE_LAST  = 310

// Field-2 active region. Per ITU-R BT.470, field 2's blanking is one
// line longer than field 1's because the half-line offset pushes
// everything by half a scan line — so field 2 active starts at line
// 336 (not 335) and ends at 623. Local index of field-2 first active
// is 24 (instead of field 1's 23).
export const FIELD2_ACTIVE_FIRST = 336
export const FIELD2_ACTIVE_LAST  = 623

export const FIELD_ACTIVE_LINES  = FIELD1_ACTIVE_LAST - FIELD1_ACTIVE_FIRST + 1 // 288
export const FRAME_ACTIVE_ROWS   = FIELD_ACTIVE_LINES * 2                       // 576

// Historical aliases.
export const ACTIVE_FIRST_LINE   = FIELD1_ACTIVE_FIRST
export const ACTIVE_LAST_LINE    = FIELD1_ACTIVE_LAST
export const ACTIVE_LINE_COUNT   = FIELD_ACTIVE_LINES

// Broad-pulse VBI lines. First five lines of each field carry broad
// (field-sync) pulses.
export const FIELD1_BROAD_FIRST = 1
export const FIELD1_BROAD_LAST  = 5
export const FIELD2_BROAD_FIRST = 313
export const FIELD2_BROAD_LAST  = 317

/**
 * Sample index where line N's sync would sit on an integer line grid.
 * All 625 lines use the same grid: line N at sample (N-1)·LINE_SAMPLES.
 * The half-line interlace offset shows up only in the POSITION of
 * field 2's broad-pulse *block* (FIELD_2_START), which spans line
 * boundaries rather than aligning with any one line.
 *
 * @param {number} absLine 1..625
 * @returns {number}
 */
export function lineToSample(absLine) {
  return (absLine - 1) * LINE_SAMPLES
}

/**
 * Which field does absolute line N belong to?
 * @param {number} absLine
 * @returns {1|2}
 */
export function lineField(absLine) {
  return absLine <= FIELD2_BROAD_FIRST - 1 ? 1 : 2
}

export function isBroadPulseLine(absLine) {
  return (absLine >= FIELD1_BROAD_FIRST && absLine <= FIELD1_BROAD_LAST) ||
         (absLine >= FIELD2_BROAD_FIRST && absLine <= FIELD2_BROAD_LAST)
}
