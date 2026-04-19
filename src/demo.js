// Browser entry point. Encodes 75% colour bars through our own pipeline
// (round-trip check) AND decodes an external HackTV PAL baseband
// capture (cross-check against a third-party encoder). A decoder-mode
// toggle (PAL-S vs PAL-D) and a chroma phase-error slider let you see
// Hanover bars appear under PAL-S and disappear under PAL-D.

import { encodeFrame, progressive } from './encoder.js'
import { decodeComposite } from './pipeline.js'
import { colourBars75 } from './fixtures/bars.js'
import { int16ToFloat32 } from './hacktv.js'
import { floatRgbToImageData, psnrDb, psnrDbWithMargin } from './image.js'
import {
  ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT, LINE_SAMPLES, ACTIVE_START, ACTIVE_END,
} from './timing.js'
import { LINES_PER_FRAME, LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_WHITE } from './signal.js'

// Full interlaced PAL frame: 720 × 576. Progressive test material
// (our colour bars fixture at 288 rows) is pre-doubled so both fields
// carry the same content.
const W = 720, H = 576

async function run() {
  const src = progressive(colourBars75(W, H >> 1), W, H >> 1)

  const modeRadios   = document.getElementsByName('decode-mode')
  const sourceRadios = document.getElementsByName('wave-source')
  const phaseSlider  = document.getElementById('phase-error')
  const phaseLabel   = document.getElementById('phase-error-label')
  const lineSlider   = document.getElementById('line')
  const lineLabel    = document.getElementById('line-label')

  const firstPictureLine = ACTIVE_FIRST_LINE + Math.floor((ACTIVE_LINE_COUNT - H) / 2)
  lineSlider.min = 1
  lineSlider.max = LINES_PER_FRAME
  lineSlider.value = firstPictureLine + Math.floor(H / 2)

  // Pre-fetch hacktv fixture once (it doesn't depend on mode or phase).
  let hacktvSamples = null
  try {
    const resp = await fetch('fixtures/hacktv-bars.int16', { cache: 'no-store' })
    if (resp.ok) {
      hacktvSamples = int16ToFloat32(await resp.arrayBuffer())
      document.getElementById('hacktv-status').textContent =
        `decoded ${(hacktvSamples.length * 2 / 1024 / 1024).toFixed(2)} MB capture`
    } else {
      document.getElementById('hacktv-status').textContent =
        'no fixture (run `make fixtures` to generate)'
    }
  } catch (e) {
    document.getElementById('hacktv-status').textContent = `fetch failed: ${e.message}`
  }

  const picked = (radios) => [...radios].find((r) => r.checked)?.value

  // Holds the most recent "own" samples so the waveform view can show them.
  let ownSamples = null

  const render = () => {
    const mode       = picked(modeRadios)   ?? 'pald'
    const phaseDeg   = Number(phaseSlider.value)
    const waveSource = picked(sourceRadios) ?? 'own'

    phaseLabel.textContent = `${phaseDeg}°`

    // Own encoder -> decoder.
    const enc = encodeFrame(src, W, H, { chromaPhaseError: phaseDeg * Math.PI / 180 })
    ownSamples = enc.samples
    const ownDecoded = decodeComposite(ownSamples, W, H, { mode })
    renderPair('own-src', 'own-out', src, ownDecoded)
    document.getElementById('own-psnr-all').textContent =
      `${psnrDb(src, ownDecoded).toFixed(2)} dB`
    document.getElementById('own-psnr-body').textContent =
      `${psnrDbWithMargin(src, ownDecoded, W, H, 8).toFixed(2)} dB`

    // HackTV (if available) — re-decodes when mode changes; phase slider
    // doesn't affect it (the capture is already fixed).
    if (hacktvSamples) {
      const decoded = decodeComposite(hacktvSamples, W, H, { mode })
      renderPair(null, 'hacktv-out', null, decoded)
    }

    // Waveform.
    const samples = waveSource === 'hacktv' && hacktvSamples ? hacktvSamples : ownSamples
    const n = Number(lineSlider.value)
    lineLabel.textContent = describeLine(n, firstPictureLine)
    drawWaveform(samples, n)
  }

  render()
  for (const r of modeRadios)   r.addEventListener('change', render)
  for (const r of sourceRadios) r.addEventListener('change', render)
  phaseSlider.addEventListener('input', render)
  lineSlider .addEventListener('input', render)
}

function renderPair(srcId, outId, src, decoded) {
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
