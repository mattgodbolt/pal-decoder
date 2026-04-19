// Browser entry point. Encodes 75% colour bars through our own pipeline
// (round-trip check) AND decodes an external HackTV PAL baseband
// capture (cross-check against a third-party encoder), so we can eyeball
// both side by side. One composite line from each is rendered as a
// scrollable waveform.

import { encodeFrame } from './encoder.js'
import { decodeComposite } from './pipeline.js'
import { colourBars75 } from './fixtures/bars.js'
import { int16ToFloat32 } from './hacktv.js'
import { floatRgbToImageData, psnrDb, psnrDbWithMargin } from './image.js'
import {
  ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT, LINE_SAMPLES, ACTIVE_START, ACTIVE_END,
} from './timing.js'
import { LINES_PER_FRAME, LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_WHITE } from './signal.js'

// Stage-2 progressive is field-1-only: 288 lines.
const W = 720, H = 288

async function run() {
  const src = colourBars75(W, H)
  const { samples: ownSamples } = encodeFrame(src, W, H)
  const ownDecoded = decodeComposite(ownSamples, W, H)

  renderPair({
    srcId: 'own-src',
    outId: 'own-out',
    src, decoded: ownDecoded,
  })
  document.getElementById('own-psnr-all').textContent =
    `${psnrDb(src, ownDecoded).toFixed(2)} dB`
  document.getElementById('own-psnr-body').textContent =
    `${psnrDbWithMargin(src, ownDecoded, W, H, 8).toFixed(2)} dB`

  // HackTV fixture — a separate third-party encoder's idea of "PAL
  // 75% colour bars". Only fetch if the fixture is present; a 404 is
  // not fatal.
  let hacktvSamples = null
  try {
    const resp = await fetch('fixtures/hacktv-bars.int16', { cache: 'no-store' })
    if (resp.ok) {
      const ab = await resp.arrayBuffer()
      hacktvSamples = int16ToFloat32(ab)
      const decoded = decodeComposite(hacktvSamples, W, H)
      renderPair({
        srcId: null, outId: 'hacktv-out',
        src: null, decoded,
      })
      document.getElementById('hacktv-status').textContent =
        `decoded ${(ab.byteLength / 1024 / 1024).toFixed(2)} MB capture (${hacktvSamples.length} samples)`
    } else {
      document.getElementById('hacktv-status').textContent =
        `no fixture (run \`make fixtures\` to generate)`
    }
  } catch (e) {
    document.getElementById('hacktv-status').textContent = `fetch failed: ${e.message}`
  }

  // Waveform scrubber — shows our own encoder's signal, or hacktv's if
  // the radio button is flipped.
  const firstPictureLine = ACTIVE_FIRST_LINE + Math.floor((ACTIVE_LINE_COUNT - H) / 2)
  const defaultLine = firstPictureLine + Math.floor(H / 2)

  const slider = document.getElementById('line')
  const label  = document.getElementById('line-label')
  const sourceRadios = document.getElementsByName('wave-source')
  slider.min = 1
  slider.max = LINES_PER_FRAME
  slider.value = defaultLine

  const currentSamples = () => {
    const chosen = [...sourceRadios].find((r) => r.checked)?.value ?? 'own'
    return chosen === 'hacktv' && hacktvSamples ? hacktvSamples : ownSamples
  }
  const render = () => {
    const n = Number(slider.value)
    label.textContent = describeLine(n, firstPictureLine)
    drawWaveform(currentSamples(), n)
  }
  slider.addEventListener('input', render)
  for (const r of sourceRadios) r.addEventListener('change', render)
  render()
}

function renderPair({ srcId, outId, src, decoded }) {
  if (srcId && src) {
    const c = document.getElementById(srcId)
    c.width = W; c.height = H
    c.getContext('2d').putImageData(floatRgbToImageData(src, W, H), 0, 0)
  }
  if (outId && decoded) {
    const c = document.getElementById(outId)
    c.width = W; c.height = H
    c.getContext('2d').putImageData(floatRgbToImageData(decoded, W, H), 0, 0)
  }
}

function describeLine(n, firstPictureLine) {
  const region = (() => {
    if (n >= 1 && n <= 5)     return 'field-1 broad pulses (vertical sync)'
    if (n >= 313 && n <= 317) return 'field-2 broad pulses (vertical sync)'
    if (n < ACTIVE_FIRST_LINE) return 'upper blanking'
    if (n > ACTIVE_FIRST_LINE + ACTIVE_LINE_COUNT - 1 && n < 336) return 'mid-frame blanking'
    if (n >= 336 && n < 624) return 'field 2 active (not rendered at stage 2)'
    if (n >= firstPictureLine && n < firstPictureLine + H) return `picture row ${n - firstPictureLine}`
    if (n <= ACTIVE_FIRST_LINE - 1 + ACTIVE_LINE_COUNT) return 'field 1 active (no picture)'
    return 'trailer blanking'
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

  const vMin = -0.5, vMax = 1.0
  const toY = (v) => Math.round((1 - (v - vMin) / (vMax - vMin)) * (h - 1))

  ctx.strokeStyle = '#333'
  ctx.beginPath()
  for (const v of [LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_WHITE]) {
    const y = toY(v)
    ctx.moveTo(0, y); ctx.lineTo(w, y)
  }
  ctx.stroke()

  ctx.fillStyle = '#1a2b1a'
  ctx.fillRect((ACTIVE_START / n) * w, 0, ((ACTIVE_END - ACTIVE_START) / n) * w, h)

  ctx.strokeStyle = '#4f4'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const abs = base + i
    if (abs >= samples.length) break
    const x = Math.round((i / n) * w)
    const y = toY(samples[abs])
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.stroke()

  ctx.fillStyle = '#aaa'
  ctx.font = '11px system-ui, sans-serif'
  ctx.fillText('sync tip (-0.3)', 4, toY(LEVEL_SYNC_TIP) - 2)
  ctx.fillText('blanking (0)',    4, toY(LEVEL_BLANKING) - 2)
  ctx.fillText('white (+0.7)',    4, toY(LEVEL_WHITE) - 2)
}

run()
