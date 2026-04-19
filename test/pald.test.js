// PAL-D acceptance: a chroma-phase error that is invisible to the
// burst (so the decoder can't correct it) should produce visible
// Hanover bars on the PAL-S (notch) decoder and be substantially
// suppressed by the PAL-D (delay-line) decoder.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame } from '../src/encoder.js'
import { decodeComposite } from '../src/pipeline.js'
import { colourBars75 } from '../src/fixtures/bars.js'

function solidColour(w, h, r, g, b) {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

// Variance of any one channel across rows at a fixed column — high when
// Hanover bars are visible, low when chroma is vertically consistent.
function verticalRowVariance(rgb, width, height, x, c) {
  const col = []
  for (let y = 0; y < height; y++) col.push(rgb[(y * width + x) * 3 + c])
  const mean = col.reduce((a, b) => a + b, 0) / col.length
  return col.reduce((s, v) => s + (v - mean) ** 2, 0) / col.length
}

test('PAL-D suppresses Hanover bars vs PAL-S under chroma phase error', () => {
  // Flat red field — any line-to-line chroma variation is the phase
  // error showing up as Hanover bars.
  const w = 64, h = 64
  const src = solidColour(w, h, 0.75, 0, 0)

  // ~30° phase error, far bigger than real PAL hardware would show, to
  // make the test unambiguous.
  const phaseError = 30 * Math.PI / 180
  const { samples } = encodeFrame(src, w, h, { chromaPhaseError: phaseError })

  const palS = decodeComposite(samples, w, h, { mode: 'notch' })
  const palD = decodeComposite(samples, w, h, { mode: 'pald'  })

  // Look at the middle column, green channel (red field has strong
  // U/V components; the phase error leaks into all channels). Compare
  // vertical variance: PAL-S should swing between lines, PAL-D should
  // be largely flat.
  const x = w >> 1
  let sVar = 0, dVar = 0
  for (let c = 0; c < 3; c++) {
    sVar += verticalRowVariance(palS, w, h, x, c)
    dVar += verticalRowVariance(palD, w, h, x, c)
  }
  // PAL-D's residual variance should be small in absolute terms and
  // much smaller than PAL-S's.
  assert.ok(sVar > 0.005, `PAL-S variance too low — no Hanover bars? ${sVar.toFixed(4)}`)
  assert.ok(dVar < sVar * 0.1,
    `PAL-D should cut Hanover-bar variance by >10×. sVar=${sVar.toFixed(4)} dVar=${dVar.toFixed(4)}`)
})

test('PAL-D round-trip (no phase error) still clears 30 dB on colour bars', () => {
  // Regression guard: adding the delay-line averaging shouldn't hurt a
  // clean round-trip.
  const w = 256, h = 64
  const src = colourBars75(w, h)
  const { samples } = encodeFrame(src, w, h)
  const out = decodeComposite(samples, w, h, { mode: 'pald' })

  let sumSq = 0, n = 0
  const margin = 4
  for (let y = 0; y < h; y++) {
    for (let x = margin; x < w - margin; x++) {
      for (let c = 0; c < 3; c++) {
        const o = (y * w + x) * 3 + c
        const d = src[o] - out[o]
        sumSq += d*d; n++
      }
    }
  }
  const psnr = sumSq === 0 ? Infinity : 10 * Math.log10(1 / (sumSq / n))
  assert.ok(psnr > 30, `PAL-D colour bars PSNR ${psnr.toFixed(2)} dB`)
})
