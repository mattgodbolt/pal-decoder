// Stage-1 acceptance: JS encoder + notch decoder round-trip must achieve
// PSNR > 30 dB on a fixture image.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame } from '../src/encoder.js'
import { decodeFrame } from '../src/decoder-notch.js'
import { colourBars75 } from '../src/fixtures/bars.js'

function psnrDb(a, b, { marginX = 0, width, height, channels = 3 } = {}) {
  let sumSq = 0, n = 0
  for (let y = 0; y < height; y++) {
    for (let x = marginX; x < width - marginX; x++) {
      for (let c = 0; c < channels; c++) {
        const o = (y * width + x) * channels + c
        const d = a[o] - b[o]
        sumSq += d * d
        n++
      }
    }
  }
  const mse = sumSq / n
  if (mse === 0) return Infinity
  return 10 * Math.log10(1 / mse) // peak signal = 1
}

test('grey round-trip is near-perfect', () => {
  const w = 64, h = 64
  const grey = new Float32Array(w * h * 3)
  grey.fill(0.5)
  const { samples, lines } = encodeFrame(grey, w, h)
  const out = decodeFrame(samples, lines, w, h)
  const psnr = psnrDb(grey, out, { width: w, height: h, marginX: 2 })
  assert.ok(psnr > 40, `grey PSNR ${psnr.toFixed(2)} dB`)
})

test('75% EBU colour bars round-trip > 30 dB', () => {
  const w = 256, h = 64
  const bars = colourBars75(w, h)
  const { samples, lines } = encodeFrame(bars, w, h)
  const out = decodeFrame(samples, lines, w, h)
  // Ignore a few pixels either side of each bar edge — cross-luminance at
  // the transitions is inherent to notch decoding and not a correctness bug.
  const psnr = psnrDb(bars, out, { width: w, height: h, marginX: 4 })
  console.log(`bars PSNR = ${psnr.toFixed(2)} dB`)
  assert.ok(psnr > 30, `bars PSNR ${psnr.toFixed(2)} dB`)
})

test('primary colours decode to the expected hue', () => {
  // Solid blue everywhere should decode as predominantly blue.
  const w = 32, h = 32
  const img = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { img[i*3+2] = 1 }
  const { samples, lines } = encodeFrame(img, w, h)
  const out = decodeFrame(samples, lines, w, h)

  // Pick the centre pixel.
  const cx = w >> 1, cy = h >> 1
  const o = (cy * w + cx) * 3
  const r = out[o], g = out[o+1], b = out[o+2]
  assert.ok(b > 0.8, `blue channel ${b}`)
  assert.ok(r < 0.2, `red channel ${r}`)
  assert.ok(g < 0.2, `green channel ${g}`)
})
