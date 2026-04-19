// Horizontal-line timing for 625/50 PAL, expressed in samples at 4×Fsc.
//
// Real PAL line durations aren't an integer number of 4×Fsc samples
// (1135.0064...), so we use rounded integer sample counts here. The PLL
// (stage 2) is what eventually reconciles the fractional phase; at stage
// 1 the encoder and decoder share this same rounded layout, which is
// enough for round-trip correctness.

import { SAMPLE_RATE_HZ, FSC_HZ } from './signal.js'

const usToSamples = (us) => Math.round((us * 1e-6) * SAMPLE_RATE_HZ)

// Standard 625/50 line-time segments.
// Values from ITU-R BT.470 / EBU convention.
export const T_FRONT_PORCH_US = 1.65
export const T_SYNC_US        = 4.7
export const T_BACK_PORCH_US  = 5.7
export const T_ACTIVE_US      = 52.0   // nominal active video
export const T_LINE_US        = T_FRONT_PORCH_US + T_SYNC_US + T_BACK_PORCH_US + T_ACTIVE_US
// => 64.05 µs, close to the canonical 64 µs line.

// Burst: 10 cycles of Fsc, starting ~0.9 µs after sync trailing edge.
export const T_BURST_DELAY_US = 0.9
export const N_BURST_CYCLES   = 10
export const T_BURST_US       = (N_BURST_CYCLES / FSC_HZ) * 1e6 // ≈ 2.26 µs

// Sample-count equivalents (integer).
export const FRONT_PORCH_SAMPLES = usToSamples(T_FRONT_PORCH_US)
export const SYNC_SAMPLES        = usToSamples(T_SYNC_US)
export const BACK_PORCH_SAMPLES  = usToSamples(T_BACK_PORCH_US)
export const BURST_DELAY_SAMPLES = usToSamples(T_BURST_DELAY_US)
export const BURST_SAMPLES       = usToSamples(T_BURST_US)
export const ACTIVE_SAMPLES      = usToSamples(T_ACTIVE_US)

// Line offsets (sample index within a line, 0-based).
export const SYNC_START    = FRONT_PORCH_SAMPLES
export const SYNC_END      = SYNC_START + SYNC_SAMPLES
export const BURST_START   = SYNC_END + BURST_DELAY_SAMPLES
export const BURST_END     = BURST_START + BURST_SAMPLES
export const ACTIVE_START  = SYNC_END + BACK_PORCH_SAMPLES
export const ACTIVE_END    = ACTIVE_START + ACTIVE_SAMPLES
export const LINE_SAMPLES  = ACTIVE_END

// Frame layout: 625 lines per full frame.
//
// Lines 1–5    : field-1 broad pulses (vertical sync).
// Lines 6–22   : upper blanking (no burst, no picture).
// Lines 23–310 : field-1 active picture region.          (288 lines)
// Lines 311–312: mid-frame blanking.
// Lines 313–317: field-2 broad pulses.
// Lines 318–335: lower blanking / field-2 preamble.
// Lines 336–623: field-2 active picture region.          (288 lines)
// Lines 624–625: trailer blanking.
//
// Each field carries 288 picture rows; a full interlaced frame is 576
// rows, with even output rows drawn by field 1 and odd by field 2
// (ITU-R BT.470 convention). Progressive material passes the same
// content in both fields.
export const LINES_PER_FIELD     = 312 // nominal; real PAL is 312.5 interlaced

// Back-compat alias: still "the first active line of field 1".
export const ACTIVE_FIRST_LINE       = 23
export const FIELD1_ACTIVE_FIRST     = 23
export const FIELD1_ACTIVE_LAST      = 310
export const FIELD2_ACTIVE_FIRST     = 336
export const FIELD2_ACTIVE_LAST      = 623

export const FIELD_ACTIVE_LINES  = FIELD1_ACTIVE_LAST - FIELD1_ACTIVE_FIRST + 1 // 288
export const FRAME_ACTIVE_ROWS   = FIELD_ACTIVE_LINES * 2                       // 576

// Historical alias: old code referred to "the active region" as field 1
// only. Keep this as the per-field count for call sites that don't yet
// need to distinguish fields.
export const ACTIVE_LINE_COUNT   = FIELD_ACTIVE_LINES
export const ACTIVE_LAST_LINE    = FIELD1_ACTIVE_LAST
