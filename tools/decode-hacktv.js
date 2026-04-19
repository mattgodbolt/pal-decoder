#!/usr/bin/env node
// Decode a HackTV baseband capture to a PPM image so we can eyeball
// whether our JS oracle makes sense of a signal produced by a
// third-party encoder.
//
// Usage:  node tools/decode-hacktv.js <in.int16> <out.ppm> [W H]
//
// HackTV produces at least one full frame plus partial neighbours, so
// we find the first 625 well-locked lines and decode those. The
// pipeline assumes the first detected sync edge belongs to line 1 of a
// 625-line frame; HackTV's first output sample isn't necessarily a
// frame boundary, so the first partial frame may show vertical offset.
// For colour-bars fixtures (every line identical) that's invisible.

import { readFileSync, writeFileSync } from 'node:fs'
import { int16ToFloat32 } from '../src/hacktv.js'
import { decodeComposite } from '../src/pipeline.js'

const [, , inPath, outPath, wArg, hArg] = process.argv
if (!inPath || !outPath) {
  console.error('usage: node tools/decode-hacktv.js <in.int16> <out.ppm> [W H]')
  process.exit(2)
}
const W = Number(wArg ?? 720)
const H = Number(hArg ?? 288) // stage-2 is field-1-only (576 is stage-4)

const raw = readFileSync(inPath)
console.error(`read ${raw.length} bytes (${raw.length / 2} int16 samples) from ${inPath}`)

const samples = int16ToFloat32(raw)
console.error(`decoding ${W}x${H} from first ~${((samples.length / 17734475) * 1000).toFixed(0)} ms`)

const rgb = decodeComposite(samples, W, H)

// Write binary PPM (P6) — 3 bytes per pixel, no alpha.
const header = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii')
const body = Buffer.alloc(W * H * 3)
for (let i = 0; i < W * H * 3; i++) {
  const v = rgb[i]
  body[i] = v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255)
}
writeFileSync(outPath, Buffer.concat([header, body]))
console.error(`wrote ${outPath}`)
