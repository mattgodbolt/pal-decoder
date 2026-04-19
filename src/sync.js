// Horizontal sync detection. Given a composite signal, find the sample
// index of each line's sync leading edge.
//
// Naive threshold crossing on the raw signal is unreliable: saturated
// colour bars (red, magenta, blue) have subcarrier dips below the
// half-amplitude sync threshold, so the active video triggers spurious
// edges. Real sync separators either low-pass below Fsc or require the
// signal to stay below threshold for a minimum *width*. We do the width
// test here — real PAL syncs are ~4.7 µs (~83 samples at 4×Fsc), chroma
// dips from a sinusoidal excursion are <4 samples wide.
//
// Output positions are *fractional* sample indices, linearly interpolated
// between the two samples straddling the threshold. Sub-sample precision
// matters at 4×Fsc: a ½-sample line-start error = π/4 of subcarrier.

import { LEVEL_SYNC_TIP, LEVEL_BLANKING } from './signal.js'
import { SAMPLE_RATE_HZ } from './signal.js'
import { LINE_SAMPLES } from './timing.js'

export const DEFAULT_SYNC_THRESHOLD = (LEVEL_SYNC_TIP + LEVEL_BLANKING) / 2 // -0.15

// Minimum pulse width, in samples, for a threshold crossing to count as
// a sync leading edge. 1 µs is longer than any plausible chroma dip and
// much shorter than a real sync pulse (~4.7 µs).
export const DEFAULT_MIN_PULSE_SAMPLES = Math.round(1e-6 * SAMPLE_RATE_HZ) // ≈ 18

// Upper bound on what counts as a "normal" horizontal sync pulse. PAL
// horizontal sync is 4.7 µs (~83 samples at 4×Fsc); broad (field-sync)
// pulses span roughly half a line (~526 samples). Anything comfortably
// above 4.7 µs and below half a line is still "narrow" sync; anything
// longer is a broad pulse. 12 µs = 213 samples is a safe cutoff.
export const MAX_NORMAL_SYNC_SAMPLES = Math.round(12e-6 * SAMPLE_RATE_HZ) // ≈ 213

/**
 * Find falling-edge sync pulses in a composite signal. Returns, for each
 * detected pulse, a `{position, width}` record — position is the fractional
 * sample index of the leading edge, width is how many samples the signal
 * stayed below threshold.
 *
 * Normal 4.7 µs horizontal syncs and broad (~half-line) vertical-sync
 * pulses both appear here; callers filter by width. Use `narrow()` for
 * the horizontal PLL and `broad()` for vertical-sync detection.
 *
 * @param {Float32Array} samples
 * @param {object} [opts]
 * @param {number} [opts.threshold]         detection level (default -0.15)
 * @param {number} [opts.minPulseSamples]   minimum below-threshold width
 *                                          to count as any pulse.
 * @returns {{position: number, width: number}[]}
 */
export function findSyncPulses(samples, opts = {}) {
  const threshold       = opts.threshold       ?? DEFAULT_SYNC_THRESHOLD
  const minPulseSamples = opts.minPulseSamples ?? DEFAULT_MIN_PULSE_SAMPLES

  const pulses = []
  let i = 1
  while (i < samples.length) {
    if (samples[i - 1] >= threshold && samples[i] < threshold) {
      let belowFor = 1
      while (i + belowFor < samples.length && samples[i + belowFor] < threshold) belowFor++
      if (belowFor >= minPulseSamples) {
        const prev = samples[i - 1]
        const curr = samples[i]
        const frac = (prev - threshold) / (prev - curr)
        pulses.push({ position: i - 1 + frac, width: belowFor })
      }
      i += Math.max(1, belowFor)
    } else {
      i++
    }
  }
  return pulses
}

/** Narrow (normal horizontal sync) leading edges from findSyncPulses. */
export function narrowSyncEdges(samples, opts = {}) {
  const max = opts.maxPulseSamples ?? MAX_NORMAL_SYNC_SAMPLES
  return findSyncPulses(samples, opts)
    .filter((p) => p.width <= max)
    .map((p) => p.position)
}

/** Broad (field-sync) pulse starts. ~half-line wide. */
export function broadSyncPulses(samples, opts = {}) {
  const min = opts.minPulseSamples ?? MAX_NORMAL_SYNC_SAMPLES
  return findSyncPulses(samples, { ...opts, minPulseSamples: 1 })
    .filter((p) => p.width > min)
}

/**
 * Back-compat alias: returns just the positions of narrow sync edges.
 * Existing callers want "sync edges for the horizontal PLL".
 */
export function findSyncEdges(samples, opts = {}) {
  return narrowSyncEdges(samples, opts)
}
