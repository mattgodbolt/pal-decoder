// One-shot convenience wrapper around the stateful PalDecoder. For
// long-running / streaming use (jsbeeb, Miracle, the <pal-decoder>
// element), instantiate PalDecoder directly and feed it frames.
//
// Re-exports buildLineMetadata so existing tests can still reach it.

import { PalDecoder, buildLineMetadata } from './pal-decoder.js'

export { buildLineMetadata }

/**
 * Decode a PAL frame from a composite-sample buffer. Creates a fresh
 * PalDecoder, runs it through (framesToSettle + 1) frames so the
 * horizontal PLL has settled that many frames in before we observe,
 * and returns the last frame's RGB output.
 *
 * For a proper long-lived decoder keep a PalDecoder instance around
 * and call decodeFrame() each time new samples are available.
 *
 * @param {Float32Array} samples
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {'notch'|'pald'|'comb'} [opts.mode]
 * @param {number} [opts.startSample]      skip the first N samples
 * @param {number} [opts.framesToSettle]   run PLL this many extra
 *        frames before observing (same state carries forward; state
 *        after N frames is state N frames into the simulated TV's life)
 */
export function decodeComposite(samples, width, height, opts = {}) {
  const mode = opts.mode ?? 'pald'
  const startSample = Math.max(0, Math.floor(opts.startSample ?? 0))
  const framesToSettle = Math.max(0, Math.floor(opts.framesToSettle ?? 0))
  const input = startSample > 0 ? samples.subarray(startSample) : samples

  const dec = new PalDecoder({ mode, width, height })
  let rgb
  for (let f = 0; f <= framesToSettle; f++) {
    rgb = dec.decodeFrame(input)
  }
  return rgb
}
