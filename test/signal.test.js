import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FSC_HZ, SAMPLE_RATE_HZ, LINE_RATE_HZ, LINES_PER_FRAME,
  SAMPLES_PER_LINE, SAMPLES_PER_LINE_NOMINAL,
  LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_BLACK, LEVEL_WHITE,
  lumaToIre, ireToLuma,
} from '../src/signal.js'

test('PAL subcarrier frequency', () => {
  assert.equal(FSC_HZ, 4_433_618.75)
})

test('sample rate is 4 × Fsc', () => {
  assert.equal(SAMPLE_RATE_HZ, 4 * FSC_HZ)
  assert.equal(SAMPLE_RATE_HZ, 17_734_475)
})

test('625/50 timing constants', () => {
  assert.equal(LINE_RATE_HZ, 15_625)
  assert.equal(LINES_PER_FRAME, 625)
})

test('samples-per-line matches the PAL 1135.0064… figure', () => {
  // Value is non-integer; verify it's close to the canonical figure.
  assert.ok(Math.abs(SAMPLES_PER_LINE - 1135.006_4) < 1e-3,
    `expected ~1135.0064, got ${SAMPLES_PER_LINE}`)
  assert.equal(SAMPLES_PER_LINE_NOMINAL, 1135)
})

test('IRE-equivalent levels', () => {
  assert.equal(LEVEL_SYNC_TIP, -0.3)
  assert.equal(LEVEL_BLANKING, 0)
  assert.equal(LEVEL_BLACK, 0)
  assert.equal(LEVEL_WHITE, 0.7)
})

test('lumaToIre / ireToLuma round-trip', () => {
  for (const y of [0, 0.25, 0.5, 0.75, 1]) {
    const s = lumaToIre(y)
    assert.ok(Math.abs(ireToLuma(s) - y) < 1e-12)
  }
  assert.equal(lumaToIre(0), LEVEL_BLACK)
  assert.equal(lumaToIre(1), LEVEL_WHITE)
})
