// Comb-filter acceptance: at vertical bar edges (Y identical on every
// row), the comb separator cancels cross-luminance dot crawl that
// notch + PAL-D leaves behind.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame, progressive } from '../src/encoder.js'
import { decodeComposite } from '../src/pipeline.js'
import { colourBars75 } from '../src/fixtures/bars.js'

function transitionVariance(rgb, width, height, xCols) {
  // Vertical RMS variance at each column listed, averaged.
  let total = 0
  for (const x of xCols) {
    for (let c = 0; c < 3; c++) {
      const col = []
      for (let y = 0; y < height; y++) col.push(rgb[(y * width + x) * 3 + c])
      const mean = col.reduce((a, b) => a + b, 0) / col.length
      let v = 0
      for (const s of col) v += (s - mean) ** 2
      total += v / col.length
    }
  }
  return total / xCols.length
}

test('comb mode reduces dot-crawl variance at bar transitions vs notch', () => {
  // Colour bars have sharp horizontal transitions at exact column
  // boundaries (w/8, 2w/8, ...). Rows within a bar should all be the
  // SAME colour; notch+PAL-D leaks cross-luminance at those columns so
  // rows differ; comb should largely remove this.
  const w = 720, h = 288
  const src = progressive(colourBars75(w, h), w, h)
  const { samples } = encodeFrame(src, w, 576)

  // Sample a handful of columns a couple of pixels inside each bar
  // boundary (where dot crawl lives).
  const cols = []
  for (let b = 1; b < 8; b++) cols.push(b * (w >> 3), b * (w >> 3) + 1)

  const notched = decodeComposite(samples, w, 576, { mode: 'notch' })
  const combed  = decodeComposite(samples, w, 576, { mode: 'comb' })

  const vN = transitionVariance(notched, w, 576, cols)
  const vC = transitionVariance(combed,  w, 576, cols)
  assert.ok(vN > 1e-3, `notch should have visible dot crawl (variance ${vN.toFixed(5)})`)
  assert.ok(vC < vN * 0.3,
    `comb should cut transition variance by >70% vs notch. vN=${vN.toFixed(5)} vC=${vC.toFixed(5)}`)
})

test('comb round-trip still clears 30 dB on colour bars body', () => {
  const w = 256, h = 64
  const src = colourBars75(w, h)
  const { samples } = encodeFrame(src, w, h)
  const out = decodeComposite(samples, w, h, { mode: 'comb' })

  let sumSq = 0, n = 0
  const margin = 8 // bar edges are inherently fuzzy under any decoder
  for (let y = 0; y < h; y++) {
    for (let x = margin; x < w - margin; x++) {
      for (let c = 0; c < 3; c++) {
        const o = (y * w + x) * 3 + c
        const d = src[o] - out[o]
        sumSq += d * d; n++
      }
    }
  }
  const psnr = sumSq === 0 ? Infinity : 10 * Math.log10(1 / (sumSq / n))
  assert.ok(psnr > 30, `comb colour bars body PSNR ${psnr.toFixed(2)} dB`)
})
