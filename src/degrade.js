// Composite-signal degradation helpers. Take a Float32Array signal,
// return a transformed Float32Array. Intended to feed the decoder
// between encode and decode so we can see how the pipeline copes with
// real-world imperfections.
//
// Current set: AWGN noise, low-pass (bandwidth limit). Ringing, phase
// jitter, and timing drift are planned for the next slice.

import { SAMPLE_RATE_HZ } from './signal.js'

/**
 * Add Gaussian white noise of the given RMS amplitude.
 *
 * @param {Float32Array} samples
 * @param {number} rms           noise RMS on our normalised scale
 *                               (0.01 ≈ faint, 0.1 ≈ very noisy)
 * @param {() => number} [rng]   RNG returning [0, 1). Defaults to
 *                               Math.random; deterministic tests pass
 *                               a seeded one.
 * @returns {Float32Array}
 */
export function addNoise(samples, rms, rng = Math.random) {
  if (rms <= 0) return samples
  const out = new Float32Array(samples.length)
  // Box-Muller: two uniforms → two independent gaussians.
  for (let i = 0; i < samples.length; i += 2) {
    const u1 = Math.max(rng(), 1e-12)
    const u2 = rng()
    const mag = rms * Math.sqrt(-2 * Math.log(u1))
    const a = mag * Math.cos(2 * Math.PI * u2)
    const b = mag * Math.sin(2 * Math.PI * u2)
    out[i] = samples[i] + a
    if (i + 1 < samples.length) out[i + 1] = samples[i + 1] + b
  }
  return out
}

/**
 * Zero-phase low-pass filter via Hann-windowed sinc FIR. Used to
 * simulate the finite bandwidth of an analogue transmission path or
 * a cheap composite encoder.
 *
 * For reference:
 *   Real PAL broadcast video: ~5 MHz composite, ~1.3 MHz chroma.
 *   VHS home recording:       ~3 MHz composite, ~0.4 MHz chroma.
 *   Early consumer CCD cams:  ~3 MHz composite.
 *
 * @param {Float32Array} samples
 * @param {number} cutoffHz        −3 dB point
 * @param {number} [taps]          FIR length (odd). Default scales with
 *                                 cutoff for a consistent transition
 *                                 width.
 * @param {number} [sampleRateHz]  defaults to our 4×Fsc signal rate
 * @returns {Float32Array}
 */
export function bandlimit(samples, cutoffHz, taps, sampleRateHz = SAMPLE_RATE_HZ) {
  if (!cutoffHz || cutoffHz >= sampleRateHz / 2) return samples
  // Pick a tap count that gives ~500 kHz transition width by default.
  if (taps == null) taps = Math.max(9, Math.round(sampleRateHz / 500_000) | 1)
  if ((taps & 1) === 0) taps += 1 // force odd for zero-phase symmetry

  const h = sincLowpassFir(cutoffHz, taps, sampleRateHz)
  return convolveSymmetric(samples, h)
}

// ---------- internals ----------

function sincLowpassFir(cutoffHz, N, sampleRateHz) {
  const fc = cutoffHz / sampleRateHz // normalised, cycles/sample
  const h = new Float64Array(N)
  const mid = (N - 1) / 2
  let sum = 0
  for (let i = 0; i < N; i++) {
    const n = i - mid
    const x = 2 * Math.PI * fc * n
    const sinc = n === 0 ? 2 * fc : Math.sin(x) / (Math.PI * n)
    // Hann window keeps sidelobes modest without needing a huge N.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
    h[i] = sinc * w
    sum += h[i]
  }
  // Normalise DC gain to 1.
  for (let i = 0; i < N; i++) h[i] /= sum
  return h
}

function convolveSymmetric(x, h) {
  const N = x.length
  const M = h.length
  const half = (M - 1) / 2
  const y = new Float32Array(N)
  for (let n = 0; n < N; n++) {
    let s = 0
    for (let k = 0; k < M; k++) {
      const idx = n + k - half
      // Edge extend rather than zero-pad so the edges don't fade to
      // black — close to what a real analogue filter does at signal
      // boundaries.
      const j = idx < 0 ? 0 : idx >= N ? N - 1 : idx
      s += h[k] * x[j]
    }
    y[n] = s
  }
  return y
}
