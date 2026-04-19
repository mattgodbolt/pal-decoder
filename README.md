# pal-decoder

A WebGL-based PAL composite video decoder, with a pure-JS reference
implementation that comes first and stays authoritative. Target: the
look and warts of a 1980s consumer CRT fed by jsbeeb (BBC Micro) and
Miracle (Sega Master System), not broadcast-grade decoding.

## What's in the box

Streaming pipeline, sync-locked, burst-locked, built up in stages:

```
  encoder  →  composite samples at 4×Fsc  →  sync detection
                                             → horizontal PLL
                                             → vertical sync
                                             → per-line burst phase lock
                                             → PAL-S or PAL-D decoder
                                             → RGB
```

The encoder emits a real PAL-spec signal (continuous subcarrier,
broad-pulse VBI on both fields, proper 50 Hz vertical structure). The
decoder consumes the same signal shape a real PAL decoder would, and
has been cross-checked against [HackTV](https://codeberg.org/fsphil/hacktv)'s
output — no caller hints, no magic parameters.

## Quick start

```sh
make test                  # Node's built-in test runner, all files
make serve                 # Zero-dep Node static server, http://localhost:8080/
make fixtures              # HackTV-generated baseband capture (requires `hacktv`)
```

The browser demo round-trips a 75% colour bars fixture through the
encoder and pipeline, and — if `make fixtures` has been run — decodes
an independent HackTV capture alongside. Toggles for PAL-S vs PAL-D
and a chroma phase-error slider let you see Hanover bars appear and
disappear.

## Conventions

- Signal format: `Float32Array` of composite samples at 4×Fsc
  (17,734,475 Hz). Units are IRE-equivalent floats: sync tip = −0.3,
  blanking = 0, peak white = +0.7.
- Line timing is rounded to 1135 samples/line (real PAL is 1135.0064);
  HackTV at 4×Fsc rounds identically, so this is interop-compatible.
- Each field carries 288 active picture rows; an interlaced frame is
  576 rows, with even rows from field 1 and odd from field 2.
  Progressive material passes the same content in both fields — use
  the `progressive(rgb, w, h)` helper.
- The PAL switch state σ per line is derived purely from burst phase
  alternation. Convention: first burst-bearing line in the signal is
  "+V of field 1". Without vertical sync this is a fixable ambiguity;
  with it, it's pinned by the broad-pulse pattern.

## Stage roadmap

| Stage | What | Status |
|---|---|---|
| 1 | JS encoder + PAL-S notch decoder, round-trip > 30 dB | ✅ |
| 2 | CPU PLL (horizontal + vertical), burst-locked chroma | ✅ |
| 3 | GLSL port of the notch decoder, tested against the JS oracle | pending |
| 4 | PAL-D delay-line decoder, Hanover-bar cancellation | ✅ |
| 5 | Degradation controls: noise, bandlimit, ringing, jitter, drift | in progress (noise + bandlimit) |
| 6 | `<pal-decoder>` custom element | pending |
| 7 | jsbeeb / Miracle integration | pending |

## Layout

```
src/
  signal.js        sample-rate + IRE-level constants, luma↔IRE helpers
  timing.js        625/50 per-line layout in samples; field 1/2 ranges
  colorspace.js    Rec.601 RGB↔YUV (SD PAL)
  fixtures/
    bars.js        75% (SMPTE convention) colour bars
  encoder.js       RGB frame → composite samples + per-line metadata
  sync.js          findSyncEdges (narrow), broadSyncPulses (wide)
  pll.js           HorizontalPLL (PI loop filter), trackLines
  vsync.js         findLineOneSample: field-sync detection
  burst.js         measureBurst: U/V projection of colour burst
  decode-chroma.js shared per-line luma notch + demod
  decoder-notch.js PAL-S decoder
  decoder-pald.js  PAL-D decoder (same-field 1-H delay line)
  pipeline.js      decodeComposite: end-to-end, self-calibrating
  hacktv.js        int16 ↔ Float32 baseband conversion
  degrade.js       AWGN noise, band-limit FIR (more TBD)
  demo.js          browser entry point
test/              node --test, no external deps
tools/
  serve.js         zero-dep static server
  decode-hacktv.js CLI: HackTV capture → PPM
```

## References

- [ld-decode PalColour](https://github.com/happycube/ld-decode) — PAL-D
  reference; we've drawn on the architecture, not the code.
- [Andrew Steer's PALcolour](http://www.pembers.freeserve.co.uk/Radar-Receivers/PALcolour/)
  — readable software implementation.
- [LMP88959's PAL-CRT](https://github.com/LMP88959/PAL-Crt) — real-time
  structure, different choices from us.
- Jim Easterbrook's writeups — canonical explanations of PAL maths.
- ITU-R BT.470 — the 625/50 standard.

## Licence

MIT. See `LICENSE`.
