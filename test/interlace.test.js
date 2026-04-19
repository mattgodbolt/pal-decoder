// Interlace tests: encoder places even output rows in field 1 and odd
// in field 2; decoder reassembles both fields into a 576-row frame.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrame, progressive } from '../src/encoder.js'
import { decodeFrame } from '../src/decoder-notch.js'
import { decodeComposite } from '../src/pipeline.js'
import { colourBars75 } from '../src/fixtures/bars.js'
import {
  FIELD1_ACTIVE_FIRST, FIELD2_ACTIVE_FIRST, FRAME_ACTIVE_ROWS, FIELD_ACTIVE_LINES,
} from '../src/timing.js'

function solid(w, h, r, g, b) {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { out[i*3] = r; out[i*3+1] = g; out[i*3+2] = b }
  return out
}

test('encoder places even rows in field 1 and odd rows in field 2', () => {
  // Red on even rows, blue on odd rows. The encoder's metadata marks
  // which line carries which image row.
  const w = 16, h = 576
  const img = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3
      if (y & 1) { img[o+2] = 0.5 } else { img[o] = 0.5 }
    }
  }
  const { lines } = encodeFrame(img, w, h)
  // Pick one active line from each field.
  const l1 = lines[FIELD1_ACTIVE_FIRST + 100]
  const l2 = lines[FIELD2_ACTIVE_FIRST + 100]
  assert.equal(l1?.field, 1, 'field-1 line should be tagged field 1')
  assert.equal(l2?.field, 2, 'field-2 line should be tagged field 2')
  assert.equal(l1?.imageRow & 1, 0, 'field-1 line should map to an even image row')
  assert.equal(l2?.imageRow & 1, 1, 'field-2 line should map to an odd image row')
})

test('progressive helper duplicates rows pairwise', () => {
  const src = solid(4, 3, 0.25, 0.5, 0.75)
  const out = progressive(src, 4, 3)
  assert.equal(out.length, 4 * 6 * 3)
  for (let y = 0; y < 3; y++) {
    for (let i = 0; i < 4 * 3; i++) {
      assert.equal(out[(y*2) * 4 * 3 + i], src[y * 4 * 3 + i], `row ${y*2}`)
      assert.equal(out[(y*2 + 1) * 4 * 3 + i], src[y * 4 * 3 + i], `row ${y*2+1}`)
    }
  }
})

test('progressive round-trip at full 576-row PAL resolution clears 30 dB', () => {
  const w = 256, h288 = 64
  const base = colourBars75(w, h288)
  const src = progressive(base, w, h288) // 128-row now
  // Push up to a realistic PAL frame size.
  const src576 = colourBars75(w, 288)
  const fullFrame = progressive(src576, w, 288) // 576 rows
  const { samples } = encodeFrame(fullFrame, w, 576)
  const out = decodeComposite(samples, w, 576)

  let sumSq = 0, n = 0
  const margin = 4
  for (let y = 0; y < 576; y++) {
    for (let x = margin; x < w - margin; x++) {
      for (let c = 0; c < 3; c++) {
        const o = (y * w + x) * 3 + c
        const d = fullFrame[o] - out[o]
        sumSq += d*d; n++
      }
    }
  }
  const psnr = sumSq === 0 ? Infinity : 10 * Math.log10(1 / (sumSq / n))
  assert.ok(psnr > 30, `576-row progressive PSNR ${psnr.toFixed(2)} dB`)
})

test('interlaced content: distinct even/odd rows survive round-trip', () => {
  // Even rows green, odd rows magenta — a test that a progressive
  // encoder can't fake.
  const w = 64, h = 576
  const img = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const [r, g, b] = (y & 1) ? [0.75, 0, 0.75] : [0, 0.75, 0]
    for (let x = 0; x < w; x++) {
      const o = (y*w + x) * 3
      img[o] = r; img[o+1] = g; img[o+2] = b
    }
  }
  const { samples } = encodeFrame(img, w, h)
  const out = decodeComposite(samples, w, h, { mode: 'pald' })

  // Centre pixel: row 287 should be green-ish, row 288 magenta-ish, etc.
  const pick = (y) => {
    const o = (y * w + (w>>1)) * 3
    return [out[o], out[o+1], out[o+2]]
  }
  const even = pick(200), odd = pick(201)
  assert.ok(even[1] > 0.5 && even[0] < 0.3, `even row should be green: ${even}`)
  assert.ok(odd[2]  > 0.5 && odd[1]  < 0.3, `odd  row should be magenta: ${odd}`)
})
