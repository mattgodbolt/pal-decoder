import test from 'node:test'
import assert from 'node:assert/strict'

import { findSyncEdges } from '../src/sync.js'
import { encodeFrame } from '../src/encoder.js'
import { LINES_PER_FRAME } from '../src/signal.js'
import { LINE_SAMPLES, SYNC_START } from '../src/timing.js'

const solid = (w, h, r, g, b) => {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

test('sync edges recovered from a clean encoded frame', () => {
  const w = 64, h = 64
  const { samples } = encodeFrame(solid(w, h, 0.5, 0.5, 0.5), w, h)
  const edges = findSyncEdges(samples)

  // Expect one edge per line.
  assert.equal(edges.length, LINES_PER_FRAME)

  // Each edge should land within a sub-sample of the expected position
  // (line base + SYNC_START).
  for (let line = 1; line <= LINES_PER_FRAME; line++) {
    const expected = (line - 1) * LINE_SAMPLES + SYNC_START
    const got = edges[line - 1]
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
