import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame, BURST_PEAK } from '../src/encoder.js'
import {
  LINE_SAMPLES, SYNC_START, SYNC_END, BURST_START, BURST_END,
  ACTIVE_START, ACTIVE_END, ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT,
  lineToSample, isBroadPulseLine,
} from '../src/timing.js'
import { LINES_PER_FRAME } from '../src/signal.js'
import {
  LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_BLACK, LEVEL_WHITE,
} from '../src/signal.js'
import { U_MAX, V_MAX } from '../src/colorspace.js'

const solid = (w, h, r, g, b) => {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

test('output has correct size', () => {
  const { samples } = encodeFrame(solid(10, 10, 0, 0, 0), 10, 10)
  assert.equal(samples.length, LINES_PER_FRAME * LINE_SAMPLES)
})

test('every non-broad-pulse line carries a narrow horizontal sync', () => {
  const { samples } = encodeFrame(solid(10, 10, 0.5, 0.5, 0.5), 10, 10)
  // Real PAL: broad-pulse lines (1–5, 313–317) carry field-sync broad
  // pulses at HALF_LINE_SAMPLES intervals rather than a per-line narrow
  // sync. All other lines 1..624 get a normal 4.7 µs sync at line start.
  for (let line = 1; line <= 624; line++) {
    if (isBroadPulseLine(line)) continue
    const base = lineToSample(line)
    for (let i = SYNC_START; i < SYNC_END; i++) {
      assert.ok(Math.abs(samples[base + i] - LEVEL_SYNC_TIP) < 1e-6,
        `line ${line} sample ${i} = ${samples[base + i]}`)
    }
  }
})

test('flat grey input: active video sits at the luma level with no chroma', () => {
  const grey = 0.5
  const w = 100, h = ACTIVE_LINE_COUNT // fill the active region
  const { samples, lines } = encodeFrame(solid(w, h, grey, grey, grey), w, h)
  const expected = LEVEL_BLACK + (LEVEL_WHITE - LEVEL_BLACK) * grey
  const midLine = ACTIVE_FIRST_LINE + Math.floor(h / 2)
  const meta = lines[midLine]
  assert.ok(meta, 'metadata present')
  for (let i = 10; i < meta.length - 10; i++) {
    const got = samples[meta.activeStart + i]
    assert.ok(Math.abs(got - expected) < 1e-6,
      `grey should give luma-only; got ${got} expected ${expected}`)
  }
})

test('burst is present with expected sampled amplitude', () => {
  const { samples } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  const line = ACTIVE_FIRST_LINE + 50
  const base = (line - 1) * LINE_SAMPLES
  let peak = 0
  for (let i = BURST_START; i < BURST_END; i++) {
    peak = Math.max(peak, Math.abs(samples[base + i]))
  }
  // The continuous burst has peak amplitude BURST_PEAK, but sampled at
  // 4×Fsc from phase 0 we land on the ±135° waveform at phases 0, π/2,
  // π, 3π/2 relative to reset — so sampled peak = BURST_PEAK / √2.
  const expected = BURST_PEAK * Math.SQRT1_2
  assert.ok(Math.abs(peak - expected) < 1e-6, `burst peak ${peak} vs ${expected}`)
})

test('PAL V-sign alternates between adjacent active lines', () => {
  const { lines } = encodeFrame(solid(4, 4, 0, 0, 0), 4, 4)
  let seenPlus = false, seenMinus = false
  let prev = null
  for (let L = ACTIVE_FIRST_LINE; L <= ACTIVE_FIRST_LINE + 4; L++) {
    const m = lines[L]
    assert.ok(m)
    if (m.vSign === +1) seenPlus = true
    if (m.vSign === -1) seenMinus = true
    if (prev !== null) assert.notEqual(m.vSign, prev, `line ${L} should flip`)
    prev = m.vSign
  }
  assert.ok(seenPlus && seenMinus)
})

test('pure blue pixel: chroma deviation around luma matches expected envelope', () => {
  // Blue => Y ≈ 0.114, U = +U_MAX, V = 0.877·(0-0.114) ≈ -0.1.
  // On a +V line: s = Y_ire + U·sin(ωt) + V·cos(ωt).
  // Sampled values at phases [0, π/2, π, 3π/2] → deviations from Y_ire:
  //   [+V, +U, -V, -U].
  const w = 4, h = ACTIVE_LINE_COUNT
  const { samples, lines } = encodeFrame(solid(w, h, 0, 0, 1), w, h)
  const yLum = LEVEL_BLACK + (LEVEL_WHITE - LEVEL_BLACK) * 0.114

  let meta = null
  for (let L = ACTIVE_FIRST_LINE + 100; L < ACTIVE_FIRST_LINE + 110; L++) {
    if (lines[L] && lines[L].vSign === +1) { meta = lines[L]; break }
  }
  assert.ok(meta)
  let peakPos = 0, peakNeg = 0
  for (let i = 20; i < meta.length - 20; i++) {
    const d = samples[meta.activeStart + i] - yLum
    if (d > peakPos) peakPos = d
    if (d < peakNeg) peakNeg = d
  }
  // Positive deviations come from U_MAX samples; negative from -U_MAX.
  assert.ok(Math.abs(peakPos - U_MAX) < 0.01, `+peak ${peakPos} vs U_MAX ${U_MAX}`)
  assert.ok(Math.abs(peakNeg + U_MAX) < 0.01, `-peak ${peakNeg} vs -U_MAX ${-U_MAX}`)
})
