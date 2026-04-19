// Real-PAL multi-frame stability test.
//
// With half-line-offset interlace (real PAL / HackTV), our decoder must
// lock once on field 1 and stay aligned across every subsequent frame.
// Earlier versions alternated between correct and wrong frames because
// frame-stepping at LINE_SAMPLES intervals got confused by the
// half-line field offset.
//
// Test uses our own encoder. If the encoder is proper real PAL and the
// decoder handles the half-line offset, every framesToSettle value
// produces the SAME decode (since the signal is stable across frames).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { encodeFrame, progressive } from '../src/encoder.js'
import { colourBarsEbu } from '../src/fixtures/bars-ebu.js'
import { int16ToFloat32 } from '../src/hacktv.js'
import { PalDecoder } from '../src/pal-decoder.js'

test('multi-frame decoding is stable across frames on our own encoder', () => {
  const w = 64, h = 576
  const src = progressive(colourBarsEbu(w, h >> 1), w, h >> 1)
  const { samples: one } = encodeFrame(src, w, h)
  // Tile to enough frames to exercise many decode steps.
  const N_FRAMES = 8
  const tiled = new Float32Array(one.length * N_FRAMES)
  for (let r = 0; r < N_FRAMES; r++) tiled.set(one, r * one.length)

  const dec = new PalDecoder({ mode: 'pald', width: w, height: h })
  // Decode N successive frames. Collect the samples of a known-colour
  // pixel (yellow bar, row 100, x=10 in bar 1 [EBU yellow = 191, 191, 0]).
  const yellow = (100 * w + 10) * 3
  const samplesSeen = []
  for (let f = 0; f < N_FRAMES - 1; f++) {
    const rgb = dec.decodeFrame(tiled)
    samplesSeen.push([rgb[yellow], rgb[yellow + 1], rgb[yellow + 2]])
  }
  // All samples should be essentially identical (tolerance for float
  // rounding + PAL-D delay line warm-up on the FIRST frame only).
  // Compare frame 2 onwards for stability.
  const ref = samplesSeen[1]
  for (let f = 2; f < samplesSeen.length; f++) {
    const s = samplesSeen[f]
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(s[c] - ref[c]) < 0.02,
        `frame ${f + 1} channel ${c}: ${s[c].toFixed(3)} vs ref ${ref[c].toFixed(3)}`)
    }
  }
  // And we should actually be decoding yellow, not some random colour.
  assert.ok(ref[0] > 0.6 && ref[1] > 0.6 && ref[2] < 0.1,
    `reference frame should decode yellow, got ${ref.map((v) => v.toFixed(2))}`)
})

test('multi-frame HackTV decoding is stable after acquisition (real PAL interlace)', { skip: !fs.existsSync('fixtures/hacktv-bars.int16') }, () => {
  const raw = int16ToFloat32(fs.readFileSync('fixtures/hacktv-bars.int16'))
  const N_FRAMES = 10
  const SAMPLES_PER_FRAME = 625 * 1135
  const needed = N_FRAMES * SAMPLES_PER_FRAME
  let tiled = raw
  if (raw.length < needed) {
    const repeats = Math.ceil(needed / raw.length)
    tiled = new Float32Array(raw.length * repeats)
    for (let r = 0; r < repeats; r++) tiled.set(raw, r * raw.length)
  }

  const W = 720, H = 576
  const dec = new PalDecoder({ mode: 'pald', width: W, height: H })
  const yellow = (40 * W + 120) * 3 // inside yellow bar
  const samplesSeen = []
  for (let f = 0; f < N_FRAMES - 1; f++) {
    const rgb = dec.decodeFrame(tiled)
    samplesSeen.push([rgb[yellow], rgb[yellow + 1], rgb[yellow + 2]])
  }
  // Allow the PLL a few frames to acquire on a capture that doesn't
  // start at an ideal alignment. From the first "settled" frame
  // onwards, output must not oscillate — that was the bug.
  const SETTLE_FRAMES = 3
  const ref = samplesSeen[SETTLE_FRAMES]
  for (let f = SETTLE_FRAMES + 1; f < samplesSeen.length; f++) {
    const s = samplesSeen[f]
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(s[c] - ref[c]) < 0.02,
        `hacktv frame ${f + 1} channel ${c}: ${s[c].toFixed(3)} vs ref ${ref[c].toFixed(3)} — ` +
        `alternation would suggest the half-line-interlace handling regressed`)
    }
  }
  // And the settled frame should actually be yellow (not some
  // accidental identical-but-wrong colour).
  assert.ok(ref[0] > 0.5 && ref[1] > 0.5 && ref[2] < 0.5,
    `should decode yellow after settling, got ${ref.map((v) => v.toFixed(2))}`)
})
