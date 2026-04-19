// Browser entry point. Pick a test pattern, encode, optionally degrade,
// decode, and render the result. Controls expose the signal path and
// "simulated CRT lock state" (vsync mis-lock, start-sample offset,
// decoder mode) so you can actually see the picture move when things
// are wrong.

import { encodeFrame, progressive } from './encoder.js'
import { decodeComposite } from './pipeline.js'
import { colourBars75 } from './fixtures/bars.js'
import { colourBarsEbu } from './fixtures/bars-ebu.js'
import { greyRamp } from './fixtures/ramp.js'
import { frequencySweep } from './fixtures/sweep.js'
import { int16ToFloat32 } from './hacktv.js'
import { bandlimit, addNoise, addRinging, addPhaseJitter, addTimingDrift } from './degrade.js'
import { floatRgbToImageData, psnrDb, psnrDbWithMargin } from './image.js'
import {
  ACTIVE_FIRST_LINE, ACTIVE_LINE_COUNT, LINE_SAMPLES, ACTIVE_START, ACTIVE_END,
} from './timing.js'
import { LINES_PER_FRAME, LEVEL_SYNC_TIP, LEVEL_BLANKING, LEVEL_WHITE } from './signal.js'

// Full interlaced PAL frame.
const W = 720, H = 576
const SAMPLES_PER_FRAME = LINES_PER_FRAME * LINE_SAMPLES

// Named source patterns we'll (re)build our encoder's input from.
const PATTERNS = {
  bars75:  () => progressive(colourBars75(W, H >> 1), W, H >> 1),
  barsEbu: () => progressive(colourBarsEbu(W, H >> 1), W, H >> 1),
  ramp:    () => progressive(greyRamp(W, H >> 1), W, H >> 1),
  sweep:   () => progressive(frequencySweep(W, H >> 1), W, H >> 1),
}

