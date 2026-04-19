// Browser entry point for the stage-1 demo: encode 75% colour bars,
// decode with the notch decoder, and render both + one line's composite
// waveform.

import { encodeFrame } from './encoder.js'
import { decodeFrame } from './decoder-notch.js'
import { colourBars75 } from './fixtures/bars.js'
import { floatRgbToImageData, psnrDb, psnrDbWithMargin } from './image.js'
import {
  ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT, LINE_SAMPLES, ACTIVE_START, ACTIVE_END,
} from './timing.js'
import { LINES_PER_FRAME, LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_WHITE } from './signal.js'

// Canonical SD PAL active resolution.
const W = 720, H = 576

function run() {
  const src = colourBars75(W, H)
  const { samples, lines } = encodeFrame(src, W, H)
  const decoded = decodeFrame(samples, lines, W, H)
  const psnrAll = psnrDb(src, decoded)
  // Skip 8 px either side of each bar edge: cross-luminance at sharp colour
  // transitions is intrinsic to notch decoding, not a decoder bug.
  const psnrBody = psnrDbWithMargin(src, decoded, W, H, 8)

  const srcCanvas = document.getElementById('src')
  const outCanvas = document.getElementById('out')
  srcCanvas.width = W; srcCanvas.height = H
  outCanvas.width = W; outCanvas.height = H
  srcCanvas.getContext('2d').putImageData(floatRgbToImageData(src, W, H), 0, 0)
  outCanvas.getContext('2d').putImageData(floatRgbToImageData(decoded, W, H), 0, 0)

  document.getElementById('psnr-all').textContent = `${psnrAll.toFixed(2)} dB`
  document.getElementById('psnr-body').textContent = `${psnrBody.toFixed(2)} dB`

  // Default to the middle picture line; the encoder centres vertically.
  const firstPictureLine = ACTIVE_FIRST_LINE + Math.floor((ACTIVE_LINE_COUNT - H) / 2)
  const defaultLine = firstPictureLine + Math.floor(H / 2)

  const slider = document.getElementById('line')
  const label  = document.getElementById('line-label')
  slider.min = 1
  slider.max = LINES_PER_FRAME
  slider.value = defaultLine
  const render = () => {
    const n = Number(slider.value)
    label.textContent = describeLine(n, firstPictureLine)
    drawWaveform(samples, n)
  }
  slider.addEventListener('input', render)
  render()
}

function describeLine(n, firstPictureLine) {
  const region = (() => {
    if (n < ACTIVE_FIRST_LINE) return 'vertical blanking (pre)'
    if (n >= firstPictureLine && n < firstPictureLine + H) return `picture row ${n - firstPictureLine}`
    if (n <= ACTIVE_FIRST_LINE - 1 + ACTIVE_LINE_COUNT) return 'active region (no picture)'
    return 'vertical blanking (post)'
  })()
  return `line ${n} — ${region}`
}

function drawWaveform(samples, line) {
  const canvas = document.getElementById('wave')
  const ctx = canvas.getContext('2d')
  const w = canvas.width, h = canvas.height
  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, w, h)

  const base = (line - 1) * LINE_SAMPLES
  const n = LINE_SAMPLES

  // Y axis: map [SYNC_TIP=-0.3 .. slightly above WHITE=0.7] -> [h-1 .. 0].
  const vMin = -0.5, vMax = 1.0
  const toY = (v) => Math.round((1 - (v - vMin) / (vMax - vMin)) * (h - 1))

  // Zero / white / sync grid lines.
  ctx.strokeStyle = '#333'
  ctx.beginPath()
  for (const v of [LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_WHITE]) {
    const y = toY(v)
    ctx.moveTo(0, y); ctx.lineTo(w, y)
  }
  ctx.stroke()

  // Highlight active-video region behind the trace.
  ctx.fillStyle = '#1a2b1a'
  ctx.fillRect((ACTIVE_START / n) * w, 0, ((ACTIVE_END - ACTIVE_START) / n) * w, h)

  // Waveform.
  ctx.strokeStyle = '#4f4'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = Math.round((i / n) * w)
    const y = toY(samples[base + i])
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Labels.
  ctx.fillStyle = '#aaa'
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillText('sync tip (-0.3)', 4, toY(LEVEL_SYNC_TIP) - 2)
  ctx.fillText('blanking (0)',    4, toY(LEVEL_BLANKING) - 2)
  ctx.fillText('white (+0.7)',    4, toY(LEVEL_WHITE) - 2)
}

run()
