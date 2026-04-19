import test from 'node:test'
import assert from 'node:assert/strict'

import { measureBurst } from '../src/burst.js'
import { encodeFrame, BURST_PEAK } from '../src/encoder.js'
import {
  LINE_SAMPLES, BURST_START, BURST_END, ACTIVE_FIRST_LINE, ACTIVE_LAST_LINE,
} from '../src/timing.js'

const solid = (w, h, r, g, b) => {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

test('burst amplitude matches BURST_PEAK on active lines', () => {
  const { samples } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  for (const line of [ACTIVE_FIRST_LINE, ACTIVE_FIRST_LINE + 1, 100, 200]) {
    const lineStart = (line - 1) * LINE_SAMPLES
    const { amplitude } = measureBurst(samples, lineStart, BURST_START, BURST_END)
    assert.ok(Math.abs(amplitude - BURST_PEAK) < 1e-6,
      `line ${line}: amplitude ${amplitude}`)
  }
})

test('burst phase rotates with continuous subcarrier across lines', () => {
  // With continuous subcarrier, the burst vector in the absolute-sample
  // basis rotates by (LINE_SAMPLES mod 4) · π/2 = 3π/2 = -π/2 per line.
  // On a +V line: burst at line-1 absolute basis = +135° + α_line.
  // On successive +V lines (2 apart) α advances by -π, so the burst
  // measurement swings by 180° every two lines. The interleaved σ
  // toggles contribute another 180°, so neighbouring-line measurements
  // differ by 0° or 180° (not ±90° like in a reset-per-line encoder).
  const { samples, lines } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  const phases = []
  for (let L = ACTIVE_FIRST_LINE; L < ACTIVE_FIRST_LINE + 8; L++) {
    const lineStart = (L - 1) * LINE_SAMPLES
    const m = measureBurst(samples, lineStart, BURST_START, BURST_END)
    phases.push(m.phase)
    assert.ok(Math.abs(m.amplitude - BURST_PEAK) < 1e-6)
  }
  // Verify inter-line diffs form only two discrete values, 180° apart.
  const diffs = []
  for (let i = 1; i < phases.length; i++) diffs.push(wrap(phases[i] - phases[i - 1]))
  // Cluster into two buckets.
  const c1 = diffs[0]
  for (const d of diffs) {
    const delta = Math.abs(wrap(d - c1))
    assert.ok(delta < 0.05 || Math.abs(delta - Math.PI) < 0.05,
      `diff ${d} not in {c, c+π}`)
  }
})

test('burst is absent on broad-pulse (field-sync) lines', () => {
  const { samples } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  const lineStart = (3 - 1) * LINE_SAMPLES
  const { amplitude } = measureBurst(samples, lineStart, BURST_START, BURST_END)
  assert.ok(amplitude < 1e-6, `VBI amplitude ${amplitude}`)
})

function wrap(r) {
  while (r >  Math.PI) r -= 2 * Math.PI
  while (r < -Math.PI) r += 2 * Math.PI
  return r
}
