// Horizontal frequency sweep: white vertical lines whose spacing
// decreases left-to-right, so the instantaneous spatial frequency
// grows from `fMin` cycles/image-width on the left to `fMax` on the
// right. Monochrome (no chroma in the source at all).
//
// Purpose: there's no low-pass trap before our encoder's colour
// modulation, so any luma content near the chroma band (Fsc =
// 4.43 MHz) turns into fake chroma when the notch decoder tries to
// separate it again — "cross-colour". With 922 active samples at
// 4×Fsc ≈ 17.7 MHz, Fsc corresponds to about 231 cycles per image
// width. This sweep runs from wide bars to well above Fsc so you can
// watch cross-colour kick in somewhere on the right side of the image.

export function frequencySweep(width, height, fMin = 1, fMax = 350) {
  const out = new Float32Array(width * height * 3)
  for (let x = 0; x < width; x++) {
    // Linear frequency ramp in cycles/image-width. Integrate to get
    // instantaneous phase (also in cycles/image-width · x/width = cycles).
    const cyclesPhase =
      fMin * x / width +
      (fMax - fMin) * x * x / (2 * width * width)
    // Binary square wave: white lines with spacing determined by the
    // instantaneous frequency.
    const v = Math.cos(2 * Math.PI * cyclesPhase) > 0 ? 1 : 0
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 3
      out[i] = out[i + 1] = out[i + 2] = v
    }
  }
  return out
}
