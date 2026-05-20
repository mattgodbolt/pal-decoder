// Multi-frame stability. The test signal is N frames emitted with
// subcarrier phase continuous across frame boundaries (encodeFrames),
// which is what a real broadcast looks like — subcarrier walks the
// 8-field supercycle, it does not restart at zero every frame.
// Earlier versions of this test tiled a single encoded frame with
// Float32Array.set(), which introduced a 3π/2 subcarrier-phase jump
// at every tile boundary. That is not a PAL signal; any decoder
// gymnastics needed to "cope" with it are solving an artefact.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { encodeFrames, progressive } from '../src/encoder.js'
import { colourBarsEbu } from '../src/fixtures/bars-ebu.js'
import { int16ToFloat32 } from '../src/hacktv.js'
import { PalDecoder } from '../src/pal-decoder.js'
import { FRAME_SAMPLES } from '../src/timing.js'

test('multi-frame decoding is stable across frames on our own encoder', () => {
  const w = 64, h = 576
  const src = progressive(colourBarsEbu(w, h >> 1), w, h >> 1)
  const N_FRAMES = 8
  const signal = encodeFrames(src, w, h, N_FRAMES)

  const dec = new PalDecoder({ mode: 'pald', width: w, height: h })
  const yellow = (100 * w + 10) * 3
  const samplesSeen = []
  for (let f = 0; f < N_FRAMES - 1; f++) {
    const rgb = dec.decodeFrame(signal)
    samplesSeen.push([rgb[yellow], rgb[yellow + 1], rgb[yellow + 2]])
  }
  // PAL-D's delay line needs one frame to warm up; compare from frame 2 on.
  const ref = samplesSeen[1]
  for (let f = 2; f < samplesSeen.length; f++) {
    const s = samplesSeen[f]
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(s[c] - ref[c]) < 0.02,
        `frame ${f + 1} channel ${c}: ${s[c].toFixed(3)} vs ref ${ref[c].toFixed(3)}`)
    }
  }
  assert.ok(ref[0] > 0.6 && ref[1] > 0.6 && ref[2] < 0.1,
    `reference frame should decode yellow, got ${ref.map((v) => v.toFixed(2))}`)
})

// Starting mid-frame: the first broad-pulse group seen is field 2 of
// whatever frame we sliced into the middle of, so the decoder paints
// even/odd lines swapped relative to our source image — the decoded
// colour at any given row shifts by one line. That's the real-TV
// behaviour too (tune in mid-frame, get a momentary geometric offset).
// What MUST hold: once the decoder has locked, successive frames
// decode identically. No alternation, no drift.
test('decoder stays locked once acquired, from any starting offset', () => {
  const w = 64, h = 576
  const src = progressive(colourBarsEbu(w, h >> 1), w, h >> 1)
  const N_FRAMES = 10
  const signal = encodeFrames(src, w, h, N_FRAMES)

  const yellowRow = 100
  const OFFSETS = [0, 0.13, 0.16, 0.25, 0.5, 0.7, 0.75, 0.9]
  for (const off of OFFSETS) {
    const offset = Math.round(off * FRAME_SAMPLES)
    const sliced = signal.subarray(offset)
    const dec = new PalDecoder({ mode: 'pald', width: w, height: h })

    // Sample a whole vertical slice, not just one pixel — if the
    // decoder is off by one line (field swap) we still find yellow
    // nearby. We want stability across frames, not specific row.
    const pickSwatch = (rgb) => {
      let s = [0, 0, 0]
      for (let dy = -2; dy <= 2; dy++) {
        const o = ((yellowRow + dy) * w + 10) * 3
        for (let c = 0; c < 3; c++) s[c] += rgb[o + c] / 5
      }
      return s
    }

    let settled = null
    for (let f = 0; f < 6; f++) {
      const rgb = dec.decodeFrame(sliced)
      if (f === 2) settled = pickSwatch(rgb)
      else if (f > 2) {
        const s = pickSwatch(rgb)
        for (let c = 0; c < 3; c++) {
          assert.ok(Math.abs(s[c] - settled[c]) < 0.02,
            `offset ${off} frame ${f} channel ${c}: ${s[c].toFixed(3)} vs settled ${settled[c].toFixed(3)}`)
        }
      }
    }
    assert.ok(settled[0] > 0.6 && settled[1] > 0.6 && settled[2] < 0.1,
      `offset ${off}: settled colour ${settled.map((v) => v.toFixed(2))} — expected yellow`)
  }
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