async function run() {
  const modeRadios     = document.getElementsByName('decode-mode')
  const sourceSelect   = document.getElementById('source-pattern')
  const waveRadios     = document.getElementsByName('wave-source')
  const phaseSlider    = document.getElementById('phase-error')
  const phaseLabel     = document.getElementById('phase-error-label')
  const bwSlider       = document.getElementById('bandwidth')
  const bwLabel        = document.getElementById('bandwidth-label')
  const noiseSlider    = document.getElementById('noise')
  const noiseLabel     = document.getElementById('noise-label')
  const ringSlider     = document.getElementById('ringing')
  const ringLabel      = document.getElementById('ringing-label')
  const jitterSlider   = document.getElementById('jitter')
  const jitterLabel    = document.getElementById('jitter-label')
  const driftSlider    = document.getElementById('drift')
  const driftLabel     = document.getElementById('drift-label')
  const startOffSlider = document.getElementById('start-offset')
  const startOffLabel  = document.getElementById('start-offset-label')
  const vsyncSlider    = document.getElementById('vsync-offset')
  const vsyncLabel     = document.getElementById('vsync-offset-label')
  const lineSlider     = document.getElementById('line')
  const lineLabel      = document.getElementById('line-label')

  const firstPictureLine = ACTIVE_FIRST_LINE + Math.floor((ACTIVE_LINE_COUNT - H) / 2)
  lineSlider.min = 1
  lineSlider.max = LINES_PER_FRAME
  lineSlider.value = firstPictureLine + Math.floor(H / 2)

  // HackTV fixture (if present).
  let hacktvSamples = null
  try {
    const resp = await fetch('fixtures/hacktv-bars.int16', { cache: 'no-store' })
    if (resp.ok) {
      hacktvSamples = int16ToFloat32(await resp.arrayBuffer())
      document.getElementById('hacktv-status').textContent =
        `loaded ${(hacktvSamples.length * 2 / 1024 / 1024).toFixed(2)} MB capture (${(hacktvSamples.length / SAMPLES_PER_FRAME).toFixed(1)} frames)`
    } else {
      document.getElementById('hacktv-status').textContent =
        'no fixture (run `make fixtures` to generate)'
    }
  } catch (e) {
    document.getElementById('hacktv-status').textContent = `fetch failed: ${e.message}`
  }

  const picked = (radios) => [...radios].find((r) => r.checked)?.value

  // Cache of last rendered own-encoded samples, for the waveform view.
  let ownSamples = null
  let currentSrc = null

  const render = () => {
    const mode       = picked(modeRadios)   ?? 'pald'
    const waveSource = picked(waveRadios)   ?? 'own'
    const patternKey = sourceSelect.value
    const phaseDeg   = Number(phaseSlider.value)
    const bwMhz      = Number(bwSlider.value)
    const noiseLvl   = Number(noiseSlider.value) / 1000
    const ringDb     = Number(ringSlider.value) / 10
    const jitterSmp  = Number(jitterSlider.value) / 100
    const driftSmp   = Number(driftSlider.value) / 10
    // start offset slider is 0..1000 → fraction of a full 625-line frame
    const startSample = Math.floor(Number(startOffSlider.value) / 1000 * SAMPLES_PER_FRAME)
    const vsyncLineOffset = Number(vsyncSlider.value)

    phaseLabel .textContent = `${phaseDeg}°`
    bwLabel    .textContent = bwMhz >= 18 ? 'off' : `${bwMhz} MHz`
    noiseLabel .textContent = noiseLvl === 0 ? 'off' : noiseLvl.toFixed(3)
    ringLabel  .textContent = ringDb === 0 ? 'off' : `${ringDb.toFixed(1)} dB`
    jitterLabel.textContent = jitterSmp === 0 ? 'off' : `${jitterSmp.toFixed(2)} smp`
    driftLabel .textContent = driftSmp === 0 ? 'off' : `±${driftSmp.toFixed(1)} smp`
    startOffLabel.textContent = startSample === 0 ? '0' :
      `${(startSample / SAMPLES_PER_FRAME).toFixed(2)} frames`
    vsyncLabel .textContent = vsyncLineOffset === 0 ? '0'
      : `${vsyncLineOffset > 0 ? '+' : ''}${vsyncLineOffset} lines`

    // Own path.
    const src = (PATTERNS[patternKey] ?? PATTERNS.bars75)()
    currentSrc = src
    const enc = encodeFrame(src, W, H, { chromaPhaseError: phaseDeg * Math.PI / 180 })
    let path = enc.samples
    if (bwMhz < 18) path = bandlimit(path, bwMhz * 1e6)
    if (ringDb > 0) path = addRinging(path, 4.43e6, 3, ringDb)
    if (driftSmp > 0) path = addTimingDrift(path, driftSmp)
    if (jitterSmp > 0) path = addPhaseJitter(path, jitterSmp)
    if (noiseLvl > 0) path = addNoise(path, noiseLvl)
    // Tile so the start-offset slider always has enough signal to decode
    // a full frame from (otherwise mid-frame offsets run off the end).
    ownSamples = tileForLength(path, startSample + 2 * SAMPLES_PER_FRAME)
    const ownDecoded = decodeComposite(ownSamples, W, H,
      { mode, startSample, vsyncLineOffset })
    renderPair('own-src', 'own-out', src, ownDecoded)
    document.getElementById('own-psnr-all').textContent =
      `${psnrDb(src, ownDecoded).toFixed(2)} dB`
    document.getElementById('own-psnr-body').textContent =
      `${psnrDbWithMargin(src, ownDecoded, W, H, 8).toFixed(2)} dB`

    // HackTV path.
    if (hacktvSamples) {
      const tiled = tileForLength(hacktvSamples, startSample + 2 * SAMPLES_PER_FRAME)
      const decoded = decodeComposite(tiled, W, H,
        { mode, startSample, vsyncLineOffset })
      renderPair(null, 'hacktv-out', null, decoded)
    }

    // Waveform.
    const waveSamples = waveSource === 'hacktv' && hacktvSamples ? hacktvSamples : ownSamples
    const n = Number(lineSlider.value)
    lineLabel.textContent = describeLine(n, firstPictureLine)
    drawWaveform(waveSamples, n)
  }

  render()
  for (const r of modeRadios) r.addEventListener('change', render)
  for (const r of waveRadios) r.addEventListener('change', render)
  sourceSelect  .addEventListener('change', render)
  phaseSlider   .addEventListener('input',  render)
  bwSlider      .addEventListener('input',  render)
  noiseSlider   .addEventListener('input',  render)
  ringSlider    .addEventListener('input',  render)
  jitterSlider  .addEventListener('input',  render)
  driftSlider   .addEventListener('input',  render)
  startOffSlider.addEventListener('input',  render)
  vsyncSlider   .addEventListener('input',  render)
  lineSlider    .addEventListener('input',  render)
}

/**
 * Return a Float32Array of at least `minLength` samples, by copying and
 * repeating `src`. If src is already long enough, returns it as-is.
 */
function tileForLength(src, minLength) {
  if (src.length >= minLength) return src
  const repeats = Math.ceil(minLength / src.length)
  const out = new Float32Array(src.length * repeats)
  for (let r = 0; r < repeats; r++) out.set(src, r * src.length)
  return out
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
