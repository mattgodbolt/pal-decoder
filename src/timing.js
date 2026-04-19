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

// Frame layout: 625 lines per full frame. For stage 1 we treat the whole
// 625 as a progressive frame and render active video into a configurable
// subset of lines (e.g. lines 23..622 for a 600-line active region).
export const LINES_PER_FIELD     = 312 // nominal; real PAL is 312.5 interlaced
export const ACTIVE_FIRST_LINE   = 23  // 1-based; first line carrying picture
export const ACTIVE_LAST_LINE    = 622 // 1-based
export const ACTIVE_LINE_COUNT   = ACTIVE_LAST_LINE - ACTIVE_FIRST_LINE + 1 // 600
