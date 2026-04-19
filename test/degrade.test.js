import test from 'node:test'
import assert from 'node:assert/strict'

import { addNoise, bandlimit, addRinging, addPhaseJitter, addTimingDrift } from '../src/degrade.js'
import { SAMPLE_RATE_HZ } from '../src/signal.js'

// Seeded deterministic PRNG.
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

test('addNoise RMS matches requested amplitude (±10%)', () => {
  const N = 100_000
  const x = new Float32Array(N) // zero signal
  const rms = 0.05
  const y = addNoise(x, rms, mulberry32(1))
  let sumSq = 0
  for (let i = 0; i < N; i++) sumSq += y[i] * y[i]
  const actualRms = Math.sqrt(sumSq / N)
  assert.ok(Math.abs(actualRms - rms) / rms < 0.1,
    `actual RMS ${actualRms.toFixed(4)} vs target ${rms}`)
})

test('addNoise preserves signal mean (within 1 sigma / sqrt(N))', () => {
  const N = 50_000
  const x = new Float32Array(N).fill(0.5)
  const rms = 0.02
  const y = addNoise(x, rms, mulberry32(7))
  let mean = 0
  for (let i = 0; i < N; i++) mean += y[i]
  mean /= N
  const expectedSem = rms / Math.sqrt(N)
  assert.ok(Math.abs(mean - 0.5) < 5 * expectedSem,
    `mean ${mean} vs 0.5 (SEM ≈ ${expectedSem})`)
})

test('bandlimit passes a DC signal unchanged', () => {
  const x = new Float32Array(1000).fill(0.3)
  const y = bandlimit(x, 1e6)
  // Ignore first/last (edge effects from extension).
  for (let i = 50; i < 950; i++) {
    assert.ok(Math.abs(y[i] - 0.3) < 1e-4, `i=${i}: ${y[i]}`)
  }
})

test('bandlimit strongly attenuates a frequency above the cutoff', () => {
  const N = 4000
  const fIn = 5e6 // 5 MHz sine
  const cutoff = 1e6
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * fIn * i / SAMPLE_RATE_HZ)
  const y = bandlimit(x, cutoff)

  const rms = (arr, from = 200, to = arr.length - 200) => {
    let s = 0, n = 0
    for (let i = from; i < to; i++) { s += arr[i] * arr[i]; n++ }
    return Math.sqrt(s / n)
  }
  const inRms  = rms(x)
  const outRms = rms(y)
  // Expect at least 20 dB attenuation 5× above cutoff.
  assert.ok(outRms < inRms * 0.1,
    `5 MHz through a 1 MHz LPF: in RMS ${inRms.toFixed(3)}, out RMS ${outRms.toFixed(3)}`)
})

test('bandlimit preserves phase of in-band signal (zero-phase FIR)', () => {
  const N = 4000
  const fIn = 200e3 // well below 1 MHz cutoff
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.cos(2 * Math.PI * fIn * i / SAMPLE_RATE_HZ)
  const y = bandlimit(x, 1e6)
  // Zero-phase FIR → peaks line up; compare a few samples well away
  // from the edges.
  for (let i = 500; i < 3500; i += 137) {
    assert.ok(Math.abs(y[i] - x[i]) < 0.02,
      `i=${i}: x=${x[i].toFixed(3)} y=${y[i].toFixed(3)}`)
  }
})

test('addRinging amplifies a sine at the resonance frequency', () => {
  const N = 4000
  const fRing = 4e6
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * fRing * i / SAMPLE_RATE_HZ)
  const y = addRinging(x, fRing, 3, 6)
  const rms = (arr) => {
    let s = 0
    for (let i = 500; i < arr.length - 500; i++) s += arr[i] * arr[i]
    return Math.sqrt(s / (arr.length - 1000))
  }
  assert.ok(rms(y) > rms(x) * 1.3,
    `at resonance in=${rms(x).toFixed(3)} out=${rms(y).toFixed(3)}`)
})

test('addRinging leaves DC untouched', () => {
  const x = new Float32Array(1000).fill(0.4)
  const y = addRinging(x, 4e6, 1.5, 6)
  for (let i = 100; i < 900; i++) {
    assert.ok(Math.abs(y[i] - 0.4) < 1e-3, `i=${i} y=${y[i]}`)
  }
})

test('addTimingDrift leaves a DC signal unchanged (resampled DC is DC)', () => {
  const x = new Float32Array(5000).fill(0.4)
  const y = addTimingDrift(x, 3)
  for (let i = 50; i < 4950; i++) {
    assert.ok(Math.abs(y[i] - 0.4) < 1e-4, `i=${i} ${y[i]}`)
  }
})

test('addTimingDrift shifts a high-frequency sinusoid visibly', () => {
  // Use a wobble frequency high enough for the sinusoid to actually
  // traverse a visible fraction of a wobble cycle within N samples.
  // (At the demo default of 2 Hz the wobble period is ~8.85 M samples;
  // over 20 k samples that's barely motion. Cranking to 500 Hz gives
  // meaningful motion within a reasonable test-signal length.)
  const N = 20000
  const fIn = 4e6
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * fIn * i / SAMPLE_RATE_HZ)
  const y = addTimingDrift(x, 2, 500)
  let maxAbsDelta = 0
  for (let i = 100; i < N - 100; i++) {
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(y[i] - x[i]))
  }
  assert.ok(maxAbsDelta > 1.0, `expected noticeable displacement, got ${maxAbsDelta.toFixed(3)}`)
})

test('addPhaseJitter preserves signal statistics but adds variance at detail', () => {
  const rng = (() => {
    let s = 123
    return () => {
      s = (s + 0x6D2B79F5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
    }
  })()
  // Sinusoid: per-sample value shifts slightly, variance from the
  // original should be non-zero and scale with jitter RMS.
  const N = 4000
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 2e6 * i / SAMPLE_RATE_HZ)
  const y = addPhaseJitter(x, 0.3, rng)
  let sumSq = 0
  for (let i = 50; i < N - 50; i++) { const d = x[i] - y[i]; sumSq += d*d }
  assert.ok(sumSq / N > 0.001, `expected detectable jitter noise, got MSE ${(sumSq/N).toFixed(6)}`)
  // But no DC bias.
  let mean = 0
  for (let i = 50; i < N - 50; i++) mean += y[i]
  mean /= (N - 100)
  assert.ok(Math.abs(mean) < 0.05, `mean drift ${mean}`)
})
