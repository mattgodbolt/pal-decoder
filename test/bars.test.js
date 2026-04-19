import test from 'node:test'
import assert from 'node:assert/strict'

import { colourBars75 } from '../src/fixtures/bars.js'

test('colour bars have expected shape and range', () => {
  const w = 720, h = 8
  const img = colourBars75(w, h)
  assert.equal(img.length, w * h * 3)
  for (let i = 0; i < img.length; i++) {
    assert.ok(img[i] >= 0 && img[i] <= 1)
  }
})

test('every row has the same 8-bar pattern', () => {
  const w = 80, h = 4 // 10 px per bar, four identical rows
  const img = colourBars75(w, h)
  const row0 = img.slice(0, w * 3)
  for (let y = 1; y < h; y++) {
    const row = img.slice(y * w * 3, (y + 1) * w * 3)
    for (let i = 0; i < row.length; i++) {
      assert.equal(row[i], row0[i])
    }
  }
})

test('bar colours appear in the expected order', () => {
  const w = 8, h = 1 // one pixel per bar
  const img = colourBars75(w, h)
  const px = (x) => [img[x * 3], img[x * 3 + 1], img[x * 3 + 2]]
  assert.deepEqual(px(0), [0.75, 0.75, 0.75]) // white
  assert.deepEqual(px(1), [0.75, 0.75, 0.00]) // yellow
  assert.deepEqual(px(2), [0.00, 0.75, 0.75]) // cyan
  assert.deepEqual(px(3), [0.00, 0.75, 0.00]) // green
  assert.deepEqual(px(4), [0.75, 0.00, 0.75]) // magenta
  assert.deepEqual(px(5), [0.75, 0.00, 0.00]) // red
  assert.deepEqual(px(6), [0.00, 0.00, 0.75]) // blue
  assert.deepEqual(px(7), [0.00, 0.00, 0.00]) // black
})
