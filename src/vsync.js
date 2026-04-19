// Vertical sync (field-start) detection. PAL's 625/50 signal carries
// five ~half-line-wide "broad pulses" on lines 1–5 (start of field 1)
// and 313–317 (start of field 2). They're the unambiguous markers that
// say "this is line 1". Our horizontal PLL doesn't see them (it's fed
// narrow-sync-only edges), so we detect broad pulses separately and
// compute where line 1 falls in the sample stream.

import { broadSyncPulses } from './sync.js'
import { LINE_SAMPLES } from './timing.js'

/**
 * Find the sample index of line 1 of field 1 in the signal. Returns
 * null if no broad-pulse group is found (no field sync available).
 *
 * Approach: broad pulses come in pairs on each VBI line — one starting
 * at the line edge, one at the midline. The first one we reliably
 * detect is the midline broad pulse of line 1 (the line-edge one is
 * missed when capture begins below threshold). Working backwards, line
 * 1 starts at `firstPulse - LINE_SAMPLES/2`, rounded to the nearest
 * sample.
 *
 * If the first detected pulse falls close to a line edge (within a
 * quarter-line of the nearest multiple of LINE_SAMPLES), we assume it
 * IS the line-edge pulse and use its position directly.
 *
 * @param {Float32Array} samples
 * @returns {number|null}  sample index of line 1 start, or null
 */
export function findLineOneSample(samples) {
  const broads = broadSyncPulses(samples)
  if (broads.length === 0) return null

  const first = broads[0].position
  const phase = mod(first, LINE_SAMPLES)
  const quarter = LINE_SAMPLES / 4
  if (phase < quarter || phase > LINE_SAMPLES - quarter) {
    // Near a line edge — treat as line-edge broad pulse.
    return first - phase + (phase > LINE_SAMPLES / 2 ? LINE_SAMPLES : 0)
  }
  // Mid-line broad pulse; line 1 starts half a line earlier.
  return first - LINE_SAMPLES / 2
}

function mod(a, b) {
  const r = a % b
  return r < 0 ? r + b : r
}
