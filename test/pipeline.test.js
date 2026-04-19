// Stage-2 acceptance: round-trip through the PLL-driven pipeline (no
// encoder-provided line metadata) must still clear the 30 dB PSNR bar.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame } from '../src/encoder.js'
import { decodeComposite, buildLineMetadata } from '../src/pipeline.js'
import { decodeFrame } from '../src/decoder-notch.js'
import { findSyncEdges } from '../src/sync.js'
import { trackLines } from '../src/pll.js'
import { colourBars75 } from '../src/fixtures/bars.js'
import { ACTIVE_FIRST_LINE } from '../src/timing.js'

function psnrDb(a, b, { width, height, marginX = 0 }) {
  let s = 0, n = 0
  for (let y = 0; y < height; y++) {
    for (let x = marginX; x < width - marginX; x++) {
      for (let c = 0; c < 3; c++) {
        const o = (y * width + x) * 3 + c
        const d = a[o] - b[o]; s += d*d; n++
      }
    }
  }
  return s === 0 ? Infinity : 10 * Math.log10(1 / (s / n))
}

test('end-to-end round-trip via PLL matches 30 dB target', () => {
  const w = 256, h = 64
  const src = colourBars75(w, h)
  const { samples } = encodeFrame(src, w, h)
  const out = decodeComposite(samples, w, h)
  const psnr = psnrDb(src, out, { width: w, height: h, marginX: 4 })
  assert.ok(psnr > 30, `PLL round-trip PSNR ${psnr.toFixed(2)} dB`)
})

test('buildLineMetadata recovers vSign matching the encoder', () => {
  const w = 32, h = 32
  const { samples, lines: truth } = encodeFrame(colourBars75(w, h), w, h)
  const edges = findSyncEdges(samples)
  const tracked = trackLines(edges, truth.length - 1)
  const recovered = buildLineMetadata(samples, tracked)

  // For active-region lines carrying a burst, vSign must match truth.
  let checked = 0
  for (let L = ACTIVE_FIRST_LINE; L < ACTIVE_FIRST_LINE + 100; L++) {
    if (truth[L] && recovered[L]) {
      assert.equal(recovered[L].vSign, truth[L].vSign, `line ${L}`)
      checked++
    }
  }
  assert.ok(checked > 10)
})

test('pipeline matches encoder-metadata decoding pixel-for-pixel (within tolerance)', () => {
  // If the PLL locks perfectly on a clean signal, the two decode paths
  // should produce near-identical images.
  const w = 64, h = 64
  const src = colourBars75(w, h)
  const { samples } = encodeFrame(src, w, h)
  const viaPipeline = decodeComposite(samples, w, h)

  // Re-decode with encoder metadata, for comparison.
  const { samples: s2, lines } = encodeFrame(src, w, h)
  const viaMetadata = decodeFrame(s2, lines, w, h)

  const psnr = psnrDb(viaPipeline, viaMetadata, { width: w, height: h })
  assert.ok(psnr > 40, `pipeline-vs-metadata PSNR ${psnr.toFixed(2)} dB`)
})
