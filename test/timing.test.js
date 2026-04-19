import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LINE_SAMPLES, SYNC_START, SYNC_END, BURST_START, BURST_END,
  ACTIVE_START, ACTIVE_END, FRONT_PORCH_SAMPLES, SYNC_SAMPLES,
  BACK_PORCH_SAMPLES, BURST_SAMPLES, ACTIVE_SAMPLES,
  ACTIVE_LINE_COUNT,
} from '../src/timing.js'

test('line layout is contiguous and non-overlapping', () => {
  assert.equal(SYNC_START, FRONT_PORCH_SAMPLES)
  assert.equal(SYNC_END - SYNC_START, SYNC_SAMPLES)
  assert.equal(ACTIVE_START - SYNC_END, BACK_PORCH_SAMPLES)
  assert.equal(ACTIVE_END - ACTIVE_START, ACTIVE_SAMPLES)
  assert.equal(LINE_SAMPLES, ACTIVE_END)
})

test('burst falls entirely within the back porch', () => {
  assert.ok(BURST_START > SYNC_END, 'burst starts after sync')
  assert.ok(BURST_END <= ACTIVE_START, 'burst ends before active video')
  assert.equal(BURST_END - BURST_START, BURST_SAMPLES)
})

test('line is close to the canonical 64 µs (1135 samples at 4×Fsc)', () => {
  // Canonical PAL line is 64 µs ≈ 1135.006 samples at 4×Fsc. Our rounded
  // layout should land within a handful of samples of that.
  assert.ok(Math.abs(LINE_SAMPLES - 1135) <= 4, `line = ${LINE_SAMPLES}`)
})

test('active line count is 288 (field 1 only, progressive)', () => {
  assert.equal(ACTIVE_LINE_COUNT, 288)
})
