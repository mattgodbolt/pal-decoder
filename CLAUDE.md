# PAL Decoder

A WebGL-based PAL composite video decoder, intended for integration with
jsbeeb and Miracle (Sega Master System) emulators. Goal: recapture the
look of a 1980s consumer TV, not broadcast-grade decoding.

## Project conventions

- Single `Makefile` at the root builds/tests/serves everything.
- No npm dependencies unless we've explicitly agreed. Vanilla JS, vanilla
  Web APIs, WebGL 2. WASM is permitted for the sync/PLL hot path once
  we've measured and confirmed JS isn't fast enough.
- Prefer duplication over taking on a dependency for something we could
  write in 50 lines.
- Code style: standard JS, 2-space indent. No TypeScript. No bundler.
  `index.html` loads modules directly.
- Commits: imperative mood, <=72 char summary. Body only if the *why*
  isn't obvious from the diff. No tool trailers.

## Architectural agreements (don't relitigate without asking)

- Signal format: `Float32Array` of composite samples at 4×Fsc =
  17.734475 MHz. IRE-equivalent units, sync tip ~ -0.3, blanking 0,
  peak white ~ +0.7.
- Streaming, not frame-batched. Samples flow through a ring buffer from
  encoder → sync/PLL → decoder → phosphor buffer. Display rate is
  decoupled from signal rate via the phosphor buffer.
- PLLs (horizontal and vertical) run on the CPU in JS/WASM, not in
  shaders. They emit per-line metadata (start offset, burst phase,
  burst amplitude, field parity) consumed by the GPU stage.
- Decoder targets: PAL-S (notch) and PAL-D (delay line). Transform PAL
  is explicitly out of scope. Colour killer gated on burst amplitude.
- Phosphor buffer is full 625-line raster. Progressive modes land every
  "field" on the same lines (scanline gaps fall out naturally). Mode 7
  interlace lands odd/even fields on alternating lines.
- Reference decoder is pure JS. GLSL ports are tested against it.
- No browser in CI. Tests are `node --test` only. GLSL correctness is
  proven via the JS oracle.

## Acceptance criteria per stage

1. JS encoder + notch decoder: round-trip PSNR > 30 dB on a fixture
   image, colour reproducing visibly correctly.
2. CPU PLL: tracks ±0.1% line-rate drift without visible rolling;
   recovers lock within 10 lines of a sync glitch.
3. GLSL port of notch decoder: matches JS reference within 1 LSB on
   fixture signals. 50fps+ at 720×576 on a laptop.
4. PAL-D delay line: visible reduction in Hanover bars vs PAL-S on a
   synthetic phase-error fixture.
5. Degradation controls: noise, bandlimiting, ringing, phase jitter,
   timing drift. All wired to sliders, all demonstrable.
6. Custom element: `<pal-decoder>` consumes Float32Array samples via
   a method call, renders into a canvas it owns.
7. Integration: jsbeeb and Miracle can swap their current pseudo-decoder
   for this one with minimal changes to their output path.

## Test data

- Our own JS encoder is the authoritative reference. The notch decoder
  is tested against it for round-trip correctness.
- HackTV (`codeberg.org/fsphil/hacktv`) is a planned cross-check oracle
  once the encoder exists — same tool vhs-decode uses, so agreement is
  meaningful. Disagreement is a bug to investigate, not a reason to
  change the reference.
- HackTV output is 16-bit signed at 13.5 or 20.25 MHz; our internal
  rate is 4×Fsc (17.734475 MHz). Prefer running comparisons at HackTV's
  native rate rather than resampling, so the resampler isn't in the
  debugging loop for encoder correctness.
- Pin / document the hacktv commit we validate against (known baseband
  sync-level bug worth verifying).
- Real-world captures (vhs-decode Internet Archive samples) are for
  stage 5+ degradation testing only — idealised signals first.
- `make fixtures` may require hacktv installed; `make test` must not.

## Ask before

- Adding any dependency (runtime or dev).
- Changing the build system or adding tooling.
- Creating files outside the agreed layout.
- Restructuring the module boundaries.
- Changing the signal format, sample rate, or ring-buffer contract.

## Prior art we're drawing from (for reference, not to copy)

- ld-decode's PalColour (PAL-D reference)
- Andrew Steer's PALcolour (readable software impl)
- LMP88959's PAL-CRT (real-time structure)
- Jim Easterbrook's writeups (canonical explanation)
