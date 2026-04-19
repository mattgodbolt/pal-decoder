// Horizontal sync detection. Given a composite signal, find the sample
// index of each line's sync leading edge.
//
// Sync pulses are wide (~4.7 µs) negative excursions to -0.3 IRE. A simple
// threshold crossing at the half-amplitude point (-0.15) is enough for
// clean signals; the PLL (next slice) will handle noise and drift.
//
// Output positions are *fractional* sample indices, linearly interpolated
// between the two samples straddling the threshold. This is important at
// 4×Fsc — a ±½-sample error in line-start estimation would cause a ±π/4
// phase error at the subcarrier.

import { LEVEL_SYNC_TIP, LEVEL_BLANKING } from './signal.js'
import { LINE_SAMPLES } from './timing.js'

export const DEFAULT_SYNC_THRESHOLD = (LEVEL_SYNC_TIP + LEVEL_BLANKING) / 2 // -0.15

/**
 * Find sync leading edges in a composite signal.
 *
 * @param {Float32Array} samples
 * @param {object} [opts]
 * @param {number} [opts.threshold]         detection level (default -0.15)
 * @param {number} [opts.minLineSpacing]    samples; blocks duplicate edges
 *                                          within a noisy transition.
 *                                          Default: 80% of a nominal line.
 * @returns {number[]}  fractional sample indices of each leading edge
 */
export function findSyncEdges(samples, opts = {}) {
  const threshold     = opts.threshold     ?? DEFAULT_SYNC_THRESHOLD
  const minLineSpacing = opts.minLineSpacing ?? Math.floor(LINE_SAMPLES * 0.8)

  const edges = []
  let lastEdge = -Infinity
  let above = samples[0] >= threshold

  for (let i = 1; i < samples.length; i++) {
    const now = samples[i] >= threshold
    if (above && !now && i - lastEdge >= minLineSpacing) {
      // Leading edge: crossing from blanking down to sync tip. Linearly
      // interpolate between samples[i-1] (above) and samples[i] (below).
      const prev = samples[i - 1]
      const curr = samples[i]
      const frac = (prev - threshold) / (prev - curr)
      edges.push(i - 1 + frac)
      lastEdge = i
    }
    above = now
  }
  return edges
}
