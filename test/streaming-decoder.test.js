// Streaming-decoder tests — Phase A.
//
// The streaming decoder is a sample-by-sample state machine modelled on
// analogue TV signal-path hardware: free-running H-oscillator pulled
// by sync edges; subcarrier NCO pulled by burst; PAL ident bistable;
// framebuffer written as samples flow through.
//
// These tests prove the streaming decoder produces a correct picture
// on honest multi-frame signals — the same input the batch decoder is
// tested against.

import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeFrames, progressive } from '../src/encoder.js'
import { colourBars75 } from '../src/fixtures/bars.js'
import { colourBarsEbu } from '../src/fixtures/bars-ebu.js'
import { StreamingDecoder } from '../src/streaming-decoder.js'

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
  return 10 * Math.log10(1 / mse)
}

test('streaming decoder locks on a flat grey signal', () => {
  const w = 64, h = 64
  const src = progressive(fill(w, h >> 1, 0.5), w, h >> 1)
  const signal = encodeFrames(src, w, h, 4)

  const dec = new StreamingDecoder({ width: w, height: h })
  dec.push(signal)

  // Every pixel should be close to 0.5 on all channels.
  const psnr = psnrDb(src, dec.framebuffer, { width: w, height: h, marginX: 2 })
  assert.ok(psnr > 25, `grey PSNR ${psnr.toFixed(2)} dB`)
})

test('streaming decoder produces colour bars within reasonable PSNR', () => {
  const w = 256, h = 64
  const src = progressive(colourBars75(w, h >> 1), w, h >> 1)
  const signal = encodeFrames(src, w, h, 4)

  const dec = new StreamingDecoder({ width: w, height: h })
  dec.push(signal)

  const psnr = psnrDb(src, dec.framebuffer, { width: w, height: h, marginX: 6 })
  // PAL-S level (notch-style luma/chroma split) on a streaming chain:
  // cross-luma at sharp bar edges is inherent. Same ballpark as batch
  // PAL-S, which this test's batch equivalent clears at ~29 dB.
  assert.ok(psnr > 20, `colour-bars PSNR ${psnr.toFixed(2)} dB`)
})

test('streaming decoder output is stable across chunked pushes', () => {
  // The same signal, chunked two different ways, must produce the
  // same framebuffer. No dependence on buffer boundaries.
  const w = 64, h = 576
  const src = progressive(colourBarsEbu(w, h >> 1), w, h >> 1)
  const signal = encodeFrames(src, w, h, 3)

  const decA = new StreamingDecoder({ width: w, height: h })
  decA.push(signal)

  const decB = new StreamingDecoder({ width: w, height: h })
  // Push in three unequal chunks.
  const split1 = 12345, split2 = 987654
  decB.push(signal.subarray(0, split1))
  decB.push(signal.subarray(split1, split2))
  decB.push(signal.subarray(split2))

  let maxDiff = 0
  for (let i = 0; i < decA.framebuffer.length; i++) {
    const d = Math.abs(decA.framebuffer[i] - decB.framebuffer[i])
    if (d > maxDiff) maxDiff = d
  }
  assert.equal(maxDiff, 0, `chunk-independence broke: max diff ${maxDiff}`)
})

test('streaming decoder settles: later frames match earlier ones', () => {
  // Feed many frames; the framebuffer snapshot after the 2nd frame
  // should equal the snapshot after the Nth frame. (State carries
  // forward. Each successive frame redraws the same pixels.)
  const w = 64, h = 576
  const src = progressive(colourBarsEbu(w, h >> 1), w, h >> 1)
  const N = 6
  const signal = encodeFrames(src, w, h, N)

  const dec = new StreamingDecoder({ width: w, height: h })
  // Push two frames, snapshot the buffer.
  const FRAME = signal.length / N
  dec.push(signal.subarray(0, 2 * FRAME))
  const snap2 = new Float32Array(dec.framebuffer)
  // Push the rest.
  dec.push(signal.subarray(2 * FRAME))
  const snapN = dec.framebuffer

  let maxDiff = 0
  for (let i = 0; i < snap2.length; i++) {
    const d = Math.abs(snap2[i] - snapN[i])
    if (d > maxDiff) maxDiff = d
  }
  assert.ok(maxDiff < 0.05, `frame-to-frame drift: max diff ${maxDiff.toFixed(4)}`)
})

test('streaming decoder survives arbitrary mid-stream cut-in (issue #1)', () => {
  // Real SDR / ADC captures don't conveniently start on a frame
  // boundary. Cutting in mid-frame must still produce a correct
  // picture, including:
  //   - Field 1 vs field 2 disambiguation (half-line offset of the
  //     broad-pulse group, not "first group seen = field 1")
  //   - Subcarrier-grid alignment independent of where we cut
  //     (initial θ-offset ∈ {0, π/2, π, 3π/2}; the burst loop must
  //     converge from any of them)
  const w = 256, h = 64
  const src = progressive(colourBars75(w, h >> 1), w, h >> 1)
  const N = 6
  const signal = encodeFrames(src, w, h, N)
  const FRAME = signal.length / N

  // Cut into the middle of frame 1, with each of the 4 mod-4
  // subcarrier alignments. Skip one whole frame for V-sync to
  // acquire, then probe with extra sample offsets 0..3.
  for (let extra = 0; extra < 4; extra++) {
    const shift = FRAME + 12345 + extra
    const dec = new StreamingDecoder({ width: w, height: h })
    dec.push(signal.subarray(shift))
    const psnr = psnrDb(src, dec.framebuffer, { width: w, height: h, marginX: 6 })
    assert.ok(psnr > 18, `mid-stream cut-in shift=${shift} (mod4=${shift & 3}): PSNR ${psnr.toFixed(2)} dB`)
  }
})

function fill(w, h, v) {
  const out = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h * 3; i++) out[i] = v
  return out
}
