import test from 'node:test'
import assert from 'node:assert/strict'

import {
  rgbToYuv, yuvToRgb, KR, KG, KB, U_MAX, V_MAX,
} from '../src/colorspace.js'

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

test('luma coefficients sum to 1', () => {
  assert.ok(close(KR + KG + KB, 1))
})

test('pure grey has zero chroma', () => {
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    const [y, u, v] = rgbToYuv(g, g, g)
    assert.ok(close(y, g))
    assert.ok(close(u, 0))
    assert.ok(close(v, 0))
  }
})

test('primaries hit their expected chroma extremes', () => {
  // Pure blue: U = +U_MAX; pure red: V = +V_MAX.
  const [, uBlue] = rgbToYuv(0, 0, 1)
  const [, , vRed] = rgbToYuv(1, 0, 0)
  assert.ok(close(uBlue, U_MAX, 1e-6))
  assert.ok(close(vRed, V_MAX, 1e-6))
})

test('RGB -> YUV -> RGB round-trip', () => {
  const samples = [
    [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [0.75, 0.75, 0], [0, 0.75, 0.75], [0.3, 0.6, 0.1],
  ]
  for (const [r, g, b] of samples) {
    const [y, u, v] = rgbToYuv(r, g, b)
    const [r2, g2, b2] = yuvToRgb(y, u, v)
    assert.ok(close(r, r2, 1e-9), `R ${r} -> ${r2}`)
    assert.ok(close(g, g2, 1e-9), `G ${g} -> ${g2}`)
    assert.ok(close(b, b2, 1e-9), `B ${b} -> ${b2}`)
  }
})
