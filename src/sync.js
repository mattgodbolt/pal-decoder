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

/**
 * Find sync leading edges in a composite signal.
 *
 * @param {Float32Array} samples
 * @param {object} [opts]
 * @param {number} [opts.threshold]           detection level (default -0.15)
 * @param {number} [opts.minPulseSamples]     minimum width the signal must
 *                                            remain below threshold for
 *                                            the dip to count as sync.
 * @param {number} [opts.minLineSpacing]      samples; paranoia guard against
 *                                            re-detecting within one line.
 *                                            Default: 50% of a nominal line.
 * @returns {number[]}  fractional sample indices of each leading edge
 */
export function findSyncEdges(samples, opts = {}) {
  const threshold       = opts.threshold       ?? DEFAULT_SYNC_THRESHOLD
  const minPulseSamples = opts.minPulseSamples ?? DEFAULT_MIN_PULSE_SAMPLES
  const minLineSpacing  = opts.minLineSpacing  ?? Math.floor(LINE_SAMPLES * 0.5)

  const edges = []
  let lastEdge = -Infinity
  let i = 1
  while (i < samples.length) {
    if (samples[i - 1] >= threshold && samples[i] < threshold) {
      // Candidate leading edge. Measure how long the signal stays below
      // threshold from here on.
      let belowFor = 1
      while (i + belowFor < samples.length && samples[i + belowFor] < threshold) belowFor++
      if (belowFor >= minPulseSamples && i - lastEdge >= minLineSpacing) {
        const prev = samples[i - 1]
        const curr = samples[i]
        const frac = (prev - threshold) / (prev - curr)
        edges.push(i - 1 + frac)
        lastEdge = i
      }
      // Skip past the dip either way (avoids re-evaluating the same
      // samples after a rejected short dip).
      i += Math.max(1, belowFor)
    } else {
      i++
    }
  }
  return edges
}
