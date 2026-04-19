// Stateful-decoder sanity: PLL state persists across decodeFrame calls,
// and a stable signal produces a stable decode from frame 2 onwards.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame, progressive } from '../src/encoder.js'
import { colourBars75 } from '../src/fixtures/bars.js'
import { PalDecoder } from '../src/pal-decoder.js'

test('PLL state survives across decodeFrame calls (identical output on a steady signal)', () => {
  const w = 128, h = 128
  // Two frames of the same signal glued end-to-end.
  const src = progressive(colourBars75(w, h), w, h)
  const { samples: one } = encodeFrame(src, w, h * 2)
  const doubled = new Float32Array(one.length * 2)
  doubled.set(one, 0)
  doubled.set(one, one.length)

  const dec = new PalDecoder({ mode: 'pald', width: w, height: h * 2 })
  const f1 = dec.decodeFrame(doubled)
  // PLL state now reflects frame 1 having been processed. Second call
  // should decode the "next" frame — which is the same content.
  const f2 = dec.decodeFrame(doubled)

  // Both should clear 30 dB vs source; both should be essentially
  // identical to each other since the signal is stable and the PLL
  // has carried state.
  const psnr = (a, b, margin = 4) => {
    let s = 0, n = 0
    for (let y = 0; y < h * 2; y++) {
      for (let x = margin; x < w - margin; x++) {
        for (let c = 0; c < 3; c++) {
          const o = (y * w + x) * 3 + c
          const d = a[o] - b[o]
          s += d * d; n++
        }
      }
    }
    return s === 0 ? Infinity : 10 * Math.log10(1 / (s / n))
  }
  assert.ok(psnr(src, f1) > 30, `frame 1 PSNR ${psnr(src, f1).toFixed(2)} dB`)
  assert.ok(psnr(src, f2) > 30, `frame 2 PSNR ${psnr(src, f2).toFixed(2)} dB`)
  assert.ok(psnr(f1, f2) > 40, `frame1-vs-frame2 PSNR ${psnr(f1, f2).toFixed(2)} dB (should be ~identical)`)
})

test('reset() returns the decoder to cold-lock behaviour', () => {
  const w = 32, h = 32
  const src = progressive(colourBars75(w, h), w, h)
  const { samples } = encodeFrame(src, w, h * 2)

  const dec = new PalDecoder({ mode: 'pald', width: w, height: h * 2 })
  dec.decodeFrame(samples)
  // After decoding once, both field PLLs are initialised.
  assert.ok(dec.pllField1 !== null)
  assert.ok(dec.pllField2 !== null)
  dec.reset()
  assert.equal(dec.pllField1, null)
  assert.equal(dec.pllField2, null)
  const rgb = dec.decodeFrame(samples)
  assert.equal(rgb.length, w * h * 2 * 3)
})
