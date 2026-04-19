import test from 'node:test'
import assert from 'node:assert/strict'

import { HorizontalPLL, acquirePLL, trackLines } from '../src/pll.js'
import { findSyncEdges } from '../src/sync.js'
import { encodeFrame } from '../src/encoder.js'
import { LINES_PER_FRAME } from '../src/signal.js'
import { LINE_SAMPLES, SYNC_START } from '../src/timing.js'

const solid = (w, h, r, g, b) => {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

// Generate perfectly clean edges at n*period + phase.
function cleanEdges(n, period, phase = 0) {
  const out = []
  for (let i = 0; i < n; i++) out.push(phase + i * period)
  return out
}

test('PLL on a clean encoded signal matches raw edges within sub-sample', () => {
  const { samples } = encodeFrame(solid(4, 4, 0.5, 0.5, 0.5), 4, 4)
  const edges = findSyncEdges(samples)
  const tracked = trackLines(edges, LINES_PER_FRAME)
  for (let i = 0; i < LINES_PER_FRAME; i++) {
    assert.ok(tracked[i].locked || i < 4, `line ${i} should lock quickly`)
    assert.ok(Math.abs(tracked[i].position - edges[i]) < 1.0)
  }
})

test('PLL tracks a 0.1 percent line-rate drift', () => {
  // Generate edges whose spacing grows linearly by a small fraction per
  // line: the acceptance target is "tracks ±0.1% line-rate drift".
  const period0 = LINE_SAMPLES
  const drift = 1e-3 / LINES_PER_FRAME // total 0.1% across a frame
  const edges = []
  let t = 0
  for (let i = 0; i < LINES_PER_FRAME; i++) {
    edges.push(t)
    t += period0 * (1 + i * drift)
  }
  const tracked = trackLines(edges, LINES_PER_FRAME)

  // Once locked, the PLL's position error vs truth should stay small.
  let maxErr = 0
  for (let i = 50; i < LINES_PER_FRAME; i++) {
    const err = Math.abs(tracked[i].position - edges[i])
    if (err > maxErr) maxErr = err
  }
  assert.ok(maxErr < 1.0, `max drift tracking error ${maxErr.toFixed(3)} samples`)
})

test('PLL recovers within 10 lines of a missing sync edge', () => {
  const period = LINE_SAMPLES
  const edges = cleanEdges(LINES_PER_FRAME, period)
  // Remove one edge midway. trackLines will see a 2-period gap.
  const dropIdx = 300
  const dropped = [...edges.slice(0, dropIdx), ...edges.slice(dropIdx + 1)]

  const tracked = trackLines(dropped, LINES_PER_FRAME)

  // The dropped line should free-run (position ≈ true edge within ~1 sample).
  const dropErr = Math.abs(tracked[dropIdx].position - edges[dropIdx])
  assert.ok(dropErr < 1.5, `dropped-line error ${dropErr}`)

  // After at most 10 subsequent lines, position error should be back to
  // sub-sample.
  let recovered = false
  for (let k = 1; k <= 10; k++) {
    if (Math.abs(tracked[dropIdx + k].position - edges[dropIdx + k]) < 0.5) {
      recovered = true
      break
    }
  }
  assert.ok(recovered, 'PLL should recover within 10 lines of a glitch')
})

test('PLL filters sub-sample jitter', () => {
  const period = LINE_SAMPLES
  const clean = cleanEdges(LINES_PER_FRAME, period)
  // Deterministic jitter: ±0.4 sample peaks, uncorrelated between lines.
  const rng = mulberry32(42)
  const noisy = clean.map((e) => e + (rng() - 0.5) * 0.8)

  const tracked = trackLines(noisy, LINES_PER_FRAME)

  // Compare input RMS jitter vs output RMS jitter after lock.
  const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length)
  const inJit  = clean.slice(50).map((e, i) => noisy[50 + i] - e)
  const outJit = clean.slice(50).map((e, i) => tracked[50 + i].position - e)
  assert.ok(rms(outJit) < rms(inJit) * 0.75,
    `out RMS ${rms(outJit).toFixed(3)} vs in RMS ${rms(inJit).toFixed(3)}`)
})

test('acquirePLL initial period = median edge spacing', () => {
  const edges = cleanEdges(20, 1135, 100)
  const pll = acquirePLL(edges)
  assert.ok(Math.abs(pll.period - 1135) < 1e-9)
  assert.ok(Math.abs(pll.predicted - 100) < 1e-9)
})

// Small deterministic PRNG so the jitter test is reproducible.
function mulberry32(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}
