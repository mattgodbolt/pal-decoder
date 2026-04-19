// Vertical sync (field-start) detection.
//
// PAL's broad-pulse sequence is identical between field 1 and field 2,
// so one group can't tell you which you've found. Three groups can:
// the spacing between consecutive groups alternates — 312 lines from
// field 1 to field 2, 313 lines from field 2 back to field 1 of the
// next frame. The field-1 group is the one whose outgoing spacing is
// *shorter* than the following group's.
//
// Once we know which group is field 1, we anchor line 1 using the
// first narrow-sync edge *after* that group. For 625/50 PAL that's
// line 6's horizontal sync (the first five lines carry broad pulses
// only). Line 6's edge sits at frame_start + 5·LINE_SAMPLES +
// SYNC_START - 0.5, so line 1 = that edge − 5·LINE_SAMPLES − SYNC_START
// + 0.5. This avoids any assumptions about slice-coordinate alignment.
//
// With fewer than 3 broad-pulse groups we fall back to "first group is
// field 1" — correct when the signal starts at the beginning of a
// frame, may be off by a field when starting mid-stream.

import { broadSyncPulses, findSyncEdges } from './sync.js'
import { LINE_SAMPLES, SYNC_START } from './timing.js'

/**
 * Find the sample index of line 1 of field 1.
 *
 * @param {Float32Array} samples
 * @returns {number|null}
 */
export function findFieldOneSample(samples) {
  const broads = broadSyncPulses(samples)
  if (broads.length === 0) return null
  const narrows = findSyncEdges(samples)
  if (narrows.length === 0) return null

  const groups = groupBroadPulses(broads)

  // Pick the field-1 group.
  let fieldOneGroup = groups[0]
  if (groups.length >= 3) {
    const spacings = []
    for (let i = 1; i < groups.length; i++) {
      spacings.push(groups[i][0].position - groups[i - 1][0].position)
    }
    for (let i = 0; i < spacings.length - 1; i++) {
      if (spacings[i] < spacings[i + 1]) {
        fieldOneGroup = groups[i]
        break
      }
    }
  }

  // Anchor via the first narrow-sync edge after the group ends. That's
  // line 6 of the 625-line frame.
  const groupEnd = fieldOneGroup[fieldOneGroup.length - 1].position
  const nextNarrow = narrows.find((e) => e > groupEnd + LINE_SAMPLES / 2)
  if (nextNarrow === undefined) return null

  // Walk back five lines and subtract the sync-offset to get line 1's
  // sample position.
  return nextNarrow - 5 * LINE_SAMPLES - SYNC_START + 0.5
}

/**
 * Back-compat: the simple "first broad-pulse group" detection that we
 * used originally. Kept for tests and as a fallback.
 */
export function findLineOneSample(samples) {
  const broads = broadSyncPulses(samples)
  if (broads.length === 0) return null
  const first = broads[0].position
  const phase = mod(first, LINE_SAMPLES)
  const quarter = LINE_SAMPLES / 4
  if (phase < quarter || phase > LINE_SAMPLES - quarter) {
    return first - phase + (phase > LINE_SAMPLES / 2 ? LINE_SAMPLES : 0)
  }
  return first - LINE_SAMPLES / 2
}

function groupBroadPulses(broads) {
  const groups = []
  let current = [broads[0]]
  for (let i = 1; i < broads.length; i++) {
    if (broads[i].position - broads[i - 1].position < 2 * LINE_SAMPLES) {
      current.push(broads[i])
    } else {
      groups.push(current)
      current = [broads[i]]
    }
  }
  groups.push(current)
  return groups
}

function mod(a, b) {
  const r = a % b
  return r < 0 ? r + b : r
}
