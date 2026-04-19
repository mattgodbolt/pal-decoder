import test from 'node:test'
import assert from 'node:assert/strict'

import { measureBurst } from '../src/burst.js'
import { encodeFrame, BURST_PEAK } from '../src/encoder.js'
import { LINE_SAMPLES, BURST_START, BURST_END, ACTIVE_FIRST_LINE } from '../src/timing.js'

const solid = (w, h, r, g, b) => {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

test('burst amplitude matches BURST_PEAK on active lines', () => {
  const { samples } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  for (const line of [ACTIVE_FIRST_LINE, ACTIVE_FIRST_LINE + 1, 400, 500]) {
    const lineStart = (line - 1) * LINE_SAMPLES
    const { amplitude } = measureBurst(samples, lineStart, BURST_START, BURST_END)
    assert.ok(Math.abs(amplitude - BURST_PEAK) < 1e-6,
      `line ${line}: amplitude ${amplitude}`)
  }
})

test('burst vSign alternates per line and has ±135° phase', () => {
  const { samples, lines } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  for (const line of [ACTIVE_FIRST_LINE, ACTIVE_FIRST_LINE + 1,
                      ACTIVE_FIRST_LINE + 2, ACTIVE_FIRST_LINE + 3]) {
    const lineStart = (line - 1) * LINE_SAMPLES
    const m = measureBurst(samples, lineStart, BURST_START, BURST_END)
    assert.equal(m.vSign, lines[line].vSign, `line ${line} vSign`)

    // Phase should be ±135° = ±3π/4.
    const expected = m.vSign === +1 ? +3 * Math.PI / 4 : -3 * Math.PI / 4
    assert.ok(Math.abs(m.phase - expected) < 0.01,
      `line ${line} phase ${m.phase} vs ${expected}`)
  }
})

test('burst is absent outside the active region', () => {
  // Line 5 is in vertical blanking — our encoder leaves it at blanking
  // level (no burst written). Amplitude should be ~0.
  const { samples } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  const lineStart = (5 - 1) * LINE_SAMPLES
  const { amplitude } = measureBurst(samples, lineStart, BURST_START, BURST_END)
  assert.ok(amplitude < 1e-6, `VBI amplitude ${amplitude}`)
})
