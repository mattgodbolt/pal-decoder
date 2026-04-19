import test from 'node:test'
import assert from 'node:assert/strict'

import { findSyncEdges } from '../src/sync.js'
import { encodeFrame } from '../src/encoder.js'
import { LINES_PER_FRAME } from '../src/signal.js'
import { LINE_SAMPLES, SYNC_START, lineToSample, isBroadPulseLine } from '../src/timing.js'

const solid = (w, h, r, g, b) => {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

test('narrow sync edges cover all non-VBI lines', () => {
  const w = 64, h = 64
  const { samples } = encodeFrame(solid(w, h, 0.5, 0.5, 0.5), w, h)
  const edges = findSyncEdges(samples)

  // 624 usable lines minus 10 broad-pulse lines (1–5, 313–317) = 614
  // narrow sync edges. Line 625 isn't written.
  assert.equal(edges.length, 614)

  // Each edge lands at lineToSample(N) + SYNC_START (- 0.5 for the
  // interp offset); use lineToSample so field 2's half-line offset is
  // accounted for.
  let idx = 0
  for (let line = 1; line <= 624; line++) {
    if (isBroadPulseLine(line)) continue
    const expected = lineToSample(line) + SYNC_START
    const got = edges[idx++]
    assert.ok(Math.abs(got - expected) < 1.0,
      `line ${line}: edge ${got}, expected ${expected}`)
  }
})

test('sub-sample interpolation places edges near the threshold crossing', () => {
  // The signal transitions from blanking (0) to sync tip (-0.3) in a single
  // sample step in our idealised encoder, so the interpolated crossing
  // should land half a sample before the first below-threshold sample.
  const { samples } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  const edges = findSyncEdges(samples)
  for (const e of edges) {
    // Fractional part should be close to 0.5 (threshold midway between
    // 0 and -0.3 means interpolation fraction = 0.5).
    const frac = e - Math.floor(e)
    assert.ok(Math.abs(frac - 0.5) < 0.01, `frac ${frac}`)
  }
})
