// Vertical sync (field-start) detection for both fields.
//
// Real PAL: field 1 broad block starts on the integer line grid;
// field 2 broad block is half a line offset (FIELD_2_START =
// 312·LS + HALF_LINE_SAMPLES). Broad groups are one field-period
// apart, and both fields have the same internal broad-pulse pattern,
// so spacing alone can't tell them apart.
//
// We anchor each field's PLL from the first narrow sync after its
// broad-pulse group. Convention: the first broad-pulse group seen
// in the signal is field 1. On a stream that starts at a proper
// frame boundary this is correct. Signals that start mid-frame
// (arbitrary capture cut-ins) may paint odd lines where even were
// expected and vice versa — the same ambiguity a real TV has when
// you yank its aerial and re-connect it partway through a frame.

import { broadSyncPulses, findSyncEdges } from './sync.js'
import { LINE_SAMPLES } from './timing.js'

/**
 * Locate per-field PLL anchor points: the sample position of the
 * first narrow horizontal sync immediately following each field's
 * broad-pulse group.
 *
 * @param {Float32Array} samples
 * @returns {{ field1FirstNarrow: number, field2FirstNarrow: number } | null}
 */
export function findFieldAnchors(samples) {
  const broads = broadSyncPulses(samples)
  if (broads.length === 0) return null
  const narrows = findSyncEdges(samples)
  if (narrows.length === 0) return null

  const groups = groupBroadPulses(broads)
  if (groups.length < 2) return null // need both fields' broad groups

  const f1 = firstNarrowAfter(narrows, groups[0])
  const f2 = firstNarrowAfter(narrows, groups[1])
  if (f1 === null || f2 === null) return null
  return { field1FirstNarrow: f1, field2FirstNarrow: f2 }
}

/**
 * Back-compat: returns just the field-1 anchor expressed as "line 1's
 * sync edge sample position", obtained by walking five lines back
 * from the first post-broad narrow sync.
 */
export function findFieldOneSample(samples) {
  const a = findFieldAnchors(samples)
  if (!a) return null
  return a.field1FirstNarrow - 5 * LINE_SAMPLES
}

/** Back-compat alias used by tests. */
export function findLineOneSample(samples) {
  return findFieldOneSample(samples)
}

function firstNarrowAfter(narrows, group) {
  const groupEnd = group[group.length - 1].position
  const minOffset = LINE_SAMPLES / 2
  const found = narrows.find((e) => e > groupEnd + minOffset)
  return found ?? null
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
