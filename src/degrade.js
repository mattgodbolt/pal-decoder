// Composite-signal degradation helpers. Take a Float32Array signal,
// return a transformed Float32Array. Intended to feed the decoder
// between encode and decode so we can see how the pipeline copes with
// real-world imperfections.
//
// Set: AWGN noise, band-limit, ringing, phase jitter, timing drift.

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

/**
 * Add ringing / overshoot around sharp transitions. Simulates an
 * under-damped IIR low-pass response — the "coffee-cup ring" you'd get
 * from a video amplifier whose passband edge has been pushed just
 * above Nyquist by a cheap compensation network. A Q of ~1 gives mild
 * overshoot with a couple of cycles of ring; higher Q gives wilder
 * rings.
 *
 * Implemented as a 2nd-order biquad peaking filter centred at
 * `ringFreq` with gain `gainDb`, applied forward then reversed for
 * zero phase shift (so sharp edges bloom symmetrically rather than
 * trailing to one side).
 *
 * @param {Float32Array} samples
 * @param {number} ringFreq      resonance centre (Hz)
 * @param {number} [q]           quality factor (default 1.5)
 * @param {number} [gainDb]      peak gain at resonance (default 4 dB)
 * @param {number} [sampleRateHz] defaults to 4×Fsc
 */
export function addRinging(samples, ringFreq, q = 1.5, gainDb = 4, sampleRateHz = SAMPLE_RATE_HZ) {
  if (!ringFreq || gainDb === 0) return samples
  const A = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * ringFreq / sampleRateHz
  const alpha = Math.sin(w0) / (2 * q)
  const cosW = Math.cos(w0)
  const b0 = 1 + alpha * A
  const b1 = -2 * cosW
  const b2 = 1 - alpha * A
  const a0 = 1 + alpha / A
  const a1 = -2 * cosW
  const a2 = 1 - alpha / A
  const B = [b0 / a0, b1 / a0, b2 / a0]
  const A_ = [1,        a1 / a0, a2 / a0]

  // Forward + reverse filtfilt for zero-phase ringing around the
  // transition rather than lagging after it.
  const fwd = biquad(samples, B, A_)
  const rev = reverse(fwd)
  const back = biquad(rev, B, A_)
  return reverse(back)
}

function biquad(x, B, A) {
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let n = 0; n < x.length; n++) {
    const v = B[0] * x[n] + B[1] * x1 + B[2] * x2 - A[1] * y1 - A[2] * y2
    x2 = x1; x1 = x[n]
    y2 = y1; y1 = v
    y[n] = v
  }
  return y
}

function reverse(x) {
  const y = new Float32Array(x.length)
  for (let i = 0, j = x.length - 1; i < x.length; i++, j--) y[i] = x[j]
  return y
}

/**
 * Add phase jitter: perturb each sample's effective time position by
 * a small random amount and resample via linear interpolation. Models
 * sub-sample clock noise in a cheap sync separator or capture setup,
 * which shows up as chroma-phase twinkle (colour that flickers at fine
 * detail, worst at saturated hues).
 *
 * @param {Float32Array} samples
 * @param {number} rmsSamples    RMS jitter amplitude in samples
 *                               (0.05 ≈ faint; 0.5 ≈ severe)
 * @param {() => number} [rng]
 * @returns {Float32Array}
 */
export function addPhaseJitter(samples, rmsSamples, rng = Math.random) {
  if (rmsSamples <= 0) return samples
  const N = samples.length
  const out = new Float32Array(N)
  // Per-sample gaussian offset, then resample from the original via
  // linear interpolation at (i + offset).
  for (let i = 0; i < N; i += 2) {
    const u1 = Math.max(rng(), 1e-12)
    const u2 = rng()
    const mag = rmsSamples * Math.sqrt(-2 * Math.log(u1))
    const g0 = mag * Math.cos(2 * Math.PI * u2)
    const g1 = mag * Math.sin(2 * Math.PI * u2)
    out[i] = interp(samples, i + g0)
    if (i + 1 < N) out[i + 1] = interp(samples, i + 1 + g1)
  }
  return out
}

function interp(samples, x) {
  if (x <= 0) return samples[0]
  if (x >= samples.length - 1) return samples[samples.length - 1]
  const i = Math.floor(x)
  const f = x - i
  return (1 - f) * samples[i] + f * samples[i + 1]
}

/**
 * Add slow sinusoidal timing drift. Models a TBC or capstan wobble:
 * the sample grid is effectively "breathing" at a low frequency, with
 * peak displacement of `peakSamples` samples. The horizontal PLL
 * should track this smoothly (no rolling), but line-to-line phase
 * alignment wobbles if the drift is fast enough compared to the loop
 * bandwidth — visible as chroma colour shift on coloured regions.
 *
 * @param {Float32Array} samples
 * @param {number} peakSamples       peak displacement (samples; 1 ≈ mild)
 * @param {number} [wobbleHz]        drift frequency (default 2 Hz)
 * @param {number} [sampleRateHz]
 */
export function addTimingDrift(samples, peakSamples, wobbleHz = 2, sampleRateHz = SAMPLE_RATE_HZ) {
  if (peakSamples <= 0) return samples
  const N = samples.length
  const out = new Float32Array(N)
  const phaseStep = 2 * Math.PI * wobbleHz / sampleRateHz
  for (let i = 0; i < N; i++) {
    const offset = peakSamples * Math.sin(phaseStep * i)
    out[i] = interp(samples, i + offset)
  }
  return out
}
