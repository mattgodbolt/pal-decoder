// PAL signal constants and IRE-equivalent level helpers.
//
// Signal format (project-wide): Float32Array of composite samples at 4×Fsc.
// Units are IRE-equivalent normalised floats: sync tip = -0.3, blanking = 0,
// peak white = +0.7. This keeps arithmetic simple and matches the
// engineering convention used by most software PAL decoders.

// PAL subcarrier frequency, exact: 4'433'618.75 Hz = (1135/4 + 1/625) × 15625.
export const FSC_HZ = 4_433_618.75

// Sampling rate used throughout: 4 × Fsc.
export const SAMPLE_RATE_HZ = 4 * FSC_HZ // 17_734_475

// Line rate (horizontal scan frequency) for 625/50: 15'625 Hz.
export const LINE_RATE_HZ = 15_625

// Lines per frame (total, including vertical blanking).
export const LINES_PER_FRAME = 625

// Field rate: 50 Hz (interlaced); used by vertical timing/PLL logic later.
export const FIELD_RATE_HZ = 50

// Samples per line at 4×Fsc. Not an integer for PAL (1135.0064…); the PLL is
// what reconciles this. Use SAMPLES_PER_LINE_NOMINAL for sizing buffers.
export const SAMPLES_PER_LINE = SAMPLE_RATE_HZ / LINE_RATE_HZ
export const SAMPLES_PER_LINE_NOMINAL = Math.round(SAMPLES_PER_LINE) // 1135

// Standard level points on our normalised scale.
export const LEVEL_SYNC_TIP = -0.3
export const LEVEL_BLANKING = 0.0
export const LEVEL_BLACK    = 0.0    // 0 IRE for PAL (no setup/pedestal)
export const LEVEL_WHITE    = 0.7

// Map a luma value in [0, 1] to the composite luma range [black, white].
export function lumaToIre(y) {
  return LEVEL_BLACK + (LEVEL_WHITE - LEVEL_BLACK) * y
}

// Inverse of lumaToIre.
export function ireToLuma(s) {
  return (s - LEVEL_BLACK) / (LEVEL_WHITE - LEVEL_BLACK)
}
